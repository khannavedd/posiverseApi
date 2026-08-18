-- One-time, schema-only setup for a fresh Cloud SQL database — paste
-- this whole file into Cloud SQL Studio's query editor (or a Cloud
-- Shell psql session) and run it once. No data, no seed inserts —
-- Registration/User/Store/ACL/TransactionType/CashRegister all get
-- created automatically the moment you register a new business through
-- the app (see Controllers/Registration.js); everything else
-- (Category/Brand/Tax/Product/Vendor/Purchase) gets added through the
-- app's own screens as you use it.
--
-- This is the CURRENT final shape of every table — reconstructed by
-- walking migrations 001 through 021 in order and applying every
-- ALTER/DROP along the way, not a copy of any single migration file.
-- A few things this deliberately leaves OUT of that history because the
-- app no longer uses them:
--   - Vendor.ContactPerson / Vendor.PaymentTermsDays (removed from the
--     app; the live Neon DB still has these unused columns, this fresh
--     schema doesn't bother creating them)
--   - Sale/SaleItem/StockLedger/Customer/CashRegisterSession/
--     CashMovement/InventoryStock/Payment/InStockHistory — these were
--     dropped in migration 007's reset and never rebuilt; not part of
--     the app today.
--
-- Tables created, in dependency order:
--   Registration, User, Store, ACL,
--   Category, Brand, Tax, Product,
--   CashRegister, TransactionType, DocumentSeries,
--   InStock,
--   Vendor, Purchase, PurchaseItem

BEGIN;

CREATE TABLE IF NOT EXISTS "Registration" (
  "RegistrationID" uuid PRIMARY KEY,
  "BusinessName" varchar NOT NULL,
  "BusinessTypeID" bigint NOT NULL,
  "PlanID" bigint NOT NULL,
  "Email" varchar NOT NULL,
  "PhoneNo" varchar,
  "CountryCode" varchar,
  "SubscriptionStartOn" bigint,
  "SubscriptionEndOn" bigint,
  "IsDeleted" boolean NOT NULL DEFAULT false,
  "ActionBy" bigint,
  "ActionOn" bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS "User" (
  "UserID" uuid PRIMARY KEY,
  "RegistrationID" uuid NOT NULL REFERENCES "Registration"("RegistrationID"),
  "UID" varchar NOT NULL UNIQUE,
  "Name" varchar NOT NULL,
  "Email" varchar NOT NULL,
  "PhoneNo" varchar,
  "IsDeleted" boolean NOT NULL DEFAULT false,
  "LastLoginOn" bigint NOT NULL,
  "ActionBy" bigint,
  "ActionOn" bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS "Store" (
  "StoreID" uuid PRIMARY KEY,
  "RegistrationID" uuid NOT NULL REFERENCES "Registration"("RegistrationID"),
  "StoreName" varchar NOT NULL,
  "StoreCode" varchar,
  "Email" varchar,
  "PhoneNo" varchar,
  "Address1" text,
  "Address2" text,
  "City" varchar,
  "State" varchar,
  "Country" varchar,
  "Pincode" varchar,
  "Latitude" double precision,
  "Longitude" double precision,
  "GSTNo" varchar,
  "IsDeleted" boolean NOT NULL DEFAULT false,
  "ActionBy" bigint,
  "ActionOn" bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS "ACL" (
  "ACLID" uuid PRIMARY KEY,
  "UserID" varchar(128) NOT NULL,
  "StoreID" uuid,
  "Role" varchar(32) NOT NULL,
  "Permissions" jsonb,
  "GrantedBy" varchar(128),
  "GrantedAt" timestamptz NOT NULL DEFAULT now(),
  "Status" varchar(16) NOT NULL DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_acl_user ON "ACL"("UserID");
CREATE INDEX IF NOT EXISTS idx_store_registration ON "Store"("RegistrationID");
CREATE INDEX IF NOT EXISTS idx_user_registration ON "User"("RegistrationID");

-- Catalog

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

-- Tax groups (multi-component — e.g. CGST + SGST) rather than a flat
-- single rate; see migration 010.
CREATE TABLE IF NOT EXISTS "Tax" (
  "TaxID" uuid PRIMARY KEY,
  "RegistrationID" uuid NOT NULL,
  "Name" varchar(64) NOT NULL,
  "HSNCode" varchar(16),
  "IsActive" boolean NOT NULL DEFAULT true,
  "Components" jsonb NOT NULL,
  "TotalPercentage" numeric(5,2) NOT NULL DEFAULT 0
);

-- Catalogue (migration 019/020, generalized by 021): each row is either
-- a "style" (ParentProductID NULL — the shared identity: Name,
-- Attributes schema, price block) or a "variant" (ParentProductID
-- pointing at its style row — VariantName, VariantAttributes, its own
-- SKU/Barcode, its own CostPrice/SellingPrice/MRP doubling as a price
-- override). SKU/Barcode are independently generated per row (no
-- shared style code) and are optional — never required from the user.
-- Attribute values are just JSON; there's no separate Size/Colour
-- master table and no per-variant sort-rank column.
CREATE TABLE IF NOT EXISTS "Product" (
  "ProductID" uuid PRIMARY KEY,
  "RegistrationID" uuid NOT NULL,
  "StoreID" uuid,
  "IsShared" boolean NOT NULL DEFAULT false,
  "ProductType" varchar(32) NOT NULL DEFAULT 'goods',
  "ParentProductID" uuid REFERENCES "Product"("ProductID"),
  "VariantName" varchar(128),
  "InventoryType" varchar(16) NOT NULL DEFAULT 'fifo',
  "Attributes" jsonb,
  "VariantAttributes" jsonb,
  "AutoGenerateSku" boolean NOT NULL DEFAULT true,
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
  "CreatedAt" timestamptz NOT NULL DEFAULT now(),
  "UpdatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_store ON "Product"("StoreID");
CREATE INDEX IF NOT EXISTS idx_product_registration ON "Product"("RegistrationID");
CREATE INDEX IF NOT EXISTS idx_product_updatedat ON "Product"("UpdatedAt");
CREATE INDEX IF NOT EXISTS idx_product_name ON "Product"("Name");
CREATE INDEX IF NOT EXISTS idx_product_parent ON "Product"("ParentProductID");

-- TransactionType / CashRegister / DocumentSeries

CREATE TABLE IF NOT EXISTS "CashRegister" (
  "CashRegisterID" uuid PRIMARY KEY,
  "StoreID" uuid NOT NULL,
  "Code" varchar(16),
  "Name" varchar(64) NOT NULL,
  "IsActive" boolean NOT NULL DEFAULT true,
  "CreatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "TransactionType" (
  "TransactionTypeID" uuid PRIMARY KEY,
  "RegistrationID" uuid NOT NULL,
  "Module" varchar(32) NOT NULL,
  "Code" varchar(32) NOT NULL,
  "Name" varchar(64) NOT NULL,
  "Direction" varchar(16) NOT NULL,
  "CalculateTax" boolean NOT NULL DEFAULT true,
  "CustomerMandatory" boolean NOT NULL DEFAULT false,
  "DiscountAllowed" boolean NOT NULL DEFAULT true,
  "DiscountPercentage" numeric(5,2) NOT NULL DEFAULT 0,
  "EmployeeMandatory" boolean NOT NULL DEFAULT false,
  "PaymentModeRequired" boolean NOT NULL DEFAULT true,
  "SalesImpact" boolean NOT NULL DEFAULT true,
  "UpdateStock" boolean NOT NULL DEFAULT true,
  "NumberingFormat" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "IsActive" boolean NOT NULL DEFAULT true,
  "CreatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("RegistrationID", "Code")
);

CREATE INDEX IF NOT EXISTS idx_transactiontype_registration ON "TransactionType"("RegistrationID");

CREATE TABLE IF NOT EXISTS "DocumentSeries" (
  "DocumentSeriesID" uuid PRIMARY KEY,
  "StoreID" uuid NOT NULL,
  "CashRegisterID" uuid REFERENCES "CashRegister"("CashRegisterID"),
  "TransactionTypeID" uuid NOT NULL REFERENCES "TransactionType"("TransactionTypeID"),
  "CurrentNumber" integer NOT NULL DEFAULT 0,
  "IsActive" boolean NOT NULL DEFAULT true
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_documentseries_with_register
  ON "DocumentSeries"("StoreID", "TransactionTypeID", "CashRegisterID")
  WHERE "CashRegisterID" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_documentseries_store_wide
  ON "DocumentSeries"("StoreID", "TransactionTypeID")
  WHERE "CashRegisterID" IS NULL;

-- Inventory

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
  "Action" varchar(16) NOT NULL DEFAULT 'NEW',
  "ActionOn" timestamptz NOT NULL DEFAULT now(),
  "CreatedAt" timestamptz NOT NULL DEFAULT now(),
  "UpdatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("StoreID", "ProductID")
);

CREATE INDEX IF NOT EXISTS idx_instock_store_product ON "InStock"("StoreID", "ProductID");

-- Vendor / Purchase

CREATE TABLE IF NOT EXISTS "Vendor" (
  "VendorID" uuid PRIMARY KEY,
  "RegistrationID" uuid NOT NULL,
  "Name" varchar(255) NOT NULL,
  "Phone" varchar(20),
  "Email" varchar(255),
  "Address" text,
  "GSTNumber" varchar(20),
  "DueAmount" numeric(12,2) NOT NULL DEFAULT 0,
  "IsActive" boolean NOT NULL DEFAULT true,
  "CreatedAt" timestamptz NOT NULL DEFAULT now(),
  "UpdatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "Purchase" (
  "PurchaseID" uuid PRIMARY KEY,
  "StoreID" uuid NOT NULL,
  "VendorID" uuid NOT NULL REFERENCES "Vendor"("VendorID"),
  "TransactionTypeID" uuid REFERENCES "TransactionType"("TransactionTypeID"),
  "TransactionNo" varchar(64),
  "TransactionDate" timestamptz NOT NULL DEFAULT now(),
  "Status" varchar(16) NOT NULL DEFAULT 'draft',
  "RefNo" varchar(64),
  "Notes" text,
  "Subtotal" numeric(12,2) NOT NULL DEFAULT 0,
  "DiscountAmount" numeric(12,2) NOT NULL DEFAULT 0,
  "TaxAmount" numeric(12,2) NOT NULL DEFAULT 0,
  "AdditionalCharges" numeric(12,2) NOT NULL DEFAULT 0,
  "RoundOff" numeric(12,2) NOT NULL DEFAULT 0,
  "TotalAmount" numeric(12,2) NOT NULL DEFAULT 0,
  "TotalQty" numeric(12,2) NOT NULL DEFAULT 0,
  "PaymentStatus" varchar(16) NOT NULL DEFAULT 'unpaid',
  "DueAmount" numeric(12,2) NOT NULL DEFAULT 0,
  "Action" varchar(16) NOT NULL DEFAULT 'NEW',
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
  "UnitCost" numeric(12,2) NOT NULL,
  "MRP" numeric(12,2),
  "RetailPrice" numeric(12,2),
  "DiscountAmount" numeric(12,2) NOT NULL DEFAULT 0,
  "TaxID" uuid REFERENCES "Tax"("TaxID"),
  "TaxInclusive" boolean NOT NULL DEFAULT false,
  "TaxableAmount" numeric(12,2) NOT NULL DEFAULT 0,
  "TaxAmount" numeric(12,2) NOT NULL DEFAULT 0,
  "TaxComponents" jsonb,
  "SubTotal" numeric(12,2) NOT NULL,
  "Notes" varchar(255)
);

CREATE INDEX IF NOT EXISTS idx_purchase_store ON "Purchase"("StoreID");
CREATE INDEX IF NOT EXISTS idx_purchase_vendor ON "Purchase"("VendorID");
CREATE INDEX IF NOT EXISTS idx_purchaseitem_purchase ON "PurchaseItem"("PurchaseID");
CREATE INDEX IF NOT EXISTS idx_purchaseitem_product ON "PurchaseItem"("ProductID");

-- (migration 015 added a transactional outbox here; migration 018
-- dropped it — Purchase create/update now publish straight to Pub/Sub,
-- awaited, right after commit. See Utils/publishEvent.js.)

-- Idempotency guard for Pub/Sub consumers (migration 016, retyped in
-- migration 017) — keyed by (MessageID, Consumer) since the same
-- event fans out to multiple independent consumers (InStock
-- adjustment, audit trail, ...). MessageID is Pub/Sub's own messageId
-- (a string, not a uuid) — dedup happens per Pub/Sub message now that
-- one OutboxEvent row publishes N per-item messages, not the
-- OutboxEvent row's own EventID.
CREATE TABLE IF NOT EXISTS "ProcessedOutboxEvent" (
  "MessageID" varchar(128) NOT NULL,
  "Consumer" varchar(64) NOT NULL,
  "ProcessedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("MessageID", "Consumer")
);

COMMIT;
