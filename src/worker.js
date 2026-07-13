// Cloudflare Worker for the LinkedIn-X scuttlebutt dashboard.
//
// Responsibilities:
//   - Serve the dashboard (static files via env.ASSETS)
//   - JSON API under /api/* backed by D1 (env.DB)
//   - Ingest endpoint the GitHub Action posts scraped people to
//
// Auth model (intentionally simple): write/ingest endpoints require
//   Authorization: Bearer <INGEST_TOKEN>
// Reads are open. The dashboard stores the token in the browser and sends it
// on edits.

import { researchCompany, hasSearchKey } from './research.js';

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

async function findExisting(env, person) {
  const company = normCompany(person.company);
  if (person.linkedin_url) {
    const row = await env.DB.prepare(
      'SELECT * FROM people WHERE company = ? AND linkedin_url = ? LIMIT 1'
    ).bind(company, person.linkedin_url).first();
    if (row) return row;
  }
  const row = await env.DB.prepare(
    'SELECT * FROM people WHERE company = ? AND lower(full_name) = lower(?) LIMIT 1'
  ).bind(company, person.full_name).first();
  return row || null;
}

async function upsertPerson(env, input) {
  if (!input.full_name || !input.company) {
    return { ok: false, reason: 'missing full_name or company' };
  }
  const now = new Date().toISOString();
  const company = normCompany(input.company);
  const existing = await findExisting(env, input);

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
    photo_url: input.photo_url ?? existing?.photo_url ?? null,
    source: input.source || existing?.source || 'search',
    source_detail: input.source_detail ?? existing?.source_detail ?? null,
    contacted: existing?.contacted || 'no',
    notes: existing?.notes ?? null,
  };
  merged.seniority = input.seniority || classifySeniority(merged.last_role || merged.current_role);
  merged.score = computeScore(merged);

  if (existing) {
    await env.DB.prepare(
      `UPDATE people SET full_name=?, company_label=?, relationship=?, last_role=?,
         seniority=?, current_employer=?, current_role=?, tenure_start=?, tenure_end=?,
         is_current=?, location=?, linkedin_url=?, photo_url=?, source=?, source_detail=?, score=?,
         updated_at=? WHERE id=?`
    ).bind(
      merged.full_name, merged.company_label, merged.relationship, merged.last_role,
      merged.seniority, merged.current_employer, merged.current_role, merged.tenure_start,
      merged.tenure_end, merged.is_current, merged.location, merged.linkedin_url, merged.photo_url,
      merged.source, merged.source_detail, merged.score, now, existing.id
    ).run();
    return { ok: true, id: existing.id, updated: true };
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO people (id, full_name, company, company_label, relationship, last_role,
       seniority, current_employer, current_role, tenure_start, tenure_end, is_current,
       location, linkedin_url, photo_url, source, source_detail, score, contacted, notes,
       created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, merged.full_name, merged.company, merged.company_label, merged.relationship,
    merged.last_role, merged.seniority, merged.current_employer, merged.current_role,
    merged.tenure_start, merged.tenure_end, merged.is_current, merged.location,
    merged.linkedin_url, merged.photo_url, merged.source, merged.source_detail, merged.score,
    merged.contacted, merged.notes, now, now
  ).run();
  return { ok: true, id, created: true };
}

// ---- Research jobs (run inside the Worker) -------------------------------

async function setSearch(env, id, status, found, message) {
  try {
    await env.DB.prepare(
      'UPDATE searches SET status=?, found=?, message=?, updated_at=? WHERE id=?'
    ).bind(status, found || 0, message || null, new Date().toISOString(), id).run();
  } catch { /* best effort */ }
}

// Research a company and store the senior ex-employees found. Updates the
// searches row so the dashboard can show progress / completion.
async function runResearchJob(env, id, company) {
  try {
    const people = await researchCompany(env, company);
    let created = 0, updated = 0;
    for (const p of people) {
      const r = await upsertPerson(env, p);
      if (r.ok && r.created) created++;
      else if (r.ok) updated++;
    }
    await setSearch(env, id, 'done', people.length,
      `${people.length} ex-employees (created ${created}, updated ${updated})`);
    return { people: people.length, created, updated };
  } catch (e) {
    await setSearch(env, id, 'error', 0, String((e && e.message) || e));
    return { error: String((e && e.message) || e) };
  }
}

