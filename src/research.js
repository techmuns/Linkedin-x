// In-Worker research engine.
//
// This is the SAME logic the GitHub Actions scraper uses (scraper/sources/
// search.mjs + scraper/lib/util.mjs), ported so the Cloudflare Worker can run
// it directly. That makes "search a company" reliable and instant: the Worker
// calls the search API, keeps only genuine senior EX-employees, and returns
// people ready to store — no GitHub Actions hand-off, no waiting on a cron.
//
// Needs a search API key in the Worker env: SERPER_API_KEY (preferred) or
// GOOGLE_API_KEY + GOOGLE_CSE_ID.

const SENIOR_KEYWORDS = [
  'founder', 'co-founder', 'cofounder', 'chairman', 'promoter',
  'ceo', 'cfo', 'coo', 'cto', 'cmo', 'cpo', 'chro', 'chief',
  'managing director', 'president', 'evp', 'svp', 'vp', 'vice president',
  'director', 'head of', 'head,', 'head ', 'principal', 'general manager',
  'national', 'senior manager',
];

function looksSenior(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return SENIOR_KEYWORDS.some(k => t.includes(k));
}

const SENIORITY_RULES = [
  [/\b(founder|co[-\s]?founder|promoter|chairman|chairperson)\b/i, 'founder'],
  [/\b(ceo|cfo|coo|cto|cmo|cpo|chro|chief|managing director|\bmd\b|president)\b/i, 'clevel'],
  [/\b(evp|svp|\bvp\b|vice president)\b/i, 'vp'],
  [/\b(director|head of|\bhead\b|principal|general manager|\bgm\b|national|regional)\b/i, 'director'],
  [/\b(senior manager|lead|manager)\b/i, 'manager'],
];

function seniorityOf(text) {
  if (!text) return 'other';
  for (const [re, bucket] of SENIORITY_RULES) if (re.test(text)) return bucket;
  return 'other';
}

function parseLinkedInTitle(title) {
  if (!title) return null;
  const t = title.replace(/\s*[|\-–]\s*LinkedIn.*$/i, '').trim();
  const parts = t.split(/\s+[-–|]\s+/);
  const name = (parts[0] || '').trim();
  const headline = parts.slice(1).join(' · ').trim();
  if (!name || name.length < 3 || name.split(/\s+/).length > 6) return null;
  if (!/[a-zA-Z]/.test(name)) return null;
  return { name, headline };
}

function cleanLinkedInUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!u.hostname.toLowerCase().endsWith('linkedin.com')) return null;
    const m = u.pathname.match(/\/in\/[^/]+/i);
    if (!m) return null;
    return 'https://www.linkedin.com' + m[0].replace(/\/$/, '');
  } catch { return null; }
}

function cleanEmployerName(raw) {
  if (!raw) return null;
  const s = raw.replace(/[.,]\s*$/, '').trim();
  const low = s.toLowerCase();
  if (s.length < 2) return null;
  if (/^(ex(\b|[-\s])|former|formerly|previously|past\b|self\b|freelance|open to|looking|seeking)/i.test(low)) return null;
  if (s.split(/\s+/).length >= 3 &&
      /\b(architect|architecting|manager|director|\bhead\b|officer|engineer|analyst|consultant|specialist|coordinator|associate|intern|professional|logistics|supply\s*chain|operations|marketing|strategy|transformation)\b/i.test(low)) return null;
  if (s.split(/\s+/).length > 6) return null;
  return s;
}

