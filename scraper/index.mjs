// Research engine entrypoint.
//
// Two modes:
//   • Single company:  COMPANY="Bluestone" node index.mjs
//   • Refresh all:     REFRESH_ALL=1 node index.mjs   (used by the daily cron —
//                      re-researches every company already in the dashboard so
//                      newly-surfaced senior ex-employees are added automatically)
//
// Needs WORKER_URL + INGEST_TOKEN to upload, and a search provider key
// (SERPER_API_KEY or GOOGLE_API_KEY+GOOGLE_CSE_ID); otherwise it dry-runs.

import { chromium } from 'playwright';
import { runSearchSource } from './sources/search.mjs';
import { runNewsSource } from './sources/news.mjs';
import { pickProvider } from './lib/providers.mjs';

const COMPANY = process.env.COMPANY || process.argv[2];
const REFRESH_ALL = process.env.REFRESH_ALL === '1';
const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/$/, '');
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';
const SEARCH_ID = process.env.SEARCH_ID || '';
const SOURCES = (process.env.SOURCES || 'search').split(',').map(s => s.trim());

const log = (...a) => console.log(...a);

function dedupe(people) {
  const byKey = new Map();
  for (const p of people) {
    if (!p || !p.full_name) continue;
    const key = (p.linkedin_url || '').toLowerCase() || `${p.company}|${p.full_name}`.toLowerCase();
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, p); continue; }
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

// Research one company: run the enabled sources, dedupe, and upload.
async function researchCompany(company, browser) {
  const collected = [];
  if (SOURCES.includes('search')) {
    try { collected.push(...await runSearchSource(browser, company, log)); }
    catch (e) { log('  ! search source error: ' + e.message); }
  }
  if (SOURCES.includes('news')) {
    try { collected.push(...await runNewsSource(browser, company, log)); }
    catch (e) { log('  ! news source error: ' + e.message); }
  }
  const people = dedupe(collected);
  const res = await pushResults(people);
  return { people: people.length, res };
}

// Companies to refresh: everyone already in the dashboard, plus any pending
// requests logged in the searches table.
async function trackedCompanies() {
  const names = new Map(); // normalized -> display name
  try {
    const c = await (await fetch(`${WORKER_URL}/api/companies`)).json();
    for (const x of (c.companies || [])) names.set((x.company || '').toLowerCase(), x.label || x.company);
  } catch (e) { log('  ! could not read companies: ' + e.message); }
  try {
    const s = await (await fetch(`${WORKER_URL}/api/searches`)).json();
    for (const x of (s.searches || [])) if (x.company) names.set(x.company.toLowerCase(), x.company);
  } catch { /* optional */ }
  return [...names.values()];
}

async function main() {
  if (!REFRESH_ALL && !COMPANY) {
    console.error('ERROR: set COMPANY env var, or REFRESH_ALL=1.');
    process.exit(1);
  }
  const provider = pickProvider(process.env);
  log(`=== Research engine (${REFRESH_ALL ? 'daily refresh' : 'single'}) | provider: ${provider} | sources: ${SOURCES.join(',')} ===`);

  let browser = null;
  if (provider === 'bing') {
    const launchOpts = { headless: true, args: ['--no-sandbox'] };
    if (process.env.CHROMIUM_PATH) launchOpts.executablePath = process.env.CHROMIUM_PATH;
    if (process.env.HTTPS_PROXY) launchOpts.proxy = { server: process.env.HTTPS_PROXY };
    browser = await chromium.launch(launchOpts);
  }

  try {
    if (REFRESH_ALL) {
      if (!WORKER_URL) { console.error('REFRESH_ALL needs WORKER_URL.'); process.exit(1); }
      const companies = await trackedCompanies();
      log(`Refreshing ${companies.length} companies: ${companies.join(', ')}`);
      let totalNew = 0;
      for (const co of companies) {
        log(`\n--- ${co} ---`);
        try {
          const { people, res } = await researchCompany(co, browser);
          if (res && !res.dry) { log(`  ${co}: ${people} found (created ${res.created}, updated ${res.updated})`); totalNew += res.created || 0; }
          else log(`  ${co}: ${people} found (dry run)`);
        } catch (e) { log(`  ! ${co} failed: ${e.message}`); }
      }
      log(`\nDaily refresh done. ${totalNew} new people added across ${companies.length} companies.`);
    } else {
      await updateSearch('running', 0, null);
      log(`\n=== "${COMPANY}" ===`);
      const { people, res } = await researchCompany(COMPANY, browser);
      if (res && res.dry) log('\nDone (dry run).');
      else { log(`\nUploaded: created=${res.created} updated=${res.updated} skipped=${res.skipped}`); await updateSearch('done', people, `created ${res.created}, updated ${res.updated}`); }
    }
  } finally {
    if (browser) await browser.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
