// Source #1: discover senior ex-employees from PUBLIC LinkedIn profiles, found
// via a search engine. We never log into LinkedIn here — we only read public
// result titles/snippets — so this does not put any LinkedIn account at risk.
//
// Strategy: query Bing (the most automation-tolerant major engine) for
// LinkedIn /in/ profiles whose snippet mentions being a former/ex member of the
// target company in a senior role.

import { politeDelay, parseLinkedInTitle, cleanLinkedInUrl, employerFromHeadline, looksSenior } from '../lib/util.mjs';

const SENIOR_TERMS = '(Founder OR Chief OR CEO OR CFO OR CTO OR COO OR President OR VP OR "Vice President" OR Director OR Head OR "General Manager")';

function buildQueries(company) {
  const c = `"${company}"`;
  return [
    `site:linkedin.com/in ("ex ${company}" OR "ex-${company}" OR "former ${company}") ${SENIOR_TERMS}`,
    `site:linkedin.com/in (${c}) ("previously" OR "formerly") ${SENIOR_TERMS}`,
    `site:linkedin.com/in (${c}) (Founder OR "Co-Founder" OR CEO OR CFO OR CTO OR COO)`,
  ];
}

async function bingResults(page, query) {
  const url = 'https://www.bing.com/search?count=30&q=' + encodeURIComponent(query);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  // Bing organic results live in <li class="b_algo"> with <h2><a> and a snippet.
  return page.$$eval('li.b_algo', (items) => items.map((li) => {
    const a = li.querySelector('h2 a');
    const p = li.querySelector('.b_caption p, p');
    return {
      title: a ? a.textContent.trim() : '',
      url: a ? a.href : '',
      snippet: p ? p.textContent.trim() : '',
    };
  }));
}

// Decide whether a result really represents a former senior person of `company`.
function classify(r, company) {
  const blob = `${r.title} ${r.snippet}`.toLowerCase();
  const c = company.toLowerCase();
  if (!blob.includes(c)) return null;

  const parsed = parseLinkedInTitle(r.title);
  if (!parsed) return null;

  const isSenior = looksSenior(r.title) || looksSenior(r.snippet);
  if (!isSenior) return null;

  // "ex" signal: words near the company name suggesting they left.
  const exSignal = /\b(ex[-\s]?|former(ly)?|previously|past|retired|left)\b/.test(blob);

  const employer = employerFromHeadline(parsed.headline);
  // If their CURRENT employer is the target, they're probably still there.
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
    _seniorHeadline: parsed.headline,
  };
}

// Best-effort: if the headline mentions the target company with a role, use it.
function roleAtCompany(headline, blob, company) {
  const c = company.toLowerCase();
  // e.g. "Former Head of Retail at Bluestone"
  const m = blob.match(new RegExp(`([a-z &/]+?)\\s+(?:at|@|,)\\s+${c}`, 'i'));
  if (m && looksSenior(m[1])) return titleCase(m[1].trim());
  if (headline && looksSenior(headline)) return headline.split('·')[0].trim();
  return null;
}

function titleCase(s) {
  return s.replace(/\b\w/g, c => c.toUpperCase());
}

export async function runSearchSource(browser, company, log) {
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    locale: 'en-US',
  });
  const page = await ctx.newPage();
  const byKey = new Map();

  for (const q of buildQueries(company)) {
    try {
      log(`  search: ${q}`);
      const results = await bingResults(page, q);
      for (const r of results) {
        const person = classify(r, company);
        if (!person) continue;
        const key = (person.linkedin_url || person.full_name).toLowerCase();
        const prev = byKey.get(key);
        // Prefer the record with an "ex" signal / more fields.
        if (!prev || (person._exSignal && !prev._exSignal)) byKey.set(key, person);
      }
      log(`    -> ${results.length} raw, ${byKey.size} candidates so far`);
    } catch (e) {
      log(`    ! query failed: ${e.message}`);
    }
    await politeDelay();
  }

  await ctx.close();
  // Keep only people who left (is_current === 0). Strip internal fields.
  return [...byKey.values()]
    .filter(p => p.is_current === 0)
    .map(({ _exSignal, _seniorHeadline, ...p }) => p);
}
