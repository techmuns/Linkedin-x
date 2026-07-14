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

// ---- LinkedIn public photo resolver --------------------------------------
// Reads a person's PUBLIC profile preview image (og:image) — the very same
// photo LinkedIn serves to link-unfurlers (Slack/Twitter/WhatsApp). No login,
// no account risk. Results are edge-cached so we touch LinkedIn at most once
// per profile per week; profiles with no public photo return 404 so the
// dashboard falls back to the initials avatar.

function isLinkedInProfile(u) {
  try {
    const url = new URL(u);
    return /(^|\.)linkedin\.com$/.test(url.hostname) && url.pathname.includes('/in/');
  } catch { return false; }
}

function parseOgImage(html) {
  const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i);
  if (!m) return null;
  const url = m[1].replace(/&amp;/g, '&');
  // Only accept a real profile headshot — never the generic LinkedIn logo or a
  // background banner.
  return /media\.licdn\.com\/.*(profile-displayphoto|profile-framedphoto)/.test(url) ? url : null;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&#0?39;|&apos;|&#x27;/gi, "'")
    .replace(/&quot;|&#34;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&middot;|&#183;/gi, '·')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

function cleanExtractedCompany(s, targetCompany) {
  s = decodeEntities(s).trim().replace(/\s*[.,]+$/, '').trim();
  if (s.length < 2 || s.length > 60) return '';
  if (/^(ex\b|former|self\b|freelance|education|location|\d+\s+connection)/i.test(s)) return '';
  // It's an EX company if it matches the target company we're researching.
  if (targetCompany && s.toLowerCase() === String(targetCompany).toLowerCase()) return '';
  return s;
}

// Pull the person's CURRENT company out of the PUBLIC profile HTML — the same
// page we fetch for the photo. LinkedIn's og:description carries it in a stable
// SEO template:
//   "<headline> · <summary> · Experience: <Company> · Education: … · Location: …"
// We split on the middot and take the "Experience:" segment; JSON-LD worksFor is
// a fallback. Returns '' when not confidently found.
function extractEmployer(html, targetCompany) {
  const md = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i)
          || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:description["']/i);
  if (md) {
    const desc = decodeEntities(md[1]);
    const seg = desc.split(/\s*[·•|]\s*/).map(x => x.trim()).find(x => /^Experience:/i.test(x));
    if (seg) { const c = cleanExtractedCompany(seg.replace(/^Experience:\s*/i, ''), targetCompany); if (c) return c; }
  }
  const ld = html.match(/"worksFor"\s*:\s*\{[^}]*?"name"\s*:\s*"([^"]+)"/i);
  if (ld) { const c = cleanExtractedCompany(ld[1], targetCompany); if (c) return c; }
  return '';
}

// Total professional experience: earliest WORK start year from the profile's
// JSON-LD (LinkedIn's own structured data). We take startDates on company roles
// only (path /company/…), never education (/school/…), so it's real, not guessed.
// Returns a 4-digit year, or null when not confidently found.
function extractCareerStartYear(html) {
  const NOW = new Date().getFullYear();
  const years = [...html.matchAll(/company\/[^"]+","member":\{"@type":"OrganizationRole","startDate":(\d{4})/gi)]
    .map(m => parseInt(m[1], 10))
    .filter(y => y >= 1950 && y <= NOW);
  return years.length ? Math.min(...years) : null;
}

// Returns { ok:true, photo:<url|null> } on a real 200 (photo may be null when the
// profile genuinely has no public photo), or { ok:false } when LinkedIn blocked
// us (HTTP 999) or the request failed — so callers don't mistake a block for
// "no photo" and can retry later.
async function resolveLinkedInPhoto(linkedinUrl, targetCompany) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(linkedinUrl, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'accept': 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
      },
      signal: ctrl.signal,
    });
    if (!r.ok) return { ok: false, status: r.status };     // 999 = rate-limit block
    const html = await r.text();
    return { ok: true, photo: parseOgImage(html), employer: extractEmployer(html, targetCompany),
      careerStart: extractCareerStartYear(html) };
  } catch { return { ok: false, status: 0 }; }
  finally { clearTimeout(timer); }
}