function employerFromHeadline(headline) {
  if (!headline) return null;
  const m = headline.match(/\bat\s+([A-Z][\w&.,'’\- ]{1,60})/);
  if (m) return cleanEmployerName(m[1]);
  const dot = headline.split('·').map(s => s.trim()).filter(Boolean);
  if (dot.length >= 2) return cleanEmployerName(dot[dot.length - 1]);
  return null;
}

const SENIOR_TERMS = '(Founder OR Chief OR CEO OR CFO OR CTO OR COO OR President OR VP OR "Vice President" OR Director OR Head OR "General Manager")';

function buildQueries(company, hint = '') {
  const h = hint ? ` ${hint}` : '';
  // Every query demands an explicit "ex / former / previously" next to the
  // company name, so we only get people who actually LEFT.
  return [
    `site:linkedin.com/in ("ex ${company}" OR "ex-${company}" OR "former ${company}" OR "formerly ${company}")${h} ${SENIOR_TERMS}`,
    `site:linkedin.com/in ("previously at ${company}" OR "ex ${company}" OR "former ${company}" OR "formerly ${company}")${h} (Founder OR "Co-Founder" OR CEO OR CFO OR CTO OR COO OR President OR "Vice President" OR Director OR Head)`,
  ];
}

// Current senior employees: the company is their PRESENT employer. We exclude the
// obvious "ex/former" phrasing so leavers don't come back through this path.
function buildCurrentQueries(company, hint = '') {
  const h = hint ? ` ${hint}` : '';
  return [
    `site:linkedin.com/in "at ${company}"${h} ${SENIOR_TERMS} -"ex ${company}" -"ex-${company}" -"former ${company}"`,
    `site:linkedin.com/in ("at ${company}" OR "@ ${company}")${h} (Founder OR CEO OR CFO OR CTO OR COO OR President OR "Vice President" OR Director OR "Head of" OR "General Manager") -"ex-${company}" -"former ${company}"`,
  ];
}

function cleanRole(s) {
  const cleaned = s.trim()
    .replace(/^(linkedin|profile|ex|ex-|former|formerly|previously|the|a|an|at)\b[\s-]*/gi, '')
    .replace(/^(linkedin|profile|ex|ex-|former|formerly|previously|the|a|an|at)\b[\s-]*/gi, '')
    .trim();
  return (cleaned || s.trim()).replace(/\b\w/g, c => c.toUpperCase());
}

function roleAtCompany(headline, blob, company) {
  const c = company.toLowerCase();
  const m = blob.match(new RegExp(`([a-z &/]+?)\\s+(?:at|@|,)\\s+${c}`, 'i'));
  if (m && looksSenior(m[1])) return cleanRole(m[1]);
  if (headline && looksSenior(headline)) return cleanRole(headline.split('·')[0]);
  return null;
}

// Decide whether a search result is a genuine senior EX-employee of `company`.
function classify(r, company) {
  const blob = `${r.title} ${r.snippet}`.toLowerCase();
  const c = company.toLowerCase();
  if (!blob.includes(c)) return null;

  const parsed = parseLinkedInTitle(r.title);
  if (!parsed) return null;

  // Drop surname matches ("Danny Bluestone").
  const nameLow = parsed.name.toLowerCase();
  const tokens = c.split(/\s+/).filter(t => t.length >= 5);
  if (nameLow.includes(c) || tokens.some(t => nameLow.includes(t))) return null;

  if (!(looksSenior(r.title) || looksSenior(r.snippet))) return null;

  const employer = employerFromHeadline(parsed.headline);
  if (employer && employer.toLowerCase().includes(c)) return null; // still there

  // Strict ex-only: "ex/former/previously" must sit right next to the company.
  const cEsc = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exSignal = new RegExp(
    `\\b(ex[-.\\s]+|former(ly)?[-.\\s]+|previously\\s+(at\\s+)?|retired\\s+from\\s+)${cEsc}\\b`
  ).test(blob);
  if (!exSignal) return null;

  const lastRole = roleAtCompany(parsed.headline, blob, company);
  let seniority = seniorityOf(lastRole || parsed.headline || '');
  if (seniority === 'other') {
    const broad = seniorityOf(`${r.title} ${r.snippet}`);
    seniority = (broad === 'founder' || broad === 'clevel') ? 'director' : broad;
  }

  return {
    full_name: parsed.name,
    company,
    last_role: lastRole,
    seniority,
    current_employer: employer || null,
    current_role: parsed.headline || null,
    is_current: 0,
    relationship: 'ex_employee',
    linkedin_url: cleanLinkedInUrl(r.url),
    source: 'search',
    source_detail: r.url,
  };
}

// Decide whether a search result is a genuine senior CURRENT employee of `company`.
// (The client also wants current juniors from ISB/IIM/IIT — that needs each
// profile's EDUCATION, which isn't reliably in a search snippet, so it's left for
// the profile-data step. Here we keep it to senior current staff.)
function classifyCurrent(r, company) {
  const blob = `${r.title} ${r.snippet}`.toLowerCase();
  const c = company.toLowerCase();
  if (!blob.includes(c)) return null;

  const parsed = parseLinkedInTitle(r.title);
  if (!parsed) return null;

  // Drop surname matches ("Danny Bluestone").
  const nameLow = parsed.name.toLowerCase();
  const tokens = c.split(/\s+/).filter(t => t.length >= 5);
  if (nameLow.includes(c) || tokens.some(t => nameLow.includes(t))) return null;

  // Must NOT read as an ex — reject any "ex/former/previously <company>".
  const cEsc = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`\\b(ex[-.\\s]+|former(ly)?[-.\\s]+|previously\\s+(at\\s+)?)${cEsc}\\b`).test(blob)) return null;

  // Senior only (education-based juniors need profile data we can't read here).
  if (!(looksSenior(r.title) || looksSenior(r.snippet))) return null;

  // Must currently work there: the company sits in their headline's employer slot.
  const headline = parsed.headline || '';
  const employer = employerFromHeadline(headline);
  const atCompany = (employer && employer.toLowerCase().includes(c))
    || new RegExp(`\\b(?:at|@)\\s+${cEsc}\\b`, 'i').test(headline)
    || new RegExp(`[·|,]\\s*${cEsc}\\b`, 'i').test(headline);
  if (!atCompany) return null;

  const role = roleAtCompany(headline, blob, company);
  const seniority = seniorityOf(role || headline);

  return {
    full_name: parsed.name,
    company,
    last_role: role,
    seniority: seniority === 'other' ? 'director' : seniority,
    current_employer: company,           // they are currently here
    current_role: headline || null,
    is_current: 1,
    relationship: 'current_employee',
    linkedin_url: cleanLinkedInUrl(r.url),
    source: 'search',
    source_detail: r.url,
  };
}

async function serperSearch(query, env, page = 1) {
  const r = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': env.SERPER_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ q: query, num: 10, page }),
  });
  if (!r.ok) throw new Error(`serper ${r.status}`);
  const data = await r.json();
  return (data.organic || []).map(it => ({
    title: it.title || '', url: it.link || '', snippet: it.snippet || '',
  }));
}

