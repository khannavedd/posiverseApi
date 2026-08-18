-- Creates every remaining table from the Database Schema doc that
-- doesn't already exist ("Registration", "Store", "User" are assumed to
-- already exist since login/getStores work against real data — this
-- script does not touch them). "Product" is included again (idempotent,
-- IF NOT EXISTS) so this one file can create everything in one pass.
--
-- Column naming follows the pattern already visible in your existing
-- tables ("Store"."StoreID", "Store"."RegistrationID") — PascalCase,
-- <Table>ID primary keys.
--
-- This sandbox can't reach your Neon database, so run this yourself:
--   psql "$DATABASE_URL" -f DB/migrations/002_create_core_tables.sql
-- or paste it into the Neon console's SQL editor.
--
-- Wrapped in a transaction so it's all-or-nothing — if anything fails,
-- nothing is left half-created. Safe to re-run (everything is
-- IF NOT EXISTS).

BEGIN;

-- Lookup table for sale/inventory transaction kinds.
CREATE TABLE IF NOT EXISTS "TransactionType" (
  "TransactionTypeID" uuid PRIMARY KEY,
  "Code" varchar(32) UNIQUE NOT NULL,
  "Name" varchar(64) NOT NULL,
  "Category" varchar(32) NOT NULL,
  "Direction" varchar(16) NOT NULL,
  "IsActive" boolean NOT NULL DEFAULT true
);

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

CREATE TABLE IF NOT EXISTS "CashRegister" (
  "CashRegisterID" uuid PRIMARY KEY,
  "StoreID" uuid NOT NULL,
  "Name" varchar(64) NOT NULL,
  "IsActive" boolean NOT NULL DEFAULT true,
  "CreatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "CashRegisterSession" (
  "CashRegisterSessionID" uuid PRIMARY KEY,
  "CashRegisterID" uuid NOT NULL REFERENCES "CashRegister"("CashRegisterID"),
  "StoreID" uuid NOT NULL,
  "OpenedBy" uuid NOT NULL,
  "ClosedBy" uuid,
  "OpeningBalance" numeric(12,2) NOT NULL,
  "ClosingBalance" numeric(12,2),
  "ExpectedClosingBalance" numeric(12,2),
  "CashDifference" numeric(12,2),
  "Status" varchar(16) NOT NULL DEFAULT 'open',
  "OpenedAt" timestamptz NOT NULL DEFAULT now(),
  "ClosedAt" timestamptz,
  "Notes" text
);

