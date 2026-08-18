-- Removes columns from "Product" that are either being replaced,
-- deferred to a later phase, or were already dead weight:
--
--   - StyleCode      -> replaced. SKU/Barcode are now the identifiers
--                       (independently generated per row, no shared
--                       style prefix). See DECISIONS.md.
--   - OpeningQty     -> removed. A style's stock will come from a real
--                       Purchase/Inventory flow later, not a number
--                       typed in at catalogue-creation time.
--   - MarginPercent, MarginAmount, MSP, DiscountPercent
--                    -> removed. Per-variant pricing is simplified to
--                       just CostPrice/SellingPrice/MRP.
--   - MergedIntoProductID -> was never wired to any merge feature.
--   - SizeLabel, ColourName, SizeSortRank, VariantMode
--                    -> already deprecated (stopped being read/written
--                       by the app in the generic-attributes change);
--                       this drops them for real.
--   - VendorID, LotNo, Season, HSNCode
--                    -> orphaned columns with no migration history and
--                       no code referencing them on Product at all.
--
--   psql "$DATABASE_URL" -f DB/migrations/021_simplify_product_columns.sql

BEGIN;

DROP INDEX IF EXISTS idx_product_stylecode;

ALTER TABLE "Product" DROP COLUMN IF EXISTS "StyleCode";
ALTER TABLE "Product" DROP COLUMN IF EXISTS "OpeningQty";
ALTER TABLE "Product" DROP COLUMN IF EXISTS "MarginPercent";
ALTER TABLE "Product" DROP COLUMN IF EXISTS "MarginAmount";
ALTER TABLE "Product" DROP COLUMN IF EXISTS "MSP";
ALTER TABLE "Product" DROP COLUMN IF EXISTS "DiscountPercent";
ALTER TABLE "Product" DROP COLUMN IF EXISTS "MergedIntoProductID";
ALTER TABLE "Product" DROP COLUMN IF EXISTS "SizeLabel";
ALTER TABLE "Product" DROP COLUMN IF EXISTS "ColourName";
ALTER TABLE "Product" DROP COLUMN IF EXISTS "SizeSortRank";
ALTER TABLE "Product" DROP COLUMN IF EXISTS "VariantMode";
ALTER TABLE "Product" DROP COLUMN IF EXISTS "VendorID";
ALTER TABLE "Product" DROP COLUMN IF EXISTS "LotNo";
ALTER TABLE "Product" DROP COLUMN IF EXISTS "Season";
ALTER TABLE "Product" DROP COLUMN IF EXISTS "HSNCode";

COMMIT;
