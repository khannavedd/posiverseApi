-- Generic variant attributes + per-variant pricing, matching the
-- shop-owner-facing web app's "Add Product" screen (Define Attribute /
-- Add Attribute / per-variant Supply Price, Margin %, Margin Amount,
-- MSP, Retail Price, Discount table). Still lives entirely on "Product"
-- — no new tables, same spirit as migration 019.
--
-- "Attributes" (anchor rows only): the style's attribute schema —
--   [{ "name": "Size", "values": ["S","M","L"] }, { "name": "Colour", "values": ["Red","Blue"] }]
-- "VariantAttributes" (variant rows only): this specific SKU's values —
--   { "Size": "S", "Colour": "Red" }
--
-- VariantMode keeps working as before for backward compatibility: when
-- every attribute name is literally "size" and/or "colour"/"color"
-- (case-insensitive), the backend still populates SizeLabel/ColourName/
-- SizeSortRank as before, so the existing size x colour grid (View,
-- Filter, Catalog cards) keeps working unchanged. Any other attribute
-- name (or 3+ attributes) sets VariantMode = 'custom', a new value —
-- there's no CHECK constraint on this column so nothing to alter.
--
-- Per-variant pricing: CostPrice/SellingPrice/MRP already exist and
-- double as Supply Price / Retail Price / MRP per variant (migration
-- 019's price_override). MarginPercent/MarginAmount/MSP/DiscountPercent
-- are new — optional, entered per variant in the pricing table.
--
-- AutoGenerateSku (anchor rows only) records whether the style was
-- created with the "Automatically Generate SKU" toggle on, purely
-- informational — the backend always falls back to auto-generating a
-- SKU if a manual one wasn't actually supplied for a given variant.
--
--   psql "$DATABASE_URL" -f DB/migrations/020_add_attributes_and_pricing.sql

BEGIN;

ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "Attributes" jsonb;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "VariantAttributes" jsonb;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "MarginPercent" numeric(6,2);
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "MarginAmount" numeric(12,2);
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "MSP" numeric(12,2);
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "DiscountPercent" numeric(6,2);
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "AutoGenerateSku" boolean NOT NULL DEFAULT true;

COMMIT;
