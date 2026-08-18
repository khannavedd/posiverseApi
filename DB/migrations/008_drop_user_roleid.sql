-- User.RoleID was a vestigial NOT NULL placeholder — nothing ever read
-- it, and it wasn't backed by a Role lookup table (see migration 007's
-- notes). Access control has only ever come from the ACL table, keyed
-- by User.UID (the Firebase UID), not from this column. Dropping it so
-- there's exactly one place a role/permission is ever recorded.
--
--   psql "$DATABASE_URL" -f DB/migrations/008_drop_user_roleid.sql

BEGIN;

ALTER TABLE "User" DROP COLUMN IF EXISTS "RoleID";

COMMIT;
