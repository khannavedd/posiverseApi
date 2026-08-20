-- Adding "paymenttype.*" to OWNER_PERMISSIONS in Controllers/Registration.js
-- (see DEC-009) only affects businesses that register from now on —
-- ACL.Permissions is a jsonb snapshot taken once at grant time, not
-- recomputed from OWNER_PERMISSIONS on every request (see
-- Utils/permissions.js's rowGrantsPermission: it only falls back to
-- the role matrix when Permissions is empty, and every owner row
-- already has a non-empty one). Without this, every owner who signed
-- up before today can't see the new Payment Types screens no matter
-- what OWNER_PERMISSIONS says now.
--
-- Backfills every existing 'owner' ACL row that's missing
-- "paymenttype.view" (used as the marker — all four paymenttype
-- permissions were always added together) by appending the missing
-- ones. `? 'paymenttype.view'` on a jsonb array checks array
-- membership, so this is safe to run more than once — a row that
-- already has it is left untouched.
--
--   psql "$DATABASE_URL" -f DB/migrations/027_backfill_paymenttype_acl_permissions.sql

BEGIN;

UPDATE "ACL"
SET "Permissions" = "Permissions" || '["paymenttype.view","paymenttype.create","paymenttype.edit","paymenttype.delete"]'::jsonb
WHERE "Role" = 'owner'
  AND "Permissions" IS NOT NULL
  AND NOT ("Permissions" ? 'paymenttype.view');

COMMIT;
