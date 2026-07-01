// Pluggable search providers.
//
// The test showed search engines block automated requests from cloud/datacenter
// IPs (including GitHub Actions runners). So the reliable path is an official
// search API. We support, in priority order:
//
//   1. Google Programmable Search (Custom Search JSON API)  — free ~100/day
//      env: GOOGLE_API_KEY + GOOGLE_CSE_ID
//      (Create a CSE at programmablesearchengine.google.com set to
//       "Search the entire web", and an API key at console.cloud.google.com.)
//   2. Serper.dev (Google results as JSON)                  — paid, very robust
//      env: SERPER_API_KEY
//   3. Bing scrape via Playwright                           — free, often blocked
//      (fallback only; needs a browser page)
//
// All providers return a uniform array of { title, url, snippet }.

export function pickProvider(env) {
  if (env.GOOGLE_API_KEY && env.GOOGLE_CSE_ID) return 'google';
  if (env.SERPER_API_KEY) return 'serper';
  return 'bing';
}

async function googleSearch(query, env, num = 10, page = 1) {
  const u = new URL('https://www.googleapis.com/customsearch/v1');
  u.searchParams.set('key', env.GOOGLE_API_KEY);
  u.searchParams.set('cx', env.GOOGLE_CSE_ID);
  u.searchParams.set('num', String(Math.min(num, 10)));
  u.searchParams.set('start', String((page - 1) * 10 + 1));
  u.searchParams.set('q', query);
  const r = await fetch(u, { headers: { accept: 'application/json' } });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`google ${r.status} ${body.slice(0, 160)}`);
  }
  const data = await r.json();
  return (data.items || []).map(it => ({
    title: it.title || '',
    url: it.link || '',
    snippet: it.snippet || '',
  }));
}

async function serperSearch(query, env, num = 10, page = 1) {
  const r = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': env.SERPER_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ q: query, num, page }),
  });
  if (!r.ok) throw new Error(`serper ${r.status}`);
  const data = await r.json();
  return (data.organic || []).map(it => ({
    title: it.title || '',
    url: it.link || '',
    snippet: it.snippet || '',
  }));
}

// Fallback: scrape Bing with a real browser. Works locally / on residential IPs;
// frequently blocked on datacenter IPs.
async function bingScrape(pageObj, query, page = 1) {
  const url = `https://www.bing.com/search?count=20&first=${(page - 1) * 20 + 1}&q=` + encodeURIComponent(query);
  await pageObj.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  return pageObj.$$eval('li.b_algo', (items) => items.map((li) => {
    const a = li.querySelector('h2 a');
    const p = li.querySelector('.b_caption p, p');
    return {
      title: a ? a.textContent.trim() : '',
      url: a ? a.href : '',
      snippet: p ? p.textContent.trim() : '',
    };
  }));
}

// Build a single search(query) function bound to the chosen provider.
// `getPage` is a lazy async factory for a Playwright page (only used by Bing).
export function makeSearcher(env, getPage, log = () => {}) {
  const provider = pickProvider(env);
  log(`  search provider: ${provider}`);
  let page = null;
  return {
    provider,
    async search(query, pageNum = 1) {
      if (provider === 'google') return googleSearch(query, env, 10, pageNum);
      if (provider === 'serper') return serperSearch(query, env, 10, pageNum);
      if (!page) page = await getPage();
      return bingScrape(page, query, pageNum);
    },
  };
}
