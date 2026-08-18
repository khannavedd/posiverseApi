-- Removes the "linked rows" variant model added in migration 009 —
-- the app owner tried it and didn't want it. Every Product row is now
-- just a standalone product again; ParentProductID/VariantName and
-- their index are dropped so nothing in the schema still implies
-- variants exist.
--
--   psql "$DATABASE_URL" -f DB/migrations/011_remove_product_variants.sql

BEGIN;

DROP INDEX IF EXISTS idx_product_parent;

ALTER TABLE "Product" DROP COLUMN IF EXISTS "ParentProductID";
ALTER TABLE "Product" DROP COLUMN IF EXISTS "VariantName";

COMMIT;
