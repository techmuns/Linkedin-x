// Cloudflare Worker for the LinkedIn-X scuttlebutt dashboard.
//
// Responsibilities:
//   - Serve the dashboard (static files via env.ASSETS)
//   - JSON API under /api/* backed by Neon Postgres (env.DATABASE_URL)
//   - Ingest endpoint the GitHub Action posts scraped people to
//
// Database: Neon serverless Postgres, reached over HTTP with the
// @neondatabase/serverless driver — no connection pooling or Node APIs needed,
// so it runs fine on Workers. Set the connection string as a Worker secret:
//   npx wrangler secret put DATABASE_URL
//
// Auth model (intentionally simple): write/ingest endpoints require
//   Authorization: Bearer <INGEST_TOKEN>
// Reads are open. The dashboard stores the token in the browser and sends it
// on edits.

import { neon } from '@neondatabase/serverless';

const SENIORITY_RANK = {
  founder: 100,
  clevel: 90,
  vp: 75,
  director: 62,
  head: 60,
  manager: 30,
  other: 10,
};

// Keyword -> seniority bucket. Order matters: first match wins.
const SENIORITY_RULES = [
  [/\b(founder|co[-\s]?founder|promoter|chairman|chairperson)\b/i, 'founder'],
  [/\b(ceo|cfo|coo|cto|cmo|cpo|chro|chief|managing director|\bmd\b|president)\b/i, 'clevel'],
  [/\b(evp|svp|\bvp\b|vice president)\b/i, 'vp'],
  [/\b(director|head of|\bhead\b|principal|general manager|\bgm\b|national manager)\b/i, 'director'],
  [/\b(senior manager|lead|manager)\b/i, 'manager'],
];

function classifySeniority(role) {
  if (!role) return 'other';
  for (const [re, bucket] of SENIORITY_RULES) {
    if (re.test(role)) return bucket;
  }
  return 'other';
}

function computeScore(p) {
  const seniority = p.seniority || classifySeniority(p.last_role || p.current_role);
  let score = SENIORITY_RANK[seniority] ?? 10;
  if (Number(p.is_current) === 0) score += 12;            // already left = high signal
  if (p.relationship === 'ex_employee') score += 10;
  if (p.relationship === 'franchise_partner') score += 6;
  if (p.tenure_end) score += 5;                            // we know when they left
  if (p.tenure_start) score += 3;
  if (p.linkedin_url) score += 4;                          // reachable
  return Math.min(score, 130);
}

function normCompany(s) {
  return (s || '').trim().toLowerCase();
}

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
    ...init,
  });
}

