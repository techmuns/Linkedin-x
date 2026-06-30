// Source #1: discover senior ex-employees from PUBLIC LinkedIn profiles, found
// via a search provider (Google API / Serper / Bing fallback). We never log into
// LinkedIn — we only read public result titles/snippets — so this does not put
// any LinkedIn account at risk.

import { politeDelay, parseLinkedInTitle, cleanLinkedInUrl, employerFromHeadline, looksSenior } from '../lib/util.mjs';
import { makeSearcher } from '../lib/providers.mjs';

const SENIOR_TERMS = '(Founder OR Chief OR CEO OR CFO OR CTO OR COO OR President OR VP OR "Vice President" OR Director OR Head OR "General Manager")';

function buildQueries(company, hint = '') {
  const h = hint ? ` ${hint}` : '';
  // Every query demands an explicit "ex / former / previously" near the company
  // name, so we get people who actually LEFT — not random folks who merely
  // mention the company or who happen to be surnamed like it.
  return [
    `site:linkedin.com/in ("ex ${company}" OR "ex-${company}" OR "former ${company}" OR "formerly ${company}")${h} ${SENIOR_TERMS}`,
    `site:linkedin.com/in ("previously at ${company}" OR "ex ${company}" OR "former ${company}")${h} (Founder OR "Co-Founder" OR CEO OR CFO OR CTO OR COO OR President OR "Vice President" OR Director OR Head)`,
    // Broader net — seniority is still enforced later in classify().
    `site:linkedin.com/in ("ex ${company}" OR "ex-${company}" OR "former ${company}")${h}`,
  ];
}

// Decide whether a result really represents a former senior person of `company`.
function classify(r, company) {
  const blob = `${r.title} ${r.snippet}`.toLowerCase();
  const c = company.toLowerCase();
  if (!blob.includes(c)) return null;

  const parsed = parseLinkedInTitle(r.title);
  if (!parsed) return null;

  // Drop people whose own NAME contains the company (e.g. "Danny Bluestone") —
  // that's a surname match, not an ex-employee.
  const nameLow = parsed.name.toLowerCase();
  const tokens = c.split(/\s+/).filter(t => t.length >= 5);
  if (nameLow.includes(c) || tokens.some(t => nameLow.includes(t))) return null;

  const isSenior = looksSenior(r.title) || looksSenior(r.snippet);
  if (!isSenior) return null;

  // Require an explicit ex/former signal tied to the company.
  const exSignal = /\b(ex[-\s]?|former(ly)?|previously|past|retired|left)\b/.test(blob);
  if (!exSignal) return null;

  const employer = employerFromHeadline(parsed.headline);
  const stillThere = employer && employer.toLowerCase().includes(c);

  return {
    full_name: parsed.name,
    company,
    last_role: roleAtCompany(parsed.headline, blob, company),
    current_employer: stillThere ? null : employer,
    current_role: stillThere ? null : (parsed.headline || null),
    is_current: stillThere ? 1 : 0,
    relationship: 'ex_employee',
    linkedin_url: cleanLinkedInUrl(r.url),
    source: 'search',
    source_detail: r.url,
    _exSignal: exSignal,
  };
}

function roleAtCompany(headline, blob, company) {
  const c = company.toLowerCase();
  const m = blob.match(new RegExp(`([a-z &/]+?)\\s+(?:at|@|,)\\s+${c}`, 'i'));
  if (m && looksSenior(m[1])) return cleanRole(m[1]);
  if (headline && looksSenior(headline)) return cleanRole(headline.split('·')[0]);
  return null;
}

// Strip lead-in noise ("linkedin", "ex", "former", "previously", "the") and
// title-case what remains.
function cleanRole(s) {
  const cleaned = s.trim()
    .replace(/^(linkedin|profile|ex|ex-|former|formerly|previously|the|a|an|at)\b[\s-]*/gi, '')
    .replace(/^(linkedin|profile|ex|ex-|former|formerly|previously|the|a|an|at)\b[\s-]*/gi, '')
    .trim();
  return (cleaned || s.trim()).replace(/\b\w/g, c => c.toUpperCase());
}

export async function runSearchSource(browser, company, log, env = process.env) {
  // Lazily create a Playwright page only if the Bing fallback is used.
  let ctx = null;
  const getPage = async () => {
    ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      locale: 'en-US',
    });
    return ctx.newPage();
  };
  const searcher = makeSearcher(env, getPage, log);
  const byKey = new Map();

  // Optional disambiguation hint (e.g. "India", "jewellery") to avoid same-named
  // companies/people in other countries.
  const hint = env.COMPANY_HINT || '';
  for (const q of buildQueries(company, hint)) {
    try {
      log(`  search: ${q}`);
      const results = await searcher.search(q);
      for (const r of results) {
        const person = classify(r, company);
        if (!person) continue;
        const key = (person.linkedin_url || person.full_name).toLowerCase();
        const prev = byKey.get(key);
        if (!prev || (person._exSignal && !prev._exSignal)) byKey.set(key, person);
      }
      log(`    -> ${results.length} raw, ${byKey.size} candidates so far`);
    } catch (e) {
      log(`    ! query failed: ${e.message}`);
    }
    if (searcher.provider === 'bing') await politeDelay();
  }

  if (ctx) await ctx.close();
  return [...byKey.values()]
    .filter(p => p.is_current === 0)
    .map(({ _exSignal, ...p }) => p);
}