async function googleSearch(query, env, page = 1) {
  const u = new URL('https://www.googleapis.com/customsearch/v1');
  u.searchParams.set('key', env.GOOGLE_API_KEY);
  u.searchParams.set('cx', env.GOOGLE_CSE_ID);
  u.searchParams.set('num', '10');
  u.searchParams.set('start', String((page - 1) * 10 + 1));
  u.searchParams.set('q', query);
  const r = await fetch(u, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`google ${r.status}`);
  const data = await r.json();
  return (data.items || []).map(it => ({
    title: it.title || '', url: it.link || '', snippet: it.snippet || '',
  }));
}

export function hasSearchKey(env) {
  return !!(env.SERPER_API_KEY || (env.GOOGLE_API_KEY && env.GOOGLE_CSE_ID));
}

// ---- ZoomInfo via Firecrawl ------------------------------------------------
// LinkedIn blocks servers, and public LinkedIn snippets rarely say where a
// leaver went NOW. ZoomInfo's public company page does — it lists current
// employees AND former employees with their present employer and the years they
// spent at the target company (exactly our "Now At" + "Exposure"). ZoomInfo
// itself is walled by PerimeterX, but Firecrawl scrapes straight through it and
// returns clean markdown. So: find the company's ZoomInfo page, scrape it, parse
// current + former staff. This is what makes "search any company" actually fill
// Now At automatically — no manual Apify runs.

export function hasFirecrawl(env) {
  return !!env.FIRECRAWL_API_KEY;
}

function normName(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Ask Firecrawl to render a URL and hand back its markdown. ZoomInfo needs a
// real browser render (PerimeterX), which Firecrawl does server-side.
async function firecrawlScrape(env, url) {
  const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + env.FIRECRAWL_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ url, formats: ['markdown'], waitFor: 2500 }),
  });
  if (!r.ok) throw new Error(`firecrawl ${r.status}`);
  const data = await r.json().catch(() => null);
  if (!data) return null;
  // v1 shape: { success, data: { markdown, metadata } }
  return (data.data && data.data.markdown) || data.markdown || null;
}

// Find the company's ZoomInfo people page: .../pic/<slug>/<id>. That path is the
// one that lists employees. If the search only turns up the /c/ company profile,
// convert it to the /pic/ people page (same slug + id).
async function zoominfoUrlFor(searcher, env, company) {
  const pickPic = (arr) => {
    for (const r of arr) {
      const m = (r.url || '').match(/https?:\/\/(?:www\.)?zoominfo\.com\/pic\/[^/]+\/\d+/i);
      if (m) return m[0];
    }
    return null;
  };
  let results = [];
  try { results = await searcher(`site:zoominfo.com/pic ${company}`, env, 1); } catch { results = []; }
  let url = pickPic(results);
  if (url) return url;
  // fall back: any ZoomInfo company URL, rewritten to the /pic/ people page.
  try { results = await searcher(`site:zoominfo.com ${company}`, env, 1); } catch { results = []; }
  for (const r of results) {
    const m = (r.url || '').match(/https?:\/\/(?:www\.)?zoominfo\.com\/(?:pic|c)\/([^/]+)\/(\d+)/i);
    if (m) return `https://www.zoominfo.com/pic/${m[1]}/${m[2]}`;
  }
  return null;
}