// ---- Routing -------------------------------------------------------------

async function handleApi(request, env, url, ctx) {
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
    if (company) { where.push('company = ?'); binds.push(company); }
    if (relationship) { where.push('relationship = ?'); binds.push(relationship); }
    if (contacted) { where.push('contacted = ?'); binds.push(contacted); }
    if (minScore) { where.push('score >= ?'); binds.push(minScore); }
    if (q) {
      where.push('(lower(full_name) LIKE ? OR lower(last_role) LIKE ? OR lower(current_employer) LIKE ?)');
      binds.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const sql = `SELECT * FROM people ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY score DESC, full_name ASC LIMIT 1000`;
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    return json({ people: results });
  }

  // GET /api/stock-search?q=... -> proxy the muns stock search (keeps the token
  // server-side). Returns a flat list of { ticker, country, name, sector }.
  if (path === '/api/stock-search' && method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) return json({ results: [] });
    if (!env.MUNS_TOKEN) return json({ results: [], error: 'MUNS_TOKEN not configured' });
    try {
      const resp = await fetch('https://birdnest.muns.io/stock/search', {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${env.MUNS_TOKEN}`,
          'content-type': 'application/json',
          'accept': '*/*',
        },
        body: JSON.stringify({ query: q, user_index: 124 }),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data) return json({ results: [], error: `upstream ${resp.status}` });
      const r = (data && data.data && data.data.results) || {};
      const results = Object.entries(r).map(([ticker, v]) => ({
        ticker,
        country: Array.isArray(v) ? v[0] : null,
        name: Array.isArray(v) ? v[1] : ticker,
        sector: Array.isArray(v) ? v[2] : null,
      }));
      return json({ results });
    } catch (e) {
      return json({ results: [], error: String((e && e.message) || e) });
    }
  }

  // GET /api/companies -> distinct companies with counts
  if (path === '/api/companies' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT company, max(company_label) AS label, count(*) AS n FROM people GROUP BY company ORDER BY n DESC'
    ).all();
    return json({ companies: results });
  }

  // GET /api/export?company= -> CSV download
  if (path === '/api/export' && method === 'GET') {
    const company = normCompany(url.searchParams.get('company'));
    const sql = `SELECT * FROM people ${company ? 'WHERE company = ?' : ''} ORDER BY score DESC`;
    const stmt = company ? env.DB.prepare(sql).bind(company) : env.DB.prepare(sql);
    const { results } = await stmt.all();
    const cols = ['full_name', 'company_label', 'relationship', 'last_role', 'seniority',
      'current_employer', 'current_role', 'tenure_start', 'tenure_end', 'location',
      'linkedin_url', 'photo_url', 'score', 'contacted', 'notes', 'source', 'source_detail'];
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
      const r = await upsertPerson(env, item);
      if (!r.ok) skipped++;
      else if (r.created) created++;
      else updated++;
    }
    return json({ ok: true, created, updated, skipped });
  }

  // DELETE /api/people?company=X -> purge the auto-scraped rows for one company
  // (used to clean out wrongly-included current employees before a strict
  // ex-only re-scrape). Manually-added rows (source='manual') and anything the
  // user has touched (contacted, or with notes) are kept.
  if (path === '/api/people' && method === 'DELETE') {
    if (!requireAuth(request, env)) return json({ error: 'unauthorized' }, { status: 401 });
    const company = normCompany(url.searchParams.get('company'));
    if (!company) return json({ error: 'company required' }, { status: 400 });
    const res = await env.DB.prepare(
      `DELETE FROM people
         WHERE company = ?
           AND source != 'manual'
           AND (contacted IS NULL OR contacted = 0 OR contacted = '' OR contacted = 'no')
           AND (notes IS NULL OR notes = '')`
    ).bind(company).run();
    return json({ ok: true, deleted: (res.meta && res.meta.changes) || 0 });
  }

  // PATCH /api/people/:id -> update contacted/notes (and other editable fields)
  const m = path.match(/^\/api\/people\/([^/]+)$/);
  if (m && method === 'PATCH') {
    if (!requireAuth(request, env)) return json({ error: 'unauthorized' }, { status: 401 });
    const id = m[1];
    const body = await request.json();
    const editable = ['contacted', 'notes', 'last_role', 'current_employer', 'current_role',
      'tenure_start', 'tenure_end', 'relationship', 'linkedin_url', 'photo_url', 'location'];
    const sets = [], binds = [];
    for (const k of editable) {
      if (k in body) { sets.push(`${k} = ?`); binds.push(body[k]); }
    }
    if (!sets.length) return json({ error: 'no editable fields' }, { status: 400 });
    sets.push('updated_at = ?'); binds.push(new Date().toISOString());
    binds.push(id);
    await env.DB.prepare(`UPDATE people SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
    return json({ ok: true });
  }

  if (m && method === 'DELETE') {
    if (!requireAuth(request, env)) return json({ error: 'unauthorized' }, { status: 401 });
    await env.DB.prepare('DELETE FROM people WHERE id = ?').bind(m[1]).run();
    return json({ ok: true });
  }

  // POST /api/search -> research a company right here in the Worker. We log the
  // job, then (in the background) call the search API, keep only genuine senior
  // ex-employees, and upsert them — so the dashboard's analysis screen lands
  // with real data without depending on GitHub Actions.
  if (path === '/api/search' && method === 'POST') {
    if (!requireAuth(request, env)) return json({ error: 'unauthorized' }, { status: 401 });
    const { company } = await request.json();
    if (!company) return json({ error: 'company required' }, { status: 400 });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO searches (id, company, status, created_at, updated_at) VALUES (?,?,?,?,?)'
    ).bind(id, normCompany(company), hasSearchKey(env) ? 'running' : 'queued', now, now).run();

    if (!hasSearchKey(env)) {
      await setSearch(env, id, 'error', 0, 'No search API key configured (set SERPER_API_KEY).');
      return json({ ok: true, id, ran: false, error: 'no_search_key' });
    }
    // Run in the background so the request returns immediately; the dashboard
    // polls /api/searches + /api/people and reveals results when they land.
    const job = runResearchJob(env, id, company);
    if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
    return json({ ok: true, id, ran: true });
  }

  // GET /api/searches -> recent jobs
  if (path === '/api/searches' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM searches ORDER BY created_at DESC LIMIT 25'
    ).all();
    return json({ searches: results });
  }

  // PATCH /api/searches/:id -> the Action updates job status as it runs
  const sm = path.match(/^\/api\/searches\/([^/]+)$/);
  if (sm && method === 'PATCH') {
    if (!requireAuth(request, env)) return json({ error: 'unauthorized' }, { status: 401 });
    const body = await request.json();
    await env.DB.prepare(
      'UPDATE searches SET status=?, found=?, message=?, updated_at=? WHERE id=?'
    ).bind(body.status || 'done', body.found || 0, body.message || null, new Date().toISOString(), sm[1]).run();
    return json({ ok: true });
  }

  return json({ error: 'not found' }, { status: 404 });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url, ctx);
      } catch (err) {
        return json({ error: 'server_error', detail: String(err && err.message || err) }, { status: 500 });
      }
    }
    // Everything else is the static dashboard.
    return env.ASSETS.fetch(request);
  },

  // Daily cron (configured in wrangler.jsonc): re-research every company already
  // in the dashboard so newly-surfaced senior ex-employees are added
  // automatically. Runs entirely in the Worker — no GitHub Actions needed.
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      if (!hasSearchKey(env)) return;
      const names = new Map();
      try {
        const { results } = await env.DB.prepare(
          'SELECT company, company_label FROM people GROUP BY company'
        ).all();
        for (const r of (results || [])) names.set(r.company, r.company_label || r.company);
      } catch { /* nothing to refresh */ }
      for (const [company] of names) {
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        try {
          await env.DB.prepare(
            'INSERT INTO searches (id, company, status, created_at, updated_at) VALUES (?,?,?,?,?)'
          ).bind(id, company, 'running', now, now).run();
        } catch { /* ignore */ }
        await runResearchJob(env, id, company);
      }
    })());
  },
};
