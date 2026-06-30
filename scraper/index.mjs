// Research engine entrypoint.
//
// Usage (locally or in GitHub Actions):
//   COMPANY="Bluestone" \
//   WORKER_URL="https://linkedin-x.<you>.workers.dev" \
//   INGEST_TOKEN="<secret>" \
//   node index.mjs
//
// It runs the enabled sources, merges + dedupes the people, and POSTs them to
// the dashboard's /api/people endpoint. Source #2 (logged-in LinkedIn) is NOT
// wired here yet — only the safe sources #1 (public search) and #3 (news/DRHP).

import { chromium } from 'playwright';
import { runSearchSource } from './sources/search.mjs';
import { runNewsSource } from './sources/news.mjs';
import { pickProvider } from './lib/providers.mjs';

const COMPANY = process.env.COMPANY || process.argv[2];
const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/$/, '');
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';
const SEARCH_ID = process.env.SEARCH_ID || '';
// Default to the high-quality LinkedIn search source. The news/DRHP source is
// noisier (opt in with SOURCES="search,news").
const SOURCES = (process.env.SOURCES || 'search').split(',').map(s => s.trim());

const log = (...a) => console.log(...a);

function dedupe(people) {
  const byKey = new Map();
  for (const p of people) {
    if (!p || !p.full_name) continue;
    const key = (p.linkedin_url || '') .toLowerCase() || `${p.company}|${p.full_name}`.toLowerCase();
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, p); continue; }
    // Merge: fill blanks, prefer a record that has a LinkedIn URL / role.
    byKey.set(key, {
      ...prev,
      ...Object.fromEntries(Object.entries(p).filter(([, v]) => v != null && v !== '')),
      source: prev.source === p.source ? prev.source : `${prev.source}+${p.source}`,
    });
  }
  return [...byKey.values()];
}

async function pushResults(people) {
  if (!WORKER_URL || !INGEST_TOKEN) {
    log('\n[dry-run] WORKER_URL / INGEST_TOKEN not set — printing results instead of uploading:\n');
    log(JSON.stringify(people, null, 2));
    return { created: 0, updated: 0, dry: true };
  }
  const resp = await fetch(`${WORKER_URL}/api/people`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${INGEST_TOKEN}` },
    body: JSON.stringify({ people }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`upload failed (${resp.status}): ${JSON.stringify(data)}`);
  return data;
}

async function updateSearch(status, found, message) {
  if (!WORKER_URL || !INGEST_TOKEN || !SEARCH_ID) return;
  try {
    await fetch(`${WORKER_URL}/api/searches/${SEARCH_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${INGEST_TOKEN}` },
      body: JSON.stringify({ status, found, message }),
    });
  } catch { /* best effort */ }
}

async function main() {
  if (!COMPANY) {
    console.error('ERROR: set COMPANY env var (or pass as first arg).');
    process.exit(1);
  }
  const provider = pickProvider(process.env);
  log(`=== Research engine: "${COMPANY}" ===`);
  log(`Sources: ${SOURCES.join(', ')} | search provider: ${provider}`);
  await updateSearch('running', 0, null);

  // Only spin up a browser if we're falling back to scraping (Bing). API
  // providers (Google/Serper) need no browser at all.
  let browser = null;
  if (provider === 'bing') {
    const launchOpts = { headless: true, args: ['--no-sandbox'] };
    if (process.env.CHROMIUM_PATH) launchOpts.executablePath = process.env.CHROMIUM_PATH;
    if (process.env.HTTPS_PROXY) launchOpts.proxy = { server: process.env.HTTPS_PROXY };
    browser = await chromium.launch(launchOpts);
  }
  const collected = [];
  try {
    if (SOURCES.includes('search')) {
      log('\n[1] Public LinkedIn via search engine');
      try { collected.push(...await runSearchSource(browser, COMPANY, log)); }
      catch (e) { log('  ! search source error: ' + e.message); }
    }
    if (SOURCES.includes('news')) {
      log('\n[3] News / DRHP exit mentions');
      try { collected.push(...await runNewsSource(browser, COMPANY, log)); }
      catch (e) { log('  ! news source error: ' + e.message); }
    }
  } finally {
    if (browser) await browser.close();
  }

  const people = dedupe(collected);
  log(`\nCollected ${collected.length} raw -> ${people.length} unique people.`);

  try {
    const res = await pushResults(people);
    if (res.dry) {
      log('\nDone (dry run).');
    } else {
      log(`\nUploaded: created=${res.created} updated=${res.updated} skipped=${res.skipped}`);
      await updateSearch('done', people.length, `created ${res.created}, updated ${res.updated}`);
    }
  } catch (e) {
    log('\n! upload error: ' + e.message);
    await updateSearch('error', people.length, e.message);
    process.exit(1);
  }
}

main();
