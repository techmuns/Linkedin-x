-- Adds an optional profile photo URL per person. When present, the dashboard
-- renders it as the person's avatar (falling back to their initials icon if the
-- URL is missing or the image fails to load).
--
-- Run once against your live D1:
--   npx wrangler d1 execute linkedinx --remote --file=./migrations/0002_add_photo_url.sql
-- ...and locally if you use a local DB:
--   npx wrangler d1 execute linkedinx --local  --file=./migrations/0002_add_photo_url.sql

ALTER TABLE people ADD COLUMN photo_url TEXT;
