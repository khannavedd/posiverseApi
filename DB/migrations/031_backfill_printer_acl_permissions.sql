-- Adding "printer.*" to OWNER_PERMISSIONS in Controllers/Registration.js
-- only affects businesses that register from now on — ACL.Permissions
-- is a jsonb snapshot taken once at grant time, not recomputed from
-- OWNER_PERMISSIONS on every request (see Utils/permissions.js's
-- rowGrantsPermission). Without this, every owner who signed up before
-- today can't see the new Setup > Printer screen no matter what
-- OWNER_PERMISSIONS says now. Same gap, same fix as migrations 027
-- (paymenttype.*) and 029 (printtemplate.*).
--
-- Backfills every existing 'owner' ACL row that's missing
-- "printer.view" (used as the marker — both printer permissions were
-- always added together) by appending the missing one(s). `? 'printer.view'`
-- on a jsonb array checks array membership, so this is safe to run
-- more than once — a row that already has it is left untouched.
--
--   psql "$DATABASE_URL" -f DB/migrations/031_backfill_printer_acl_permissions.sql

BEGIN;

UPDATE "ACL"
SET "Permissions" = "Permissions" || '["printer.view","printer.edit"]'::jsonb
WHERE "Role" = 'owner'
  AND "Permissions" IS NOT NULL
  AND NOT ("Permissions" ? 'printer.view');

COMMIT;
