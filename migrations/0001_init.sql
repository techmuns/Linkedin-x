-- Schema for the scuttlebutt dashboard.
-- One row per person we might reach out to about a target company.

CREATE TABLE IF NOT EXISTS people (
  id               TEXT PRIMARY KEY,
  full_name        TEXT NOT NULL,
  company          TEXT NOT NULL,          -- the company they are an ex/stakeholder of (lowercased key)
  company_label    TEXT,                   -- pretty version of the company name for display
  relationship     TEXT DEFAULT 'ex_employee', -- ex_employee | competitor_ex | franchise_partner | board | vendor | other
  last_role        TEXT,                   -- their most senior role at the target company
  seniority        TEXT,                   -- founder | clevel | vp | director | head | manager | other
  current_employer TEXT,
  current_role     TEXT,
  tenure_start     TEXT,                   -- free text, e.g. "2016" or "Mar 2016"
  tenure_end       TEXT,                   -- when they left / retired
  is_current       INTEGER DEFAULT 0,      -- 1 if still at the target company (we mostly want 0)
  location         TEXT,
  linkedin_url     TEXT,
  source           TEXT,                   -- search | news | drhp | manual | linkedin | sample
  source_detail    TEXT,                   -- url or note about where this came from
  score            INTEGER DEFAULT 0,      -- computed usefulness ranking
  contacted        TEXT DEFAULT 'no',      -- no | contacted | replied | scheduled | done | skip
  notes            TEXT,
  created_at       TEXT,
  updated_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_people_company ON people(company);
CREATE INDEX IF NOT EXISTS idx_people_score   ON people(score);

-- Log of search jobs kicked off from the dashboard, so we can show status.
CREATE TABLE IF NOT EXISTS searches (
  id          TEXT PRIMARY KEY,
  company     TEXT NOT NULL,
  status      TEXT DEFAULT 'queued',       -- queued | running | done | error
  found       INTEGER DEFAULT 0,
  message     TEXT,
  created_at  TEXT,
  updated_at  TEXT
);
