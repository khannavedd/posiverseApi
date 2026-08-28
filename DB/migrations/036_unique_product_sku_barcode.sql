-- Migration 036: enforce SKU/Barcode uniqueness in the database
--
-- Controllers/Product.js checks for a duplicate SKU/barcode with a
-- SELECT and then INSERTs — a check-then-act race. Two concurrent
-- creates both see no conflict and both insert, so duplicates were
-- reachable without any constraint stopping them. Bulk import or a
-- direct DB edit gets there without concurrency at all.
--
-- A duplicate barcode is the dangerous one: the POS resolves a scan
-- with `products.find(p => p.Barcode === code)` — first match wins,
-- silently. Scanning sells whichever product happens to be earlier in
-- the array, at that product's price, deducting that product's stock.
-- Wrong item, wrong money, two products' stock corrupted at once.
--
-- PARTIAL and per-RegistrationID:
--   * WHERE the value IS NOT NULL — most products legitimately have no
--     SKU or barcode, and NULLs must not collide with each other.
--   * WHERE "IsActive" — this app soft-deletes (IsActive = false). A
--     deleted product must not permanently reserve its barcode, and
--     re-using the barcode of something you deleted is a normal thing
--     to want to do.
--   * Scoped to RegistrationID, not global — two unrelated businesses
--     can obviously both stock a product with the same manufacturer
--     barcode.
--
-- NOTE: this migration will FAIL if duplicates already exist. That is
-- deliberate — it should not silently pick a winner. Find them first:
--
--   SELECT "RegistrationID", "Barcode", COUNT(*), array_agg("Name")
--   FROM "Product"
--   WHERE "Barcode" IS NOT NULL AND "IsActive"
--   GROUP BY 1, 2 HAVING COUNT(*) > 1;
--
--   SELECT "RegistrationID", "SKU", COUNT(*), array_agg("Name")
--   FROM "Product"
--   WHERE "SKU" IS NOT NULL AND "IsActive"
--   GROUP BY 1, 2 HAVING COUNT(*) > 1;
--
-- Resolve those by hand (blank the wrong one, or deactivate it), then
-- re-run.
--
--   psql "$DATABASE_URL" -f DB/migrations/036_unique_product_sku_barcode.sql

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_sku_unique
  ON "Product" ("RegistrationID", "SKU")
  WHERE "SKU" IS NOT NULL AND "IsActive";

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_barcode_unique
  ON "Product" ("RegistrationID", "Barcode")
  WHERE "Barcode" IS NOT NULL AND "IsActive";

COMMIT;
