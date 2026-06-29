// Source #3: DRHP / annual-report / news discovery of senior exits.
//
// For listed or recently-IPO'd companies (like Bluestone) the press and the
// offer documents routinely name senior people who joined, resigned, retired or
// "stepped down". These are legally clean, public mentions. We search the news
// web for those phrasings and extract probable person names + the exit phrase.
//
// This is deliberately conservative: it produces LEADS (source = 'news') with a
// note, which you can confirm on the dashboard. It complements the LinkedIn
// search source rather than replacing it.

import { politeDelay, looksSenior } from '../lib/util.mjs';

const EXIT_TERMS = '("steps down" OR "stepped down" OR resigns OR resigned OR "to resign" OR quits OR retires OR retired OR "moves on" OR "former" OR "ex-")';
const ROLE_TERMS = '(CEO OR CFO OR COO OR CTO OR CMO OR "chief executive" OR "chief financial" OR President OR "Managing Director" OR Director OR "Head of" OR "Vice President")';

function buildQueries(company) {
  return [
    `"${company}" ${ROLE_TERMS} ${EXIT_TERMS}`,
    `"${company}" (DRHP OR prospectus OR "annual report") (director OR "key managerial personnel" OR resigned)`,
  ];
}

async function bingNews(page, query) {
  const url = 'https://www.bing.com/news/search?q=' + encodeURIComponent(query);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  try {
    return await page.$$eval('.news-card, .newsitem, .na_cnt', (cards) => cards.map((c) => {
      const a = c.querySelector('a.title, a[href]');
      return {
        title: (c.querySelector('.title') || a || c).textContent.trim().slice(0, 200),
        url: a ? a.href : '',
        snippet: (c.querySelector('.snippet, .description') || {}).textContent || '',
      };
    }));
  } catch {
    return [];
  }
}

// Pull a plausible "Firstname Lastname" that sits next to a senior role word.
function extractNames(text, company) {
  const out = [];
  if (!text) return out;
  // Capitalised 2-3 word sequences (likely names).
  const nameRe = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g;
  let m;
  while ((m = nameRe.exec(text)) !== null) {
    const name = m[1];
    if (name.toLowerCase().includes(company.toLowerCase())) continue;
    // require a senior role word within ~40 chars on either side
    const around = text.slice(Math.max(0, m.index - 40), m.index + name.length + 40);
    if (looksSenior(around)) out.push({ name, context: around.trim() });
  }
  return out;
}

const STOP_NAMES = new Set(['Managing Director', 'Vice President', 'Chief Executive', 'Annual Report']);

export async function runNewsSource(browser, company, log) {
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    locale: 'en-US',
  });
  const page = await ctx.newPage();
  const byName = new Map();

  for (const q of buildQueries(company)) {
    try {
      log(`  news: ${q}`);
      const results = await bingNews(page, q);
      for (const r of results) {
        const blob = `${r.title} ${r.snippet}`;
        for (const { name, context } of extractNames(blob, company)) {
          if (STOP_NAMES.has(name) || byName.has(name)) continue;
          byName.set(name, {
            full_name: name,
            company,
            relationship: 'ex_employee',
            last_role: roleFromContext(context),
            is_current: 0,
            source: 'news',
            source_detail: r.url || r.title,
            notes: `Auto-lead from news: "${context.slice(0, 120)}" — verify before outreach.`,
          });
        }
      }
      log(`    -> ${byName.size} news leads so far`);
    } catch (e) {
      log(`    ! news query failed: ${e.message}`);
    }
    await politeDelay();
  }

  await ctx.close();
  return [...byName.values()];
}

function roleFromContext(ctx) {
  const m = ctx.match(/\b(CEO|CFO|COO|CTO|CMO|Chief [A-Za-z]+ Officer|President|Managing Director|Director|Head of [A-Za-z ]+|Vice President)\b/i);
  return m ? m[0] : null;
}