function requireAuth(request, env) {
  // If no token is configured, refuse all writes (fail closed).
  if (!env.INGEST_TOKEN) return false;
  const header = request.headers.get('authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  return token && token === env.INGEST_TOKEN;
}

// ---- Person upsert -------------------------------------------------------

async function findExisting(sql, person) {
  const company = normCompany(person.company);
  if (person.linkedin_url) {
    const rows = await sql.query(
      'SELECT * FROM people WHERE company = $1 AND linkedin_url = $2 LIMIT 1',
      [company, person.linkedin_url]
    );
    if (rows[0]) return rows[0];
  }
  const rows = await sql.query(
    'SELECT * FROM people WHERE company = $1 AND lower(full_name) = lower($2) LIMIT 1',
    [company, person.full_name]
  );
  return rows[0] || null;
}

async function upsertPerson(sql, input) {
  if (!input.full_name || !input.company) {
    return { ok: false, reason: 'missing full_name or company' };
  }
  const now = new Date().toISOString();
  const company = normCompany(input.company);
  const existing = await findExisting(sql, input);

  // Merge: incoming non-empty fields win, but never clobber the user's
  // contacted/notes once set.
  const merged = {
    full_name: input.full_name,
    company,
    company_label: input.company_label || input.company,
    relationship: input.relationship || existing?.relationship || 'ex_employee',
    last_role: input.last_role ?? existing?.last_role ?? null,
    current_employer: input.current_employer ?? existing?.current_employer ?? null,
    current_role: input.current_role ?? existing?.current_role ?? null,
    tenure_start: input.tenure_start ?? existing?.tenure_start ?? null,
    tenure_end: input.tenure_end ?? existing?.tenure_end ?? null,
    is_current: input.is_current != null ? (input.is_current ? 1 : 0) : (existing?.is_current ?? 0),
    location: input.location ?? existing?.location ?? null,
    linkedin_url: input.linkedin_url ?? existing?.linkedin_url ?? null,
    source: input.source || existing?.source || 'search',
    source_detail: input.source_detail ?? existing?.source_detail ?? null,
  };
  merged.seniority = input.seniority || classifySeniority(merged.last_role || merged.current_role);
  merged.score = computeScore(merged);

  if (existing) {
    await sql.query(
      `UPDATE people SET full_name=$1, company_label=$2, relationship=$3, last_role=$4,
         seniority=$5, current_employer=$6, "current_role"=$7, tenure_start=$8, tenure_end=$9,
         is_current=$10, location=$11, linkedin_url=$12, source=$13, source_detail=$14, score=$15,
         updated_at=$16 WHERE id=$17`,
      [merged.full_name, merged.company_label, merged.relationship, merged.last_role,
       merged.seniority, merged.current_employer, merged.current_role, merged.tenure_start,
       merged.tenure_end, merged.is_current, merged.location, merged.linkedin_url,
       merged.source, merged.source_detail, merged.score, now, existing.id]
    );
    return { ok: true, id: existing.id, updated: true };
  }

  const id = crypto.randomUUID();
  await sql.query(
    `INSERT INTO people (id, full_name, company, company_label, relationship, last_role,
       seniority, current_employer, "current_role", tenure_start, tenure_end, is_current,
       location, linkedin_url, source, source_detail, score, contacted, notes,
       created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [id, merged.full_name, merged.company, merged.company_label, merged.relationship,
     merged.last_role, merged.seniority, merged.current_employer, merged.current_role,
     merged.tenure_start, merged.tenure_end, merged.is_current, merged.location,
     merged.linkedin_url, merged.source, merged.source_detail, merged.score,
     'no', null, now, now]
  );
  return { ok: true, id, created: true };
}

// ---- Routing -------------------------------------------------------------

async function handleApi(request, env, url) {
  const sql = neon(env.DATABASE_URL);
  const path = url.pathname;
  const method = request.method;

  // GET /api/people  -> list, filterable
  if (path === '/api/people' && method === 'GET') {
    const company = normCompany(url.searchParams.get('company'));
    const relationship = url.searchParams.get('relationship');
    const contacted = url.searchParams.get('contacted');
    const minScore = Number(url.searchParams.get('minScore') || 0);
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();

    const where = [];
    const binds = [];
    let i = 1;
    if (company) { where.push(`company = $${i++}`); binds.push(company); }
    if (relationship) { where.push(`relationship = $${i++}`); binds.push(relationship); }
    if (contacted) { where.push(`contacted = $${i++}`); binds.push(contacted); }
    if (minScore) { where.push(`score >= $${i++}`); binds.push(minScore); }
    if (q) {
      where.push(`(lower(full_name) LIKE $${i} OR lower(last_role) LIKE $${i} OR lower(current_employer) LIKE $${i})`);
      binds.push(`%${q}%`); i++;
    }
    const sqlText = `SELECT * FROM people ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY score DESC, full_name ASC LIMIT 1000`;
    const results = await sql.query(sqlText, binds);
    return json({ people: results });
  }

  // GET /api/companies -> distinct companies with counts
  if (path === '/api/companies' && method === 'GET') {
    const results = await sql.query(
      'SELECT company, max(company_label) AS label, count(*)::int AS n FROM people GROUP BY company ORDER BY n DESC'
    );
    return json({ companies: results });
  }

  // GET /api/export?company= -> CSV download
  if (path === '/api/export' && method === 'GET') {
    const company = normCompany(url.searchParams.get('company'));
    const results = company
      ? await sql.query('SELECT * FROM people WHERE company = $1 ORDER BY score DESC', [company])
      : await sql.query('SELECT * FROM people ORDER BY score DESC');
    const cols = ['full_name', 'company_label', 'relationship', 'last_role', 'seniority',
      'current_employer', 'current_role', 'tenure_start', 'tenure_end', 'location',
      'linkedin_url', 'score', 'contacted', 'notes', 'source', 'source_detail'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [cols.join(','), ...results.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${company || 'people'}.csv"`,
      },
    });
  }

  // --- writes below require auth ---
  if (path === '/api/people' && method === 'POST') {
    if (!requireAuth(request, env)) return json({ error: 'unauthorized' }, { status: 401 });
    const body = await request.json();
    const items = Array.isArray(body) ? body : (body.people || [body]);
    let created = 0, updated = 0, skipped = 0;
    for (const item of items) {
      const r = await upsertPerson(sql, item);
      if (!r.ok) skipped++;
      else if (r.created) created++;
      else updated++;
    }
    return json({ ok: true, created, updated, skipped });
  }

  // PATCH /api/people/:id -> update contacted/notes (and other editable fields)
  const m = path.match(/^\/api\/people\/([^/]+)$/);
  if (m && method === 'PATCH') {
    if (!requireAuth(request, env)) return json({ error: 'unauthorized' }, { status: 401 });
    const id = m[1];
    const body = await request.json();
    const editable = ['contacted', 'notes', 'last_role', 'current_employer', 'current_role',
      'tenure_start', 'tenure_end', 'relationship', 'linkedin_url', 'location'];
    const sets = [], binds = [];
    let i = 1;
    for (const k of editable) {
      if (k in body) {
        const col = k === 'current_role' ? '"current_role"' : k;
        sets.push(`${col} = $${i++}`); binds.push(body[k]);
      }
    }
    if (!sets.length) return json({ error: 'no editable fields' }, { status: 400 });
    sets.push(`updated_at = $${i++}`); binds.push(new Date().toISOString());
    binds.push(id);
    await sql.query(`UPDATE people SET ${sets.join(', ')} WHERE id = $${i}`, binds);
    return json({ ok: true });
  }

  if (m && method === 'DELETE') {
    if (!requireAuth(request, env)) return json({ error: 'unauthorized' }, { status: 401 });
    await sql.query('DELETE FROM people WHERE id = $1', [m[1]]);
    return json({ ok: true });
  }

  // POST /api/search -> record intent to research a company. Actual scraping
  // runs in GitHub Actions; this just logs the job so the UI can show it and
  // (optionally) fires a repository_dispatch if a GitHub token is configured.
  if (path === '/api/search' && method === 'POST') {
    if (!requireAuth(request, env)) return json({ error: 'unauthorized' }, { status: 401 });
    const { company } = await request.json();
    if (!company) return json({ error: 'company required' }, { status: 400 });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await sql.query(
      'INSERT INTO searches (id, company, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5)',
      [id, normCompany(company), 'queued', now, now]
    );

    let dispatched = false;
    if (env.GH_TOKEN && env.GH_REPO) {
      try {
        const resp = await fetch(`https://api.github.com/repos/${env.GH_REPO}/dispatches`, {
          method: 'POST',
          headers: {
            'authorization': `Bearer ${env.GH_TOKEN}`,
            'accept': 'application/vnd.github+json',
            'user-agent': 'linkedin-x-worker',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ event_type: 'research', client_payload: { company, search_id: id } }),
        });
        dispatched = resp.ok;
      } catch (_) { /* best effort */ }
    }
    return json({ ok: true, id, dispatched });
  }

  // GET /api/searches -> recent jobs
  if (path === '/api/searches' && method === 'GET') {
    const results = await sql.query('SELECT * FROM searches ORDER BY created_at DESC LIMIT 25');
    return json({ searches: results });
  }

  // PATCH /api/searches/:id -> the Action updates job status as it runs
  const sm = path.match(/^\/api\/searches\/([^/]+)$/);
  if (sm && method === 'PATCH') {
    if (!requireAuth(request, env)) return json({ error: 'unauthorized' }, { status: 401 });
    const body = await request.json();
    await sql.query(
      'UPDATE searches SET status=$1, found=$2, message=$3, updated_at=$4 WHERE id=$5',
      [body.status || 'done', body.found || 0, body.message || null, new Date().toISOString(), sm[1]]
    );
    return json({ ok: true });
  }

  return json({ error: 'not found' }, { status: 404 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      if (!env.DATABASE_URL) {
        return json({ error: 'DATABASE_URL not configured. Run: wrangler secret put DATABASE_URL' }, { status: 500 });
      }
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return json({ error: 'server_error', detail: String(err && err.message || err) }, { status: 500 });
      }
    }
    // Everything else is the static dashboard.
    return env.ASSETS.fetch(request);
  },
};
