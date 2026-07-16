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
  return [...byKey.values()];
}