CREATE TABLE IF NOT EXISTS "CashMovement" (
  "CashMovementID" uuid PRIMARY KEY,
  "SessionID" uuid NOT NULL REFERENCES "CashRegisterSession"("CashRegisterSessionID"),
  "Type" varchar(16) NOT NULL,
  "Amount" numeric(12,2) NOT NULL,
  "Reason" varchar(255),
  "CreatedBy" uuid NOT NULL,
  "CreatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "Customer" (
  "CustomerID" uuid PRIMARY KEY,
  "RegistrationID" uuid NOT NULL,
  "Name" varchar(255) NOT NULL,
  "Phone" varchar(20),
  "Email" varchar(255),
  "Address" text,
  "LoyaltyPoints" numeric(10,2) NOT NULL DEFAULT 0,
  "CreditLimit" numeric(12,2) NOT NULL DEFAULT 0,
  "OutstandingBalance" numeric(12,2) NOT NULL DEFAULT 0,
  "CreatedAt" timestamptz NOT NULL DEFAULT now(),
  "UpdatedAt" timestamptz NOT NULL DEFAULT now()
);

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
  "OutstandingBalance" numeric(12,2) NOT NULL DEFAULT 0,
  "CreatedAt" timestamptz NOT NULL DEFAULT now(),
  "UpdatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "Sale" (
  "SaleID" uuid PRIMARY KEY,
  "StoreID" uuid NOT NULL,
  "InvoiceNumber" varchar(32),
  "CustomerID" uuid REFERENCES "Customer"("CustomerID"),
  "TransactionTypeID" uuid REFERENCES "TransactionType"("TransactionTypeID"),
  "SaleDate" timestamptz NOT NULL DEFAULT now(),
  "CashierID" uuid NOT NULL,
  "Subtotal" numeric(12,2) NOT NULL,
  "TaxAmount" numeric(12,2) NOT NULL DEFAULT 0,
  "DiscountAmount" numeric(12,2) NOT NULL DEFAULT 0,
  "TotalAmount" numeric(12,2) NOT NULL,
  "PaymentMethod" varchar(32),
  "PaymentStatus" varchar(16) NOT NULL DEFAULT 'paid',
  "Status" varchar(16) NOT NULL DEFAULT 'completed',
  "CreatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "SaleItem" (
  "SaleItemID" uuid PRIMARY KEY,
  "SaleID" uuid NOT NULL REFERENCES "Sale"("SaleID"),
  "ProductID" uuid NOT NULL REFERENCES "Product"("ProductID"),
  "Quantity" numeric(10,2) NOT NULL,
  "UnitPrice" numeric(12,2) NOT NULL,
  "TaxID" uuid REFERENCES "Tax"("TaxID"),
  "TaxAmount" numeric(12,2) NOT NULL DEFAULT 0,
  "DiscountAmount" numeric(12,2) NOT NULL DEFAULT 0,
  "LineTotal" numeric(12,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS "InventoryStock" (
  "InventoryStockID" uuid PRIMARY KEY,
  "StoreID" uuid NOT NULL,
  "ProductID" uuid NOT NULL REFERENCES "Product"("ProductID"),
  "QuantityOnHand" numeric(12,2) NOT NULL DEFAULT 0,
  "ReorderLevel" numeric(12,2) NOT NULL DEFAULT 0,
  "ReorderQuantity" numeric(12,2) NOT NULL DEFAULT 0,
  "BinLocation" varchar(64),
  "UpdatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("StoreID", "ProductID")
);

CREATE TABLE IF NOT EXISTS "StockLedger" (
  "StockLedgerID" uuid PRIMARY KEY,
  "StoreID" uuid NOT NULL,
  "ProductID" uuid NOT NULL REFERENCES "Product"("ProductID"),
  "TransactionTypeID" uuid REFERENCES "TransactionType"("TransactionTypeID"),
  "ReferenceType" varchar(32) NOT NULL,
  "ReferenceID" uuid NOT NULL,
  "QuantityChange" numeric(12,2) NOT NULL,
  "BalanceAfter" numeric(12,2) NOT NULL,
  "CreatedBy" uuid,
  "CreatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "Purchase" (
  "PurchaseID" uuid PRIMARY KEY,
  "StoreID" uuid NOT NULL,
  "VendorID" uuid NOT NULL REFERENCES "Vendor"("VendorID"),
  "PurchaseOrderNumber" varchar(32),
  "TransactionTypeID" uuid REFERENCES "TransactionType"("TransactionTypeID"),
  "PurchaseDate" timestamptz NOT NULL DEFAULT now(),
  "Status" varchar(16) NOT NULL DEFAULT 'draft',
  "Subtotal" numeric(12,2) NOT NULL,
  "TaxAmount" numeric(12,2) NOT NULL DEFAULT 0,
  "DiscountAmount" numeric(12,2) NOT NULL DEFAULT 0,
  "TotalAmount" numeric(12,2) NOT NULL,
  "PaymentStatus" varchar(16) NOT NULL DEFAULT 'unpaid',
  "CreatedBy" uuid NOT NULL,
  "CreatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "PurchaseItem" (
  "PurchaseItemID" uuid PRIMARY KEY,
  "PurchaseID" uuid NOT NULL REFERENCES "Purchase"("PurchaseID"),
  "ProductID" uuid NOT NULL REFERENCES "Product"("ProductID"),
  "Quantity" numeric(10,2) NOT NULL,
  "UnitCost" numeric(12,2) NOT NULL,
  "TaxID" uuid REFERENCES "Tax"("TaxID"),
  "TaxAmount" numeric(12,2) NOT NULL DEFAULT 0,
  "LineTotal" numeric(12,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS "Payment" (
  "PaymentID" uuid PRIMARY KEY,
  "StoreID" uuid NOT NULL,
  "ReferenceType" varchar(16) NOT NULL,
  "ReferenceID" uuid NOT NULL,
  "Amount" numeric(12,2) NOT NULL,
  "Method" varchar(32) NOT NULL,
  "CashRegisterSessionID" uuid REFERENCES "CashRegisterSession"("CashRegisterSessionID"),
  "PaymentDate" timestamptz NOT NULL DEFAULT now(),
  "CreatedBy" uuid
);

CREATE TABLE IF NOT EXISTS "DocumentSeries" (
  "DocumentSeriesID" uuid PRIMARY KEY,
  "StoreID" uuid NOT NULL,
  "DocumentType" varchar(32) NOT NULL,
  "Prefix" varchar(16),
  "Suffix" varchar(16),
  "CurrentNumber" integer NOT NULL DEFAULT 0,
  "Padding" integer NOT NULL DEFAULT 4,
  "ResetFrequency" varchar(16) NOT NULL DEFAULT 'never',
  "LastResetAt" timestamptz,
  "IsActive" boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS "ACL" (
  "ACLID" uuid PRIMARY KEY,
  "UserID" uuid NOT NULL,
  "StoreID" uuid,
  "Role" varchar(32) NOT NULL,
  "Permissions" jsonb,
  "GrantedBy" uuid,
  "GrantedAt" timestamptz NOT NULL DEFAULT now(),
  "Status" varchar(16) NOT NULL DEFAULT 'active'
);

-- Indexes for the query patterns the app and API actually use
-- (catalog search, low-stock lookups, delta sync, dues lookups).
CREATE INDEX IF NOT EXISTS idx_product_store ON "Product"("StoreID");
CREATE INDEX IF NOT EXISTS idx_product_registration ON "Product"("RegistrationID");
CREATE INDEX IF NOT EXISTS idx_product_updatedat ON "Product"("UpdatedAt");
CREATE INDEX IF NOT EXISTS idx_product_barcode ON "Product"("Barcode");

CREATE INDEX IF NOT EXISTS idx_saleitem_sale ON "SaleItem"("SaleID");
CREATE INDEX IF NOT EXISTS idx_saleitem_product ON "SaleItem"("ProductID");
CREATE INDEX IF NOT EXISTS idx_sale_store_date ON "Sale"("StoreID", "SaleDate");

CREATE INDEX IF NOT EXISTS idx_stockledger_store_product ON "StockLedger"("StoreID", "ProductID");

CREATE INDEX IF NOT EXISTS idx_purchaseitem_purchase ON "PurchaseItem"("PurchaseID");
CREATE INDEX IF NOT EXISTS idx_purchase_vendor ON "Purchase"("VendorID");

CREATE INDEX IF NOT EXISTS idx_payment_reference ON "Payment"("ReferenceType", "ReferenceID");

CREATE INDEX IF NOT EXISTS idx_customer_registration ON "Customer"("RegistrationID");
CREATE INDEX IF NOT EXISTS idx_vendor_registration ON "Vendor"("RegistrationID");

CREATE INDEX IF NOT EXISTS idx_acl_user ON "ACL"("UserID");

COMMIT;
