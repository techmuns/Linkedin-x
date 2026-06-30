-- Optional demo rows so the dashboard isn't blank on first open.
-- These are CLEARLY-LABELLED SAMPLES (source = 'sample'), not real people.
-- Delete them any time:  DELETE FROM people WHERE source = 'sample';
-- Real data comes from running the research engine (GitHub Actions).

INSERT OR IGNORE INTO people
  (id, full_name, company, company_label, relationship, last_role, seniority,
   current_employer, current_role, tenure_start, tenure_end, is_current, location,
   linkedin_url, source, source_detail, score, contacted, notes, created_at, updated_at)
VALUES
  ('sample-1', 'Sample — Ex Head of Retail', 'bluestone', 'Bluestone', 'ex_employee',
   'Head of Retail', 'director', 'A Large Retailer', 'VP Retail', '2017', '2022', 0,
   'Bengaluru', NULL, 'sample', 'demo row — delete me', 72, 'no',
   'DEMO ROW. Replace by running real research.', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),

  ('sample-2', 'Sample — Ex CFO', 'bluestone', 'Bluestone', 'ex_employee',
   'Chief Financial Officer', 'clevel', 'A Fintech', 'CFO', '2015', '2020', 0,
   'Mumbai', NULL, 'sample', 'demo row — delete me', 95, 'no',
   'DEMO ROW. Replace by running real research.', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),

  ('sample-3', 'Sample — Ex CaratLane GM', 'caratlane', 'CaratLane', 'competitor_ex',
   'General Manager', 'director', 'A Jewellery Brand', 'Business Head', '2016', '2021', 0,
   'Chennai', NULL, 'sample', 'demo row — delete me', 62, 'no',
   'DEMO ROW. Competitor ex-employee example.', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
