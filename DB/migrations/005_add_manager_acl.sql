-- Adds a 'manager' ACL row scoped to one specific store, on top of the
-- 'owner' row migration 004 already seeded for every user (StoreID = null,
-- meaning access to every store). Owner already grants everything manager
-- does, so to actually see the manager-filtered menu in the app you need
-- to log in as a DIFFERENT user than the one who has 'owner' — the same
-- user having both roles just resolves to 'owner' since ACL checks any
-- matching role.
--
-- Fill in the two placeholders below, then run:
--   psql "$DATABASE_URL" -f DB/migrations/005_add_manager_acl.sql

BEGIN;

-- 1) Find the UID and StoreID you need — run these first and copy the values:
--    SELECT "UID", "Email", "Name" FROM "User";
--    SELECT "StoreID", "StoreName", "StoreCode" FROM "Store";

-- 2) Replace the two placeholders below with real values from step 1,
--    then run this INSERT (uncomment it):

-- INSERT INTO "ACL" ("ACLID", "UserID", "StoreID", "Role", "GrantedAt", "Status")
-- VALUES (
--   '60000000-0000-4000-8000-000000000001',
--   'PASTE_USER_UID_HERE',
--   'PASTE_STORE_ID_HERE',
--   'manager',
--   now(),
--   'active'
-- )
-- ON CONFLICT ("ACLID") DO NOTHING;

COMMIT;
