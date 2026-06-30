# 📇 Scuttlebutt Desk

A dashboard that gives you a ranked, reachable list of **senior ex-employees and
stakeholders** of any company — for buy-side primary research ("scuttlebutt").

Type a company (e.g. *Bluestone*, *CaratLane*) and get back people who used to
run things there, what they did, roughly how long they stayed, where they are
now, and a built-in **outreach tracker** (contacted / replied / notes). Export
to CSV any time.

> Built for the workflow: *find senior ex-employees → call them → capture notes.*

---

## How it works (two moving parts)

```
   Your browser
        │
        ▼
┌─────────────────────┐        ┌───────────────────────────┐
│  Cloudflare Worker  │  push  │      GitHub Actions       │
│  • dashboard (UI)   │◀───────│  "research engine" robot  │
│  • JSON API         │results │  • Source 1: public       │
└──────────┬──────────┘        │    LinkedIn via search    │
           │ SQL               │  • Source 3: news / DRHP  │
           ▼                   └───────────────────────────┘
┌─────────────────────┐
│  Neon Postgres DB   │
└─────────────────────┘
```

- **Cloudflare Worker** serves the dashboard, talks to **Neon Postgres**, and
  receives results.
- **Neon** (serverless Postgres) stores everyone. The Worker reaches it over
  HTTP with the `@neondatabase/serverless` driver.
- **GitHub Actions** runs the **research engine** (Playwright) that finds people
  and pushes them to the Worker (which writes them to Neon).

### Data sources (enabled today)
1. **Public LinkedIn via search** — queries a search **API** (Google/Serper) for
   *public* profile results that mention being a *former/ex* senior person of the
   target company. **No LinkedIn login, so no account risk.**
3. **News / DRHP** — finds senior people the press/offer-documents say
   resigned/retired/stepped down. Produces *leads* to verify.

Both sources share one pluggable search provider (see setup step 5). API
providers are used when configured; otherwise a Bing browser-scrape is the
fallback.

> Source **2 (logged-in LinkedIn via Playwright)** is intentionally **not**
> wired yet. It is the deepest source but carries account-ban risk. We'll add it
> only if sources 1 + 3 aren't enough.

---

## One-time setup

You need: a Cloudflare account (you already deployed a Worker), a free
[Neon](https://neon.tech) project, and this repo on GitHub.

### 1. Create the Neon database
1. Create a project at **neon.tech**.
2. Copy its **connection string** (Neon dashboard → *Connection string* → use the
   **Pooled connection**; looks like `postgresql://user:pass@…neon.tech/db?sslmode=require`).
3. Create the tables — open Neon's **SQL Editor** and paste the contents of
   [`migrations/0001_init.sql`](migrations/0001_init.sql), then run it.
   (Optional: paste [`seed/sample.sql`](seed/sample.sql) for a few demo rows.)

### 2. Give the Worker the database + edit password
The Neon string lives as a **Cloudflare Worker secret** (that's what talks to the
database) — *not* only in GitHub. Also set the shared edit password.
```bash
npm install
npx wrangler secret put DATABASE_URL    # paste the Neon connection string
npx wrangler secret put INGEST_TOKEN    # pick any strong password
```

### 3. Deploy the dashboard
```bash
npm run deploy
```
Open the printed `*.workers.dev` URL. Click **🔑** and paste the same
`INGEST_TOKEN` so you can edit rows and run research.

### 4. Let GitHub Actions push results
In your GitHub repo → **Settings → Secrets and variables → Actions**, add:
- `WORKER_URL` → your Worker URL (e.g. `https://linkedin-x.you.workers.dev`)
- `INGEST_TOKEN` → the same password from step 2

> The research robot talks to the **Worker**, so GitHub only needs those two
> (plus a search key below). You do **not** have to put the Neon string in GitHub.

### 5. Give the engine a search provider (important)
Search engines block automated requests from cloud computers — and GitHub
Actions runs on cloud computers. So the engine uses an **official search API**.
Pick one and add it to the **GitHub Actions secrets**:

**Recommended — Google Programmable Search (free ~100 queries/day):**
1. Create a search engine at **programmablesearchengine.google.com** → set it to
   **"Search the entire web"** → copy the **Search engine ID** (`cx`).
2. Get an API key at **console.cloud.google.com** → enable **"Custom Search API"**.
3. Add GitHub secrets: `GOOGLE_API_KEY` and `GOOGLE_CSE_ID`.

**Or — Serper.dev (paid, ~$5 covers this project, highest coverage):**
- Add GitHub secret: `SERPER_API_KEY`.

If you set **none**, the engine falls back to scraping Bing with a browser —
free but frequently blocked on cloud IPs (not recommended).

### 5. (Optional) Let the dashboard's "Run new research" button auto-start a run
Add two **Worker** secrets so the button can trigger GitHub for you:
```bash
npx wrangler secret put GH_TOKEN     # a GitHub token with "repo" + "workflow" scope
npx wrangler secret put GH_REPO      # e.g. techmuns/linkedin-x
npm run deploy
```
If you skip this, the button still logs the request — you just start the run
yourself from the Actions tab.

---

## Daily use

1. Open the dashboard, type a **company**, hit **⚡ Run new research**
   (or start it from **Actions → Research → Run workflow**).
2. Wait a few minutes, hit **View list**. People appear, ranked by a
   **seniority score** (founders/CXOs/VPs on top; already-left people boosted).
3. Work the list: set **status** (contacted/replied/…), jot **notes**,
   **Export CSV** for your file.
4. Add anyone you found yourself with **+ Add person**.

### Run the engine locally (to test)
```bash
cd scraper
npm install
npx playwright install chromium
COMPANY="Bluestone" WORKER_URL="https://linkedin-x.you.workers.dev" \
  INGEST_TOKEN="your-secret" node index.mjs
```
Leave `WORKER_URL`/`INGEST_TOKEN` unset for a **dry run** that just prints what
it found.

---

## Honest limitations
- Public-search coverage depends on what search engines expose; expect a
  **starter set**, not every single person. Re-run periodically.
- **Tenure/left dates** are often unknown from public snippets (that detail
  mostly needs Source 2). Fields are left blank rather than guessed.
- **News leads** can be noisy — they're marked `source = news` and flagged
  "verify before outreach."
- Search engines rate-limit automated queries; the engine throttles itself and
  degrades gracefully if a query is blocked.

## Project layout
```
wrangler.jsonc            Cloudflare Worker config
migrations/0001_init.sql  Neon/Postgres schema (paste into Neon SQL editor)
src/worker.js             Worker: dashboard API + database
public/index.html         the dashboard UI
scraper/                  the research engine (GitHub Actions / local)
  index.mjs               orchestrator
  sources/search.mjs      Source 1: public LinkedIn via search
  sources/news.mjs        Source 3: news / DRHP leads
.github/workflows/research.yml   the GitHub Actions robot
seed/sample.sql           optional demo rows
```
