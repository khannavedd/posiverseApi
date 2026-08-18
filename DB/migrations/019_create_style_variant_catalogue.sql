-- Catalogue rebuild, flat-Product version. Originally this migration
-- created five new tables (SizeSet/Size/Colour/Style/Variant) — that
-- was reverted before ever being run against a real database in favor
-- of this: everything lives in "Product", the same way migration 009
-- once modeled variants (ParentProductID + VariantName), before
-- migration 011 removed that model because "the app owner tried it and
-- didn't want it." This migration reintroduces those two columns plus
-- what the new catalogue spec needs on top of them.
--
-- Model: one row per sellable thing, same table either way.
--   - A "style" (anchor) row: ParentProductID IS NULL. Holds the
--     shared identity — Name, StyleCode, category/brand,
--     VariantMode, price block. If VariantMode = 'none', this row IS
--     also the one sellable SKU (its own SKU/Barcode filled in
--     directly, no children).
--   - A "variant" row: ParentProductID = the anchor's ProductID.
--     VariantName ("M / Blue"), SizeLabel, ColourName, its own
--     SKU/Barcode (auto-generated), and its own CostPrice/SellingPrice/
--     MRP (already existing columns) doubling as the price_override the
--     spec calls for — a variant row just leaves these equal to the
--     anchor's unless overridden.
--
-- SizeSet/Colour master lists are NOT tables here — no persistence, no
-- per-shop custom sets. The size templates (Shirts S-XXL, Trousers
-- 28-40, Footwear UK 6-11, Kids by age) and the colour list are static
-- constants in the app. SizeSortRank is still a real column on each
-- variant row so a grid/list still sorts S/M/L/XL correctly instead of
-- alphabetically — that part of the spec's reasoning survives even
-- without a Size table.
--
--   psql "$DATABASE_URL" -f DB/migrations/019_create_style_variant_catalogue.sql

BEGIN;

ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "ParentProductID" uuid REFERENCES "Product"("ProductID");
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "VariantName" varchar(128);
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "VariantMode" varchar(16) NOT NULL DEFAULT 'none';
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "StyleCode" varchar(64);
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "SizeLabel" varchar(32);
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "SizeSortRank" integer;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "ColourName" varchar(64);
-- Independent of VariantMode/ProductType: 'fifo' for a single-SKU item
-- tracked with plain FIFO costing, 'variant' once it has a size/colour
-- breakdown. Locked after creation, same as VariantMode.
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "InventoryType" varchar(16) NOT NULL DEFAULT 'fifo';
-- Captured from the create wizard's opening-stock grid, but NOT wired
-- into InStock or any stock ledger yet — same deliberate deferral as
-- before ("don't go to InStock for now, catalogue only").
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "OpeningQty" numeric(12,2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_product_parent ON "Product"("ParentProductID");
CREATE INDEX IF NOT EXISTS idx_product_stylecode ON "Product"("StyleCode");

COMMIT;
