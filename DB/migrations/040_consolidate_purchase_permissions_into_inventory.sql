-- 040: fold the purchase.* permissions into the inventory.* family.
--
-- Owner's decision (DEC-026). After migration 039 renamed the table to
-- "Inventory" and the routes moved to /inventory, two parallel
-- permission families remained:
--
--   purchase.view | purchase.create | purchase.edit | purchase.return
--   inventory.view | inventory.adjust | inventory.transfer
--
-- Purchase Entry is one kind of inventory document, not a separate area
-- of the app, so it should not have its own permission family. After
-- this migration there is one:
--
--   inventory.view | inventory.create | inventory.edit
--   inventory.return | inventory.adjust | inventory.transfer
--
-- MAPPING:
--   purchase.view    -> inventory.view      (already existed)
--   purchase.create  -> inventory.create    (NEW)
--   purchase.edit    -> inventory.edit      (NEW)
--   purchase.return  -> inventory.return    (NEW)
--
-- THIS MIGRATION IS THE RISKY ONE. Routes/Inventory.js now checks
-- inventory.create / inventory.edit / inventory.return. A user whose
-- ACL."Permissions" snapshot still says purchase.create gets a 403 on
-- every inventory screen. Middleware/requirePermission.js reads that
-- jsonb array directly, and Controllers/Auth.js loads it once at login,
-- so a user already signed in keeps a stale snapshot until they sign
-- out and back in.
--
-- >>> AFTER RUNNING THIS, SIGN OUT AND SIGN BACK IN. <<<
--
-- The rewrite below is deliberately additive-then-subtractive per
-- element rather than a whole-array replacement, so a user with a
-- partial or custom permission set keeps exactly the grants they had.
-- Someone who only ever had purchase.view ends up with only
-- inventory.view — not the full family.
--
-- TO REVERSE:
--   UPDATE "ACL" SET "Permissions" = (
--     SELECT jsonb_agg(CASE p::text
--       WHEN '"inventory.create"' THEN '"purchase.create"'::jsonb
--       WHEN '"inventory.edit"'   THEN '"purchase.edit"'::jsonb
--       WHEN '"inventory.return"' THEN '"purchase.return"'::jsonb
--       ELSE p END)
--     FROM jsonb_array_elements("Permissions") p)
--   WHERE "Permissions" @> '["inventory.create"]'
--      OR "Permissions" @> '["inventory.edit"]'
--      OR "Permissions" @> '["inventory.return"]';
-- (inventory.view is NOT reversed — it predates this migration and
-- there is no way to tell an original grant from a converted one.)

BEGIN;

-- Rewrite each element in place. jsonb_agg over jsonb_array_elements
-- preserves everything not named here, so unrelated permissions
-- (sales.*, catalog.*, printer.*) are untouched.
UPDATE "ACL"
SET "Permissions" = (
  SELECT jsonb_agg(DISTINCT
    CASE element::text
      WHEN '"purchase.view"'   THEN '"inventory.view"'::jsonb
      WHEN '"purchase.create"' THEN '"inventory.create"'::jsonb
      WHEN '"purchase.edit"'   THEN '"inventory.edit"'::jsonb
      WHEN '"purchase.return"' THEN '"inventory.return"'::jsonb
      ELSE element
    END)
  FROM jsonb_array_elements("Permissions") AS element
)
WHERE "Permissions" IS NOT NULL
  AND jsonb_typeof("Permissions") = 'array'
  AND (
    "Permissions" @> '["purchase.view"]'   OR
    "Permissions" @> '["purchase.create"]' OR
    "Permissions" @> '["purchase.edit"]'   OR
    "Permissions" @> '["purchase.return"]'
  );

-- DISTINCT above collapses the case where a row already held both
-- purchase.view and inventory.view — without it that row would end up
-- with inventory.view twice. Harmless to the .includes() check in
-- requirePermission.js, but it would look like corruption to anyone
-- reading the row later.

COMMIT;
