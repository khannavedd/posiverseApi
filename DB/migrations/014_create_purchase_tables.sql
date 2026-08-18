-- Purchase Entry — header + line items, normalized (FKs to
-- Product/Vendor/Tax/TransactionType) rather than the reference
-- system's fully-embedded Store/Product/TransactionType documents per
-- transaction. Line items snapshot only the numbers that must stay
-- historically frozen (UnitCost, MRP, RetailPrice, tax at time of
-- purchase) — not the whole product.
--
-- No CashRegisterID on Purchase — a till/cash register is a
-- checkout-counter concept; a Purchase is a back-office document, not
-- something processed "at a register." It numbers per Store instead
-- (see migration 012's DocumentSeries fix, where CashRegisterID became
-- optional for exactly this reason).
--
-- No parent/child transaction chaining (no PO -> Invoice conversion
-- flow) — a Purchase is a single, complete document.
--
-- Vendor is created here too (IF NOT EXISTS) since it hasn't been
-- confirmed to exist in this database yet, same as CashRegister was in
-- migration 012. Its OutstandingBalance is renamed to DueAmount — the
-- vendor's running total owed across every purchase. Purchase itself
-- also gets its own DueAmount — what's still unpaid on this one
-- purchase specifically (supports partial payment; distinct from the
-- vendor-wide total).
--
-- Saving a PurchaseItem should also bump the matching InStock row
-- (InStockQty += Qty, LastTransactionType/No/Date/Qty updated) and,
-- once InStockHistory exists, log a movement row there — that's
-- Controllers/Purchase.js's job when it's built, not a DB trigger
-- here, matching how Controllers/Sale.js already updates
-- InventoryStock/StockLedger in application code.
--
--   psql "$DATABASE_URL" -f DB/migrations/014_create_purchase_tables.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "Vendor" (
  "VendorID" uuid PRIMARY KEY,
  "RegistrationID" uuid NOT NULL,
  "Name" varchar(255) NOT NULL,
  "ContactPerson" varchar(255),
  "Phone" varchar(20),
  "Email" varchar(255),
  "Address" text,
  "GSTNumber" varchar(20),
  "PaymentTermsDays" integer NOT NULL DEFAULT 0,
  "DueAmount" numeric(12,2) NOT NULL DEFAULT 0,
  "IsActive" boolean NOT NULL DEFAULT true,
  "CreatedAt" timestamptz NOT NULL DEFAULT now(),
  "UpdatedAt" timestamptz NOT NULL DEFAULT now()
);

-- In case Vendor already existed from an earlier partial run without
-- IsActive — soft delete (below) needs it.
ALTER TABLE "Vendor" ADD COLUMN IF NOT EXISTS "IsActive" boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS "Purchase" (
  "PurchaseID" uuid PRIMARY KEY,
  "StoreID" uuid NOT NULL,
  "VendorID" uuid NOT NULL REFERENCES "Vendor"("VendorID"),
  "TransactionTypeID" uuid REFERENCES "TransactionType"("TransactionTypeID"),
  "TransactionNo" varchar(64),
  "TransactionDate" timestamptz NOT NULL DEFAULT now(),
  "Status" varchar(16) NOT NULL DEFAULT 'draft',        -- draft | completed | cancelled
  "RefNo" varchar(64),                                   -- the vendor's own invoice/bill number
  "Notes" text,
  "Subtotal" numeric(12,2) NOT NULL DEFAULT 0,
  "DiscountAmount" numeric(12,2) NOT NULL DEFAULT 0,
  "TaxAmount" numeric(12,2) NOT NULL DEFAULT 0,
  "AdditionalCharges" numeric(12,2) NOT NULL DEFAULT 0,
  "RoundOff" numeric(12,2) NOT NULL DEFAULT 0,
  "TotalAmount" numeric(12,2) NOT NULL DEFAULT 0,
  "TotalQty" numeric(12,2) NOT NULL DEFAULT 0,
  "PaymentStatus" varchar(16) NOT NULL DEFAULT 'unpaid',
  "DueAmount" numeric(12,2) NOT NULL DEFAULT 0,          -- remaining unpaid on this purchase specifically
  "Action" varchar(16) NOT NULL DEFAULT 'NEW',           -- 'NEW' | 'EDIT'
  "ActionBy" varchar(255),
  "ActionByUID" uuid,
  "ActionOn" timestamptz NOT NULL DEFAULT now(),
  "CreatedAt" timestamptz NOT NULL DEFAULT now(),
  "UpdatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "PurchaseItem" (
  "PurchaseItemID" uuid PRIMARY KEY,
  "PurchaseID" uuid NOT NULL REFERENCES "Purchase"("PurchaseID"),
  "ProductID" uuid NOT NULL REFERENCES "Product"("ProductID"),
  "Qty" numeric(12,2) NOT NULL,
  "UnitCost" numeric(12,2) NOT NULL,       -- SupplyPrice at time of purchase
  "MRP" numeric(12,2),
  "RetailPrice" numeric(12,2),
  "DiscountAmount" numeric(12,2) NOT NULL DEFAULT 0,
  "TaxID" uuid REFERENCES "Tax"("TaxID"),
  "TaxInclusive" boolean NOT NULL DEFAULT false,
  "TaxableAmount" numeric(12,2) NOT NULL DEFAULT 0,
  "TaxAmount" numeric(12,2) NOT NULL DEFAULT 0,
  "TaxComponents" jsonb,                    -- e.g. [{"TaxName":"CGST","TaxPercentage":9,"TaxAmount":0}, ...]
  "SubTotal" numeric(12,2) NOT NULL,
  "Notes" varchar(255)
);

CREATE INDEX IF NOT EXISTS idx_purchase_store ON "Purchase"("StoreID");
CREATE INDEX IF NOT EXISTS idx_purchase_vendor ON "Purchase"("VendorID");
CREATE INDEX IF NOT EXISTS idx_purchaseitem_purchase ON "PurchaseItem"("PurchaseID");
CREATE INDEX IF NOT EXISTS idx_purchaseitem_product ON "PurchaseItem"("ProductID");

COMMIT;
