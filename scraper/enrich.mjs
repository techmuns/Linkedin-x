// Enrichment engine (runs on GitHub Actions, from GitHub's IPs — not the
// Cloudflare Worker, which LinkedIn rate-limits). For each person still missing
// a current company or a career-start year, it opens their PUBLIC LinkedIn
// profile in a real browser and reads:
//   - current company   -> LinkedIn's og:description "Experience: <Company>"
//   - total experience  -> earliest WORK start year in the profile JSON-LD
// then PATCHes the values back to the dashboard Worker. Public data only, paced.
//
// Env:
//   INGEST_TOKEN  (required) — the dashboard edit password (a GitHub secret)
//   WORKER_URL    (optional) — defaults to the deployed dashboard
//   ENRICH_LIMIT  (optional) — max profiles this run (default 68)

import { chromium } from 'playwright';

const WORKER = (process.env.WORKER_URL || 'https://linkedin-x.tech-441.workers.dev').replace(/\/$/, '');
const TOKEN = process.env.INGEST_TOKEN;
const LIMIT = Number(process.env.ENRICH_LIMIT || 68);
const NOW = new Date().getFullYear();
if (!TOKEN) { console.error('INGEST_TOKEN is required (add it as a GitHub Actions secret).'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const real = v => v && v !== '-' && String(v).trim() !== '';
function decodeEntities(s){return String(s||'').replace(/&amp;/g,'&').replace(/&#0?39;|&apos;|&#x27;/gi,"'").replace(/&quot;|&#34;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&middot;|&#183;/gi,'·').replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(+n));}
function cleanCompany(s, t){s=decodeEntities(s).trim().replace(/\s*[.,]+$/,'').trim();if(s.length<2||s.length>60)return '';if(/^(ex\b|former|self\b|freelance|education|location|\d+\s+connection)/i.test(s))return '';if(t&&s.toLowerCase()===String(t).toLowerCase())return '';return s;}
function currentCompany(html, target){
  const m=html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i)||html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:description["']/i);
  if(!m)return '';
  const seg=decodeEntities(m[1]).split(/\s*[·•|]\s*/).map(x=>x.trim()).find(x=>/^Experience:/i.test(x));
  return seg?cleanCompany(seg.replace(/^Experience:\s*/i,''),target):'';
}
function careerStartYear(html){
  const ys=[...html.matchAll(/company\/[^"]+","member":\{"@type":"OrganizationRole","startDate":(\d{4})/gi)].map(m=>+m[1]).filter(y=>y>=1950&&y<=NOW);
  return ys.length?Math.min(...ys):null;
}

const people = (await (await fetch(WORKER + '/api/people')).json()).people || [];
const targets = people.filter(p => p.linkedin_url && /linkedin\.com\/in\//.test(p.linkedin_url)
  && (!real(p.current_employer) || p.career_start_year == null)).slice(0, LIMIT);
console.log(`${people.length} people; ${targets.length} need enrichment (company and/or experience).`);
if (!targets.length) { console.log('Nothing to enrich.'); process.exit(0); }

const browser = await chromium.launch();
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  locale: 'en-US',
});
const page = await ctx.newPage();
let co = 0, exp = 0, consec = 0, done = 0;
for (const p of targets) {
  done++;
  let html = '', blocked = false;
  try {
    const resp = await page.goto(p.linkedin_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (resp && (resp.status() === 999 || resp.status() === 429)) blocked = true;
    else html = await page.content();
  } catch { /* timeout/nav error */ }
  if (blocked) {
    consec++; console.log(`  [${done}/${targets.length}] blocked — ${p.full_name}`);
    if (consec >= 6) { console.log('  6 blocks in a row — stopping this run.'); break; }
    await sleep(8000); continue;
  }
  consec = 0;
  const company = currentCompany(html, p.company);
  const start = careerStartYear(html);
  const body = {};
  if (!real(p.current_employer) && company) body.current_employer = company;
  if (p.career_start_year == null && start) body.career_start_year = start;
  if (Object.keys(body).length) {
    const r = await fetch(`${WORKER}/api/people/${p.id}`, {
      method: 'PATCH', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (body.current_employer) co++;
    if (body.career_start_year) exp++;
    console.log(`  [${done}/${targets.length}] ✓ ${p.full_name} → ${body.current_employer || '(company kept)'}${body.career_start_year ? ` · ${NOW - body.career_start_year}y exp` : ''}${r.ok ? '' : '  WRITE FAILED'}`);
  } else {
    console.log(`  [${done}/${targets.length}] – ${p.full_name} (no public data found)`);
  }
  await sleep(4000 + Math.floor(Math.random() * 3000)); // pace
}
await browser.close();
console.log(`\nDone — companies +${co}, experience +${exp} of ${targets.length} attempted.`);
