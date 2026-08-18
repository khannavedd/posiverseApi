-- Migration 004 seeded an 'owner' ACL row for every user that existed at
-- the time it ran. Any user created since (no signup/registration
-- endpoint exists yet, so these were added directly in the DB) never got
-- one — which is why their app shows an empty drawer menu: no ACL rows
-- means selectRolesForStore() returns [], so every permission check
-- fails and every menu item gets filtered out.
--
-- This backfills 'owner' for anyone currently missing any ACL row at
-- all. Safe to re-run any time you add a user by hand — it only touches
-- users with zero ACL rows, so it won't touch anyone who already has a
-- role (owner or otherwise) assigned.
--
--   psql "$DATABASE_URL" -f DB/migrations/006_backfill_missing_acl.sql

BEGIN;

INSERT INTO "ACL" ("ACLID", "UserID", "StoreID", "Role", "GrantedAt", "Status")
SELECT
  ('70000000-0000-4000-8000-' || lpad((row_number() OVER ())::text, 12, '0'))::uuid,
  u."UID",
  NULL,
  'owner',
  now(),
  'active'
FROM "User" u
WHERE NOT EXISTS (
  SELECT 1 FROM "ACL" a WHERE a."UserID" = u."UID"
)
ON CONFLICT ("ACLID") DO NOTHING;

COMMIT;
