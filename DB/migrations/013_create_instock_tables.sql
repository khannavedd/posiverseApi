-- Modeled directly on the old system's inventoryinstock collection.
-- InStock is the current stock document for a product at a store,
-- touched by ANY transaction that moves stock (a Sales Invoice
-- reducing it, a Stock Update/Purchase increasing it) — not scoped to
-- manual stock-in only.
--
-- InStockHistory (the movement trail, matching inventoryinstockhistory)
-- is deliberately not part of this migration — building it later.
--
-- Kept from the reference: OpeningQty (static opening stock),
-- InStockQty (current balance, matches their exact field name), and
-- the last-movement trail (TransactionNo/Type/Date/Qty) plus
-- Action/ActionOn.
--
-- Normalized rather than copied: the reference denormalizes
-- ProductName/SKU/Category/Brand/RetailPrice/StoreName etc. directly
-- onto every document (a Firestore-appropriate move — avoids extra
-- reads). Postgres already has Product/Category/Brand/TransactionType
-- tables with cheap joins, and this codebase's existing pattern is to
-- join rather than copy (see useProductList's categoryById/brandById
-- lookups) — so those columns aren't repeated here, just ProductID.
--
-- Left out entirely: ProductCustomField1-6 (no custom-fields feature
-- built) and LastSalesDateTime (sales-specific, not this table's job).
--
--   psql "$DATABASE_URL" -f DB/migrations/013_create_instock_tables.sql

BEGIN;

-- The current stock document — one row per product per store.
CREATE TABLE IF NOT EXISTS "InStock" (
  "InStockID" uuid PRIMARY KEY,
  "StoreID" uuid NOT NULL,
  "ProductID" uuid NOT NULL REFERENCES "Product"("ProductID"),
  "OpeningQty" numeric(12,2) NOT NULL DEFAULT 0,
  "InStockQty" numeric(12,2) NOT NULL DEFAULT 0,
  "LastTransactionTypeID" uuid REFERENCES "TransactionType"("TransactionTypeID"),
  "LastTransactionNo" varchar(64),
  "LastTransactionDate" timestamptz,
  "LastTransactionQty" numeric(12,2),
  "Action" varchar(16) NOT NULL DEFAULT 'NEW',   -- 'NEW' | 'EDIT'
  "ActionOn" timestamptz NOT NULL DEFAULT now(),
  "CreatedAt" timestamptz NOT NULL DEFAULT now(),
  "UpdatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("StoreID", "ProductID")
);

CREATE INDEX IF NOT EXISTS idx_instock_store_product ON "InStock"("StoreID", "ProductID");

COMMIT;
