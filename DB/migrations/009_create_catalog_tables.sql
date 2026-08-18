-- Recreates the catalog tables — dropped along with everything else in
-- migration 007's reset to auth+ACL-only. Category, Brand, and Tax are
-- identical to their original definitions (migration 002). Product adds
-- two things beyond the original:
--
--   "ProductType" — varchar, not a fixed enum, defaulting to 'goods'.
--   Nothing enforces which values are valid on purpose: adding a
--   'service' type later (or anything else) is just a value, no
--   migration needed. The API can validate against an allow-list if
--   that's ever worth enforcing.
--
--   "ParentProductID" + "VariantName" — the "option 1" variant model:
--   each variant (e.g. Red/M, Red/L) is its own Product row with its
--   own price/stock/barcode, linked by ParentProductID to the row that
--   anchors the group (that row's own ParentProductID is NULL).
--   VariantName ("Red / M") is what the UI shows to tell variants
--   apart; NULL means a standalone, non-varianted product.
--
--   psql "$DATABASE_URL" -f DB/migrations/009_create_catalog_tables.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "Category" (
  "CategoryID" uuid PRIMARY KEY,
  "RegistrationID" uuid NOT NULL,
  "Name" varchar(128) NOT NULL,
  "ParentCategoryID" uuid REFERENCES "Category"("CategoryID"),
  "IsActive" boolean NOT NULL DEFAULT true,
  "CreatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "Brand" (
  "BrandID" uuid PRIMARY KEY,
  "RegistrationID" uuid NOT NULL,
  "Name" varchar(128) NOT NULL,
  "IsActive" boolean NOT NULL DEFAULT true,
  "CreatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "Tax" (
  "TaxID" uuid PRIMARY KEY,
  "RegistrationID" uuid NOT NULL,
  "Name" varchar(64) NOT NULL,
  "Rate" numeric(5,2) NOT NULL,
  "Type" varchar(16) NOT NULL DEFAULT 'exclusive',
  "HSNCode" varchar(16),
  "IsActive" boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS "Product" (
  "ProductID" uuid PRIMARY KEY,
  "RegistrationID" uuid NOT NULL,
  "StoreID" uuid,
  "IsShared" boolean NOT NULL DEFAULT false,
  "ProductType" varchar(32) NOT NULL DEFAULT 'goods',
  "ParentProductID" uuid REFERENCES "Product"("ProductID"),
  "VariantName" varchar(128),
  "CategoryID" uuid REFERENCES "Category"("CategoryID"),
  "BrandID" uuid REFERENCES "Brand"("BrandID"),
  "SKU" varchar(64),
  "Barcode" varchar(64),
  "Name" varchar(255) NOT NULL,
  "Unit" varchar(16) DEFAULT 'pcs',
  "CostPrice" numeric(12,2),
  "SellingPrice" numeric(12,2) NOT NULL,
  "MRP" numeric(12,2),
  "TaxID" uuid REFERENCES "Tax"("TaxID"),
  "ImageUrl" varchar(512),
  "IsActive" boolean NOT NULL DEFAULT true,
  "MergedIntoProductID" uuid,
  "CreatedAt" timestamptz NOT NULL DEFAULT now(),
  "UpdatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_store ON "Product"("StoreID");
CREATE INDEX IF NOT EXISTS idx_product_registration ON "Product"("RegistrationID");
CREATE INDEX IF NOT EXISTS idx_product_updatedat ON "Product"("UpdatedAt");
CREATE INDEX IF NOT EXISTS idx_product_parent ON "Product"("ParentProductID");
CREATE INDEX IF NOT EXISTS idx_product_name ON "Product"("Name");

COMMIT;