// Parse ZoomInfo company-page markdown into people records. Two sections:
//   - Former Employees: name + current employer ("at [X]") + role at target +
//     tenure "(YYYY-YYYY)"  -> gives us Now At + Exposure.
//   - Key Employees / Index of contact profiles: current staff + title.
function parseZoomInfoCompany(md, company) {
  const out = [];
  const seen = new Set();
  const isTarget = s => normName(s) === normName(company);

  // ---- Former employees -------------------------------------------------
  const fi = md.search(/##\s*Former Employees/i);
  if (fi >= 0) {
    let sec = md.slice(fi + 3);
    const cut = sec.search(/\n##\s/);
    if (cut > 0) sec = sec.slice(0, cut);
    const workRe = /Worked as\s+([^\n]+)/ig;
    let m; const anchors = [];
    while ((m = workRe.exec(sec))) {
      anchors.push({ idx: m.index, end: workRe.lastIndex, role: m[1].trim().replace(/\s*\.\.\.\s*$/, '') });
    }
    anchors.forEach((a, i) => {
      const start = i ? anchors[i - 1].end : 0;
      const before = sec.slice(start, a.idx);
      const after = sec.slice(a.end, i + 1 < anchors.length ? anchors[i + 1].idx : a.end + 240);
      // tenure years
      const tn = after.match(/\((\d{4})\s*[-–]\s*(\d{4}|present)\)/i);
      const tStart = tn ? tn[1] : null;
      const tEnd = tn ? (/present/i.test(tn[2]) ? null : tn[2]) : null;
      // current employer = last "at [X](/c/..)" before the "Worked as", not the target
      const links = [...before.matchAll(/\bat\s+\[([^\]]+)\]\(https:\/\/www\.zoominfo\.com\/c\//ig)]
        .map(x => x[1].trim()).filter(x => !isTarget(x));
      const cur = links.length ? links[links.length - 1] : null;
      // name: "### [Name]" nearby, else masked -> email/img alt
      let name = null;
      const nm = before.match(/###\s*\[([^\]]+)\]/);
      if (nm) name = nm[1].trim();
      if (!name) { const em = after.match(/!\[email\s+([^\]]+)\]/i); if (em) name = em[1].trim(); }
      if (!name) { const im = before.match(/!\[([^,\]]+),[^\]]*\]\(https:\/\/media\.licdn/i); if (im) name = im[1].trim(); }
      if (name && !seen.has('f' + normName(name))) {
        seen.add('f' + normName(name));
        out.push({
          full_name: name, is_current: 0, relationship: 'ex_employee',
          current_employer: cur, last_role: a.role,
          tenure_start: tStart, tenure_end: tEnd, seniority: seniorityOf(a.role),
        });
      }
    });
  }

  // ---- Current employees (Key Employees + Index) ------------------------
  const head = fi >= 0 ? md.slice(0, fi) : md;
  const lines = head.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // A line may hold several [Name](/p/..) links: initials "[PC]" AND the real
    // "[Priyanka Chatterjee]". Take the last full name (>=2 words), not the first.
    const cands = [...lines[i].matchAll(/\[([A-Z][A-Za-z.'\- ]+?)\]\(https:\/\/www\.zoominfo\.com\/p\//g)]
      .map(x => x[1].trim())
      .filter(n => n.length >= 4 && n.split(/\s+/).length >= 2);
    if (!cands.length) continue;
    const name = cands[cands.length - 1];
    // title = next non-empty line that reads like a role (skip Email/Direct/location)
    let title = null;
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      const t = lines[j].replace(/^[-\s]+/, '').trim();
      if (!t) continue;
      if (/^Email|Direct$|^\[|^!\[/.test(t)) continue;
      if (/^\s*\[?India|Karnataka|Colony/.test(t)) break;
      title = t; break;
    }
    if (!seen.has('c' + normName(name))) {
      seen.add('c' + normName(name));
      out.push({
        full_name: name, is_current: 1, relationship: 'current_employee',
        current_employer: company, last_role: title, current_role: title,
        seniority: seniorityOf(title),
      });
    }
  }
  return out;
}

// Scrape + parse one company's ZoomInfo page into person records ready to store.
async function researchZoomInfo(searcher, env, company) {
  const url = await zoominfoUrlFor(searcher, env, company);
  if (!url) return [];
  let md = null;
  try { md = await firecrawlScrape(env, url); } catch { return []; }
  if (!md) return [];
  return parseZoomInfoCompany(md, company).map(p => ({
    full_name: p.full_name,
    company,
    company_label: company,
    relationship: p.relationship,
    is_current: p.is_current,
    current_employer: p.current_employer || null,
    last_role: p.last_role || null,
    // role AT the target company is this person's "Former Role"
    former_role: p.is_current ? null : (p.last_role || null),
    current_role: p.is_current ? (p.current_role || p.last_role || null) : null,
    tenure_start: p.tenure_start || null,
    tenure_end: p.tenure_end || null,
    seniority: p.seniority,
    linkedin_url: null,
    source: 'zoominfo',
    source_detail: url,
  }));
}

const firstNonEmpty = (...vals) => { for (const v of vals) if (v != null && v !== '') return v; return null; };

// Merge a LinkedIn-search record (s) and a ZoomInfo record (z) for the same
// person. ZoomInfo wins on Now At / Exposure / status (it structures those);
// search keeps the LinkedIn URL and headline (ZoomInfo has neither).
function combineRecords(s, z) {
  return {
    ...s,
    current_employer: firstNonEmpty(z.current_employer, s.current_employer),
    tenure_start: firstNonEmpty(z.tenure_start, s.tenure_start),
    tenure_end: firstNonEmpty(z.tenure_end, s.tenure_end),
    last_role: firstNonEmpty(z.last_role, s.last_role),
    former_role: firstNonEmpty(z.former_role, s.former_role, s.last_role),
    is_current: z.is_current != null ? z.is_current : s.is_current,
    relationship: z.relationship || s.relationship,
    seniority: firstNonEmpty(z.seniority, s.seniority),
    linkedin_url: firstNonEmpty(s.linkedin_url, z.linkedin_url),
    current_role: firstNonEmpty(s.current_role, z.current_role),
    source: 'zoominfo+search',
    source_detail: firstNonEmpty(s.source_detail, z.source_detail),
  };
}

// Union search people + ZoomInfo people, keyed by normalized name.
function mergeByName(searchPeople, ziPeople) {
  const zByName = new Map();
  for (const p of ziPeople) { const k = normName(p.full_name); if (k && !zByName.has(k)) zByName.set(k, p); }
  const out = new Map();
  for (const s of searchPeople) {
    const k = normName(s.full_name);
    if (!k) continue;
    const z = zByName.get(k);
    out.set(k, z ? combineRecords(s, z) : s);
    if (z) zByName.delete(k);
  }
  for (const [k, z] of zByName) if (!out.has(k)) out.set(k, z);
  return [...out.values()];
}

// Research one company and return a de-duplicated list of senior ex-employees.
export async function researchCompany(env, company, opts = {}) {
  const hint = opts.hint || env.COMPANY_HINT || 'India';
  const pages = Number(opts.pages || 2);
  const searcher = env.SERPER_API_KEY ? serperSearch : googleSearch;

  const byKey = new Map();
  async function run(queries, classifier) {
    for (const q of queries) {
      for (let page = 1; page <= pages; page++) {
        let results = [];
        try { results = await searcher(q, env, page); }
        catch { break; }
        if (!results.length) break;
        for (const r of results) {
          const person = classifier(r, company);
          if (!person) continue;
          const key = (person.linkedin_url || person.full_name).toLowerCase();
          if (!byKey.has(key)) byKey.set(key, person);   // ex pass runs first, so it wins on any tie
        }
      }
    }
  }
  await run(buildQueries(company, hint), classify);                 // senior EX-employees
  await run(buildCurrentQueries(company, hint), classifyCurrent);   // senior CURRENT employees
  const searchPeople = [...byKey.values()];

  // ZoomInfo (via Firecrawl) adds Now At + Exposure for leavers, plus current
  // staff — the data LinkedIn snippets can't give us. Best-effort: if the key is
  // missing or the scrape fails, we still return the search results.
  let ziPeople = [];
  if (hasFirecrawl(env)) {
    try { ziPeople = await researchZoomInfo(searcher, env, company); } catch { ziPeople = []; }
  }
  return mergeByName(searchPeople, ziPeople);
}
