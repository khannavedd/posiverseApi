-- Run this against your Neon Postgres database (SQL editor in the Neon
-- console, or `psql "$DATABASE_URL" -f DB/migrations/001_create_product_table.sql`
-- from this project). Not run automatically — this repo has no migration
-- runner set up yet, so this is a plain SQL file to execute by hand.

CREATE TABLE IF NOT EXISTS "Product" (
  "ProductID" uuid PRIMARY KEY,
  "RegistrationID" uuid NOT NULL,
  "StoreID" uuid,
  "IsShared" boolean NOT NULL DEFAULT false,
  "CategoryID" uuid,
  "BrandID" uuid,
  "SKU" varchar(64),
  "Barcode" varchar(64),
  "Name" varchar(255) NOT NULL,
  "Unit" varchar(16) DEFAULT 'pcs',
  "CostPrice" numeric(12,2),
  "SellingPrice" numeric(12,2) NOT NULL,
  "MRP" numeric(12,2),
  "TaxID" uuid,
  "ImageUrl" varchar(512),
  "IsActive" boolean NOT NULL DEFAULT true,
  "MergedIntoProductID" uuid,
  "CreatedAt" timestamptz NOT NULL DEFAULT now(),
  "UpdatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_store ON "Product"("StoreID");
CREATE INDEX IF NOT EXISTS idx_product_registration ON "Product"("RegistrationID");
CREATE INDEX IF NOT EXISTS idx_product_updatedat ON "Product"("UpdatedAt");
CREATE INDEX IF NOT EXISTS idx_product_barcode ON "Product"("Barcode");
