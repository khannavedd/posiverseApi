-- Adds "TaxInclusive" to Product — a style-level default for whether
-- this product's cost/price already includes its mapped Tax. Purchase
-- Entry already has a real per-line "Tax inclusive" toggle
-- (PurchaseItem.TaxInclusive, migration 014) that the user can flip on
-- any given line; this is a separate, product-level DEFAULT for that
-- toggle, same relationship Product.TaxID already has to
-- PurchaseItem.TaxID (a catalogue-level default that seeds the line
-- when the item is picked, not a runtime override of it).
--
-- Defaults false (exclusive), matching the existing per-item default in
-- both Controllers/Purchase.js's computeItems() and the Purchase Entry
-- item editor's Switch.
--
--   psql "$DATABASE_URL" -f DB/migrations/022_add_product_tax_inclusive.sql

BEGIN;

ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "TaxInclusive" boolean NOT NULL DEFAULT false;

COMMIT;
