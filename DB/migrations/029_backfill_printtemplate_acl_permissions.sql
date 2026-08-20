-- Adding "printtemplate.*" to OWNER_PERMISSIONS in Controllers/Registration.js
-- (see DEC-010) only affects businesses that register from now on —
-- ACL.Permissions is a jsonb snapshot taken once at grant time, not
-- recomputed from OWNER_PERMISSIONS on every request (see
-- Utils/permissions.js's rowGrantsPermission: it only falls back to
-- the role matrix when Permissions is empty, and every owner row
-- already has a non-empty one). Without this, every owner who signed
-- up before today can't see the new Setup > Print Template screen no
-- matter what OWNER_PERMISSIONS says now. Same gap, same fix as
-- migration 027 for paymenttype.*.
--
-- Backfills every existing 'owner' ACL row that's missing
-- "printtemplate.view" (used as the marker — both printtemplate
-- permissions were always added together) by appending the missing
-- one(s). `? 'printtemplate.view'` on a jsonb array checks array
-- membership, so this is safe to run more than once — a row that
-- already has it is left untouched.
--
--   psql "$DATABASE_URL" -f DB/migrations/029_backfill_printtemplate_acl_permissions.sql

BEGIN;

UPDATE "ACL"
SET "Permissions" = "Permissions" || '["printtemplate.view","printtemplate.edit"]'::jsonb
WHERE "Role" = 'owner'
  AND "Permissions" IS NOT NULL
  AND NOT ("Permissions" ? 'printtemplate.view');

COMMIT;