// Optional reliable provider: when PROXYCURL_API_KEY is set we use Proxycurl
// (it reaches LinkedIn through its own infrastructure, so no IP blocks) instead
// of scraping. Same { ok, photo } contract.
async function fetchPhotoViaProxycurl(env, linkedinUrl) {
  try {
    const u = 'https://nubela.co/proxycurl/api/v2/linkedin?use_cache=if-present&fallback_to_cache=on-error&url=' + encodeURIComponent(linkedinUrl);
    const r = await fetch(u, { headers: { authorization: 'Bearer ' + env.PROXYCURL_API_KEY } });
    if (!r.ok) return { ok: false, status: r.status };
    const d = await r.json().catch(() => ({}));
    const exp = Array.isArray(d.experiences) ? (d.experiences.find(e => e && !e.ends_at) || d.experiences[0]) : null;
    // Earliest work start year across all experiences → career start.
    let careerStart = null;
    if (Array.isArray(d.experiences)) {
      const yrs = d.experiences.map(e => e && e.starts_at && e.starts_at.year).filter(y => y >= 1950);
      if (yrs.length) careerStart = Math.min(...yrs);
    }
    return { ok: true, photo: d.profile_pic_url || null, employer: (exp && exp.company) || null, careerStart };
  } catch { return { ok: false, status: 0 }; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fill each person's CURRENT COMPANY ("Now at") and TOTAL EXPERIENCE (career
// start year) from their public profile — LinkedIn's own Experience field
// (og:description) and JSON-LD job start dates. Deliberately SERIAL with a delay
// so we never burst LinkedIn (bursts get a 999 block). A field we checked but
// couldn't read gets a sentinel ('-' / 0) so we don't retry it forever. Small
// batches; call repeatedly for a big list.
async function enrichPhotos(env, { company, limit = 6 } = {}) {
  const need = "((current_employer IS NULL OR current_employer = '') OR career_start_year IS NULL)";
  const where = ['linkedin_url IS NOT NULL', "linkedin_url != ''", need];
  const binds = [];
  if (company) { where.push('company = ?'); binds.push(normCompany(company)); }
  const n = Math.min(Math.max(Number(limit) || 6, 1), 12);
  const { results } = await env.DB.prepare(
    `SELECT id, linkedin_url, company, current_employer, career_start_year FROM people WHERE ${where.join(' AND ')} ORDER BY score DESC LIMIT ?`
  ).bind(...binds, n).all();

  const useProxycurl = !!env.PROXYCURL_API_KEY;
  let employers = 0, experiences = 0, fails = 0;
  const now = new Date().toISOString();
  for (let i = 0; i < results.length; i++) {
    if (i) await sleep(1500);                       // pace requests
    const row = results[i];
    const res = useProxycurl
      ? await fetchPhotoViaProxycurl(env, row.linkedin_url)
      : await resolveLinkedInPhoto(row.linkedin_url, row.company);
    if (!res.ok) {                                  // blocked/failed — leave empty, retry next run
      if (++fails >= 2) break;                      // likely IP-blocked; stop early
      continue;
    }
    fails = 0;
    // Never clobber data we already had. '-'/0 = checked but nothing found, so
    // we don't re-fetch forever.
    const hadEmp = row.current_employer && row.current_employer !== '-';
    const empVal = hadEmp ? row.current_employer : (res.employer || '-');
    const hadCs = row.career_start_year != null;
    const csVal = hadCs ? row.career_start_year : (res.careerStart || 0);
    await env.DB.prepare('UPDATE people SET current_employer = ?, career_start_year = ?, updated_at = ? WHERE id = ?')
      .bind(empVal, csVal, now, row.id).run();
    if (!hadEmp && res.employer) employers++;
    if (!hadCs && res.careerStart) experiences++;
  }

  const rem = await env.DB.prepare(
    `SELECT count(*) AS n FROM people WHERE linkedin_url IS NOT NULL AND linkedin_url != ''
       AND ${need}${company ? ' AND company = ?' : ''}`
  ).bind(...(company ? [normCompany(company)] : [])).first();

  return { tried: results.length, employers, experiences, remaining: (rem && rem.n) || 0,
    blocked: fails >= 2, provider: useProxycurl ? 'proxycurl' : 'scrape' };
}

// ---- CSV / Google-Sheet import -------------------------------------------
// Fill "Now at" (current_employer) and "Exposure" (career_start_year) from a
// file the USER exports themselves — a ZoomInfo CSV, any spreadsheet, or a
// published Google Sheet. We never scrape and never touch their login; we just
// match rows to existing contacts (by LinkedIn URL, else name) and write those
// two columns. Header detection is flexible so a raw export usually works as-is.

function parseCSV(text) {
  const rows = []; let row = [], field = '', q = false;
  text = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// header (lowercased) -> our field. First matching column wins.
const IMPORT_ALIASES = {
  name: ['full name', 'full_name', 'name', 'contact name', 'contact full name', 'contact', 'person'],
  first: ['first name', 'first_name', 'firstname', 'given name'],
  last: ['last name', 'last_name', 'lastname', 'surname', 'family name'],
  linkedin: ['linkedin url', 'linkedin', 'linkedin profile', 'profile url', 'li url', 'linkedin_url'],
  now_at: ['now at', 'now_at', 'current employer', 'current company', 'company name', 'company', 'employer', 'organization', 'organisation'],
  years: ['years of experience', 'total experience', 'years experience', 'experience (years)', 'experience', 'years', 'yrs', 'exp'],
  start_year: ['career start year', 'career start', 'start year', 'working since', 'first job year', 'since'],
};
function pickCol(headers, aliases) {
  for (const a of aliases) { const i = headers.indexOf(a); if (i >= 0) return i; }
  return -1;
}
function normalizeImportRows(text) {
  const rows = parseCSV(text).filter(r => r.some(c => String(c).trim() !== ''));
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => String(h || '').trim().toLowerCase());
  const col = {};
  for (const k of Object.keys(IMPORT_ALIASES)) col[k] = pickCol(headers, IMPORT_ALIASES[k]);
  const val = (r, c) => (c >= 0 ? String(r[c] ?? '').trim() : '');
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    let name = val(r, col.name);
    if (!name && (col.first >= 0 || col.last >= 0)) name = (val(r, col.first) + ' ' + val(r, col.last)).trim();
    const rec = { name, linkedin: val(r, col.linkedin), now_at: val(r, col.now_at),
      years: val(r, col.years), start_year: val(r, col.start_year) };
    if (rec.name || rec.linkedin) out.push(rec);
  }
  return out;
}

function normNameKey(s) {
  return String(s || '').toLowerCase()
    .replace(/[®™©]/g, '')
    .replace(/\b(ca|cfa|cfp|cpa|cs|dr|mr|mrs|ms|phd|mba|frm|jr|sr)\b\.?/g, '')
    .replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function linkedInKey(u) {
  const m = String(u || '').match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  return m ? '/in/' + m[1].toLowerCase() : '';
}
function cleanImportEmployer(s) {
  s = String(s || '').trim().replace(/\s+/g, ' ');
  if (s.length < 2 || s.length > 80) return '';
  if (/^(n\/?a|none|null|-|—|unknown|self|freelance|unemployed)$/i.test(s)) return '';
  return s;
}
function importStartYear(rec) {
  const NOW = new Date().getFullYear();
  if (rec.start_year) { const y = parseInt(String(rec.start_year).replace(/[^\d]/g, ''), 10); if (y >= 1950 && y <= NOW) return y; }
  if (rec.years) { const n = parseInt(String(rec.years).replace(/[^\d]/g, ''), 10); if (n >= 0 && n <= 70) return NOW - n; }
  return null;
}

// Match normalized records to people and (unless dryRun) write Now At + Exposure.
async function matchAndApply(env, recs, dryRun) {
  const { results: people } = await env.DB.prepare(
    'SELECT id, full_name, linkedin_url, current_employer, career_start_year FROM people'
  ).all();
  const byLi = new Map(), byName = new Map();
  for (const p of people) {
    const lk = linkedInKey(p.linkedin_url);
    if (lk) { if (!byLi.has(lk)) byLi.set(lk, []); byLi.get(lk).push(p); }
    const nk = normNameKey(p.full_name);
    if (nk) { if (!byName.has(nk)) byName.set(nk, []); byName.get(nk).push(p); }
  }
  const updates = new Map();   // person id -> pending field changes
  const unmatched = [];
  let matchedRows = 0;
  for (const rec of recs) {
    let targets = [];
    const lk = linkedInKey(rec.linkedin);
    if (lk && byLi.has(lk)) targets = byLi.get(lk);
    else { const nk = normNameKey(rec.name); if (nk && byName.has(nk)) targets = byName.get(nk); }
    if (!targets.length) { unmatched.push(rec.name || rec.linkedin); continue; }
    matchedRows++;
    const emp = cleanImportEmployer(rec.now_at);
    const sy = importStartYear(rec);
    for (const p of targets) {
      const u = updates.get(p.id) || { person: p };
      if (emp) u.current_employer = emp;
      if (sy != null) u.career_start_year = sy;
      updates.set(p.id, u);
    }
  }
  const NOW = new Date().toISOString(), thisYear = new Date().getFullYear();
  let employers = 0, experiences = 0; const samples = [];
  for (const [id, u] of updates) {
    const sets = [], binds = [];
    if ('current_employer' in u) { employers++; sets.push('current_employer = ?'); binds.push(u.current_employer); }
    if ('career_start_year' in u) { experiences++; sets.push('career_start_year = ?'); binds.push(u.career_start_year); }
    if (!sets.length) continue;
    if (samples.length < 8) samples.push({ name: u.person.full_name,
      now_at: 'current_employer' in u ? u.current_employer : undefined,
      years: 'career_start_year' in u ? (thisYear - u.career_start_year) : undefined });
    if (!dryRun) {
      sets.push('updated_at = ?'); binds.push(NOW); binds.push(id);
      await env.DB.prepare(`UPDATE people SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
    }
  }
  return { rows: recs.length, matchedRows, updatedPeople: updates.size, employers, experiences,
    unmatched: unmatched.slice(0, 30), unmatchedCount: unmatched.length, samples, dryRun: !!dryRun };
}

// Turn any Google Sheets link the user pastes into a CSV endpoint we can fetch.
function sheetCsvUrl(u) {
  u = String(u || '').trim();
  let m = u.match(/\/spreadsheets\/d\/e\/([a-zA-Z0-9\-_]+)/);   // already-published link
  if (m) return `https://docs.google.com/spreadsheets/d/e/${m[1]}/pub?output=csv`;
  m = u.match(/\/spreadsheets\/d\/([a-zA-Z0-9\-_]+)/);          // normal edit/share link
  if (m) { const g = (u.match(/[#&?]gid=(\d+)/) || [])[1] || '0'; return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${g}`; }
  return u;                                                     // maybe already a direct CSV link
}
async function fetchSheetCsv(url) {
  try {
    const r = await fetch(url, { redirect: 'follow', headers: { accept: 'text/csv,*/*' } });
    if (!r.ok) return { ok: false, error: `sheet fetch failed (${r.status}) — set the sheet to “Anyone with the link · Viewer”.` };
    const text = await r.text();
    if (/^\s*<(?:!doctype|html)/i.test(text)) return { ok: false, error: 'got a Google login page, not data — set the sheet to “Anyone with the link · Viewer” (or File → Share → Publish to web → CSV).' };
    return { ok: true, text };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// ---- Routing -------------------------------------------------------------

// Make sure columns added after the original schema exist, so the app works
// even when the D1 migration wasn't run by hand (e.g. GUI-only deploys). Cheap:
// one guarded ALTER per isolate — a "duplicate column" error just means it's
// already there.
let schemaEnsured = false;
async function ensureSchema(env) {
  if (schemaEnsured) return;
  try { await env.DB.prepare('ALTER TABLE people ADD COLUMN photo_url TEXT').run(); } catch { /* already exists */ }
  try { await env.DB.prepare('ALTER TABLE people ADD COLUMN career_start_year INTEGER').run(); } catch { /* already exists */ }
  try { await env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)').run(); } catch { /* already exists */ }
  schemaEnsured = true;
}

async function getSetting(env, k) {
  try { const r = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(k).first(); return r ? r.value : null; }
  catch { return null; }
}
async function setSetting(env, k, v) {
  try {
    await env.DB.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).bind(k, v).run();
  } catch { /* best effort */ }
}

async function handleApi(request, env, url, ctx) {
  await ensureSchema(env);
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
      'tenure_start', 'tenure_end', 'relationship', 'linkedin_url', 'photo_url', 'location', 'career_start_year'];
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

  // POST /api/enrich-photos -> fetch public LinkedIn photos for people missing
  // one, a small paced batch at a time. Body: { company?, limit? }. Call
  // repeatedly until { remaining: 0 }.
  if (path === '/api/enrich-photos' && method === 'POST') {
    if (!requireAuth(request, env)) return json({ error: 'unauthorized' }, { status: 401 });
    const body = await request.json().catch(() => ({}));
    const r = await enrichPhotos(env, { company: body.company, limit: body.limit });
    return json({ ok: true, ...r });
  }

  // POST /api/import -> fill Now At + Exposure from a CSV/paste the user
  // supplies. Body: { csv?: string, rows?: [...], dryRun?: bool }. Matches to
  // existing contacts by LinkedIn URL, else name. dryRun returns a preview only.
  if (path === '/api/import' && method === 'POST') {
    if (!requireAuth(request, env)) return json({ error: 'unauthorized' }, { status: 401 });
    const body = await request.json().catch(() => ({}));
    let recs = [];
    if (typeof body.csv === 'string') recs = normalizeImportRows(body.csv);
    else if (Array.isArray(body.rows)) recs = body.rows.map(r => ({
      name: r.name || r.full_name || '', linkedin: r.linkedin || r.linkedin_url || '',
      now_at: r.now_at || r.current_employer || '', years: r.years || '', start_year: r.start_year || '' }));
    if (!recs.length) return json({ error: 'no rows found — the file needs a header row and at least one data row (columns like Name, Now At, Years).' }, { status: 400 });
    const r = await matchAndApply(env, recs, !!body.dryRun);
    return json({ ok: true, ...r });
  }

  // POST /api/sync-sheet -> read a published Google Sheet (as CSV) and import
  // it, saving the URL so the daily cron keeps it in sync. Body: { url, dryRun?,
  // clear? }.
  if (path === '/api/sync-sheet' && method === 'POST') {
    if (!requireAuth(request, env)) return json({ error: 'unauthorized' }, { status: 401 });
    const body = await request.json().catch(() => ({}));
    if (body.clear) { await setSetting(env, 'sheet_url', ''); return json({ ok: true, cleared: true }); }
    const raw = (body.url || '').trim();
    if (!raw) return json({ error: 'url required' }, { status: 400 });
    const res = await fetchSheetCsv(sheetCsvUrl(raw));
    if (!res.ok) return json({ error: res.error || 'could not read the sheet' }, { status: 400 });
    const recs = normalizeImportRows(res.text);
    if (!recs.length) return json({ error: 'the sheet has no readable rows — needs a header row with Name and a Now At / Company column.' }, { status: 400 });
    const r = await matchAndApply(env, recs, !!body.dryRun);
    if (!body.dryRun) await setSetting(env, 'sheet_url', raw);
    return json({ ok: true, savedUrl: body.dryRun ? undefined : raw, ...r });
  }

  // GET /api/settings -> non-secret settings the dashboard pre-fills (sheet URL).
  if (path === '/api/settings' && method === 'GET') {
    return json({ sheet_url: (await getSetting(env, 'sheet_url')) || '' });
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
      await ensureSchema(env);
      // Research (needs a search key): refresh each tracked company.
      if (hasSearchKey(env)) {
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
      }
      // Top up missing LinkedIn photos + companies, gently (no search key needed).
      try {
        for (let k = 0; k < 4; k++) {
          const r = await enrichPhotos(env, { limit: 8 });
          if (!r.tried || r.remaining === 0) break;
        }
      } catch { /* best effort */ }
      // If a Google Sheet is linked, re-sync it so manual top-ups flow in daily.
      try {
        const su = await getSetting(env, 'sheet_url');
        if (su) {
          const res = await fetchSheetCsv(sheetCsvUrl(su));
          if (res.ok) { const recs = normalizeImportRows(res.text); if (recs.length) await matchAndApply(env, recs, false); }
        }
      } catch { /* best effort */ }
    })());
  },
};
