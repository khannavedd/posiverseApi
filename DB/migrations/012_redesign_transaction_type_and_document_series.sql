-- Scope: TransactionType, CashRegister, DocumentSeries only. No
-- Sale/Purchase/StockLedger tables are touched or assumed to exist —
-- those aren't built yet, so this migration is fully self-contained.
--
-- Rebuilds TransactionType from a single global lookup into a
-- per-business (RegistrationID-scoped) configurable entity, matching
-- the reference schema from the prior Firestore-based system: each
-- business can customize the name/behavior/numbering format of its own
-- transaction types (Sales Invoice, Sales Return, Purchase Order,
-- Purchase Return, Stock In/Out/Adjustment/Transfer) instead of every
-- business sharing one fixed global list.
--
-- Also replaces DocumentSeries' old shape (StoreID + a free-text
-- DocumentType string + Prefix/Suffix/Padding) with a much simpler
-- running-number table keyed by (StoreID, TransactionTypeID), with an
-- optional CashRegisterID for the types that actually need per-till
-- numbering. The actual number FORMAT (prefix/store code/register
-- code/separators) lives on TransactionType.NumberingFormat as jsonb —
-- same idiom this schema already uses for ACL.Permissions — so
-- DocumentSeries only ever tracks the counter.
--
-- CashRegisterID is nullable rather than mandatory: not every
-- transaction type is till-scoped. The reference data itself shows
-- this — "Sales Return"'s NumberingFormat includes a
-- "cashregistercode" segment, but "Stock Update"'s doesn't (just text +
-- storecode). A back-office document like Purchase or a stock
-- adjustment numbers per store; a POS sale numbers per till. This also
-- backfills a "Default CashRegister" for every Store (for the types
-- that do want one), and creates the CashRegister table itself if it
-- doesn't already exist in this database.
--
--   psql "$DATABASE_URL" -f DB/migrations/012_redesign_transaction_type_and_document_series.sql

BEGIN;

-- CashRegister may not exist yet in this database — create it if not.
-- Already scoped per StoreID, so a store having multiple counters/
-- tills is supported without any further change here.
CREATE TABLE IF NOT EXISTS "CashRegister" (
  "CashRegisterID" uuid PRIMARY KEY,
  "StoreID" uuid NOT NULL,
  "Name" varchar(64) NOT NULL,
  "IsActive" boolean NOT NULL DEFAULT true,
  "CreatedAt" timestamptz NOT NULL DEFAULT now()
);

-- Short code (used as a numbering-format segment, e.g. "CR1") alongside
-- the existing display Name.
ALTER TABLE "CashRegister" ADD COLUMN IF NOT EXISTS "Code" varchar(16);

DROP TABLE IF EXISTS "DocumentSeries" CASCADE;
DROP TABLE IF EXISTS "TransactionType" CASCADE;

CREATE TABLE "TransactionType" (
  "TransactionTypeID" uuid PRIMARY KEY,
  "RegistrationID" uuid NOT NULL,
  "Module" varchar(32) NOT NULL,               -- 'sales' | 'purchase' | 'inventory'
  "Code" varchar(32) NOT NULL,                  -- stable internal key, e.g. 'SALE', 'STOCK_IN'
  "Name" varchar(64) NOT NULL,                  -- editable label, e.g. 'Sales Invoice'
  "Direction" varchar(16) NOT NULL,             -- 'in' | 'out' | 'neutral' — signs stock math later
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

CREATE INDEX idx_transactiontype_registration ON "TransactionType"("RegistrationID");

-- Running counter per (Store, TransactionType) pair, optionally further
-- split per CashRegister for till-scoped types. Format lives on
-- TransactionType — this table only tracks the next number.
CREATE TABLE "DocumentSeries" (
  "DocumentSeriesID" uuid PRIMARY KEY,
  "StoreID" uuid NOT NULL,
  "CashRegisterID" uuid REFERENCES "CashRegister"("CashRegisterID"),
  "TransactionTypeID" uuid NOT NULL REFERENCES "TransactionType"("TransactionTypeID"),
  "CurrentNumber" integer NOT NULL DEFAULT 0,
  "IsActive" boolean NOT NULL DEFAULT true
);

-- Two partial unique indexes instead of one plain UNIQUE — Postgres
-- treats every NULL as distinct, so a plain constraint wouldn't stop
-- two store-wide (CashRegisterID IS NULL) series for the same type
-- from being created by accident.
CREATE UNIQUE INDEX idx_documentseries_with_register
  ON "DocumentSeries"("StoreID", "TransactionTypeID", "CashRegisterID")
  WHERE "CashRegisterID" IS NOT NULL;
CREATE UNIQUE INDEX idx_documentseries_store_wide
  ON "DocumentSeries"("StoreID", "TransactionTypeID")
  WHERE "CashRegisterID" IS NULL;

-- Backfill one CashRegister per Store that doesn't already have one.
INSERT INTO "CashRegister" ("CashRegisterID", "StoreID", "Code", "Name", "IsActive")
SELECT
  ('60000000-0000-4000-8000-' || lpad((row_number() OVER ())::text, 12, '0'))::uuid,
  s."StoreID",
  '01',
  'Default CashRegister',
  true
FROM "Store" s
WHERE NOT EXISTS (
  SELECT 1 FROM "CashRegister" cr WHERE cr."StoreID" = s."StoreID"
);

-- Seed the standard TransactionType set per business (RegistrationID) —
-- same per-registration seeding pattern migration 004 used for
-- Category/Brand/Tax.
INSERT INTO "TransactionType"
  ("TransactionTypeID", "RegistrationID", "Module", "Code", "Name", "Direction", "UpdateStock", "SalesImpact")
SELECT
  ('70000000-0000-4000-8000-' || lpad((row_number() OVER ())::text, 12, '0'))::uuid,
  r."RegistrationID",
  t.module,
  t.code,
  t.name,
  t.direction,
  t.update_stock,
  t.sales_impact
FROM (SELECT DISTINCT "RegistrationID" FROM "User") r
CROSS JOIN (VALUES
  ('sales',     'SALE',             'Sales Invoice',   'out',     true,  true),
  ('sales',     'SALE_RETURN',      'Sales Return',    'in',      true,  true),
  ('purchase',  'PURCHASE',         'Purchase Order',  'in',      true,  false),
  ('purchase',  'PURCHASE_RETURN',  'Purchase Return', 'out',     true,  false),
  ('inventory', 'STOCK_IN',         'Stock In',        'in',      true,  false),
  ('inventory', 'STOCK_OUT',        'Stock Out',       'out',     true,  false),
  ('inventory', 'STOCK_ADJUSTMENT', 'Stock Adjustment','neutral', true,  false),
  ('inventory', 'STOCK_TRANSFER',   'Stock Transfer',  'neutral', true,  false)
) AS t(module, code, name, direction, update_stock, sales_impact)
ON CONFLICT ("RegistrationID", "Code") DO NOTHING;

COMMIT;
