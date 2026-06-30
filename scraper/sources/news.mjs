// Source #3: DRHP / annual-report / news discovery of senior exits.
//
// For listed or recently-IPO'd companies the press and offer documents routinely
// name senior people who joined, resigned, retired or "stepped down". We search
// the web (via the same provider as Source #1) for those phrasings and extract
// probable person names + the exit phrase. These are LEADS (source = 'news') to
// verify on the dashboard — they complement, not replace, the LinkedIn search.

import { politeDelay, looksSenior } from '../lib/util.mjs';
import { makeSearcher } from '../lib/providers.mjs';

const EXIT_TERMS = '("steps down" OR "stepped down" OR resigned OR quits OR retired OR "former" OR "ex-")';
const ROLE_TERMS = '(CEO OR CFO OR COO OR CTO OR "chief executive" OR President OR "Managing Director" OR Director OR "Head of" OR "Vice President")';

function buildQueries(company) {
  return [
    `"${company}" ${ROLE_TERMS} ${EXIT_TERMS}`,
    `"${company}" (DRHP OR prospectus OR "annual report") (director OR "key managerial personnel" OR resigned)`,
  ];
}

// Words that signal a candidate is actually a job title, not a person's name.
const ROLE_WORDS = /\b(chief|officer|executive|financial|managing|director|president|vice|head|general|manager|founder|chairman|board|annual|report|managerial|personnel|company|limited|private|jewellery|jewelry|retail|sales|marketing|operations)\b/i;

// Pull a plausible "Firstname Lastname" that sits next to a senior role word.
function extractNames(text, company) {
  const out = [];
  if (!text) return out;
  const nameRe = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g;
  let m;
  while ((m = nameRe.exec(text)) !== null) {
    const name = m[1];
    const low = name.toLowerCase();
    if (low.includes(company.toLowerCase())) continue;
    // Reject candidates that are really role phrases (e.g. "Chief Financial Officer").
    if (ROLE_WORDS.test(name)) continue;
    const around = text.slice(Math.max(0, m.index - 45), m.index + name.length + 45);
    if (looksSenior(around)) out.push({ name, context: around.trim() });
  }
  return out;
}

function roleFromContext(ctx) {
  const m = ctx.match(/\b(CEO|CFO|COO|CTO|CMO|Chief [A-Za-z]+ Officer|President|Managing Director|Director|Head of [A-Za-z ]+|Vice President)\b/i);
  return m ? m[0] : null;
}

export async function runNewsSource(browser, company, log, env = process.env) {
  let ctx = null;
  const getPage = async () => {
    ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      locale: 'en-US',
    });
    return ctx.newPage();
  };
  const searcher = makeSearcher(env, getPage, log);
  const byName = new Map();

  for (const q of buildQueries(company)) {
    try {
      log(`  news: ${q}`);
      const results = await searcher.search(q);
      for (const r of results) {
        const blob = `${r.title} ${r.snippet}`;
        for (const { name, context } of extractNames(blob, company)) {
          if (byName.has(name)) continue;
          byName.set(name, {
            full_name: name,
            company,
            relationship: 'ex_employee',
            last_role: roleFromContext(context),
            is_current: 0,
            source: 'news',
            source_detail: r.url || r.title,
            notes: `Auto-lead from news/web: "${context.slice(0, 120)}" — verify before outreach.`,
          });
        }
      }
      log(`    -> ${byName.size} news leads so far`);
    } catch (e) {
      log(`    ! news query failed: ${e.message}`);
    }
    if (searcher.provider === 'bing') await politeDelay();
  }

  if (ctx) await ctx.close();
  return [...byName.values()];
}
