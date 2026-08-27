-- Migration 032: Split payment + receive-payment-for-outstanding
--
-- Two new tables, purely additive — no existing column touched:
--
-- "SalePayment" — one row per tender at checkout. Sale.PaymentMethod
-- stays as the single-string summary column it already is (now holding
-- the sole method's name, or 'Split' when >1 tender was used); this
-- table is the itemized breakdown. "Method" is a plain string, not a
-- FK to PaymentType — same deliberate no-FK choice PaymentType.js's own
-- comment already documents for Sale.PaymentMethod (a PaymentType can
-- be renamed/soft-deleted later without orphaning historical rows).
--
-- "CustomerPayment" — full ledger of payments received against a
-- customer's running outstanding balance (not allocated to any one
-- Sale — same "single running balance" shape Vendor.DueAmount already
-- has, just with real history kept instead of only a total). Gets its
-- own document number via the same DocumentSeries/TransactionType
-- numbering machinery Sale/Purchase already use — see the
-- RECEIVE_PAYMENT TransactionType seeded below.
--
-- Run with:
--   psql "$DATABASE_URL" -f DB/migrations/032_create_sale_customer_payment_tables.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "SalePayment" (
  "SalePaymentID" uuid PRIMARY KEY,
  "SaleID" uuid NOT NULL REFERENCES "Sale"("SaleID"),
  "Method" varchar(64) NOT NULL,
  "Amount" numeric(12,2) NOT NULL,
  "CreatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_salepayment_sale ON "SalePayment"("SaleID");

CREATE TABLE IF NOT EXISTS "CustomerPayment" (
  "CustomerPaymentID" uuid PRIMARY KEY,
  "RegistrationID" uuid NOT NULL,
  "StoreID" uuid NOT NULL,
  "CustomerID" uuid NOT NULL REFERENCES "Customer"("CustomerID"),
  "TransactionTypeID" uuid REFERENCES "TransactionType"("TransactionTypeID"),
  "PaymentNumber" varchar(32),
  "Amount" numeric(12,2) NOT NULL,
  "Method" varchar(64),
  "Notes" text,
  "Action" varchar(16) NOT NULL DEFAULT 'NEW',
  "ActionBy" varchar(255),
  "ActionByUID" uuid,
  "ActionOn" timestamptz NOT NULL DEFAULT now(),
  "CreatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customerpayment_customer ON "CustomerPayment"("CustomerID");
CREATE INDEX IF NOT EXISTS idx_customerpayment_store ON "CustomerPayment"("StoreID");
CREATE INDEX IF NOT EXISTS idx_customerpayment_registration ON "CustomerPayment"("RegistrationID");

-- Seed the "Receive Payment" TransactionType for every business that
-- already exists (mirrors migration 012's per-RegistrationID seeding
-- CROSS JOIN). Neutral/no-stock-impact, same as STOCK_ADJUSTMENT —
-- collecting a payment doesn't move inventory or count as a new sale.
-- New registrations from now on get this at signup instead (see
-- Controllers/Registration.js + migration 033).
INSERT INTO "TransactionType"
  ("TransactionTypeID", "RegistrationID", "Module", "Code", "Name", "Direction",
   "CalculateTax", "CustomerMandatory", "DiscountAllowed", "PaymentModeRequired",
   "SalesImpact", "UpdateStock")
SELECT
  ('80000000-0000-4000-8000-' || lpad((row_number() OVER ())::text, 12, '0'))::uuid,
  r."RegistrationID",
  'sales',
  'RECEIVE_PAYMENT',
  'Receive Payment',
  'neutral',
  false,
  true,
  false,
  true,
  false,
  false
FROM (SELECT DISTINCT "RegistrationID" FROM "User") r
ON CONFLICT ("RegistrationID", "Code") DO NOTHING;

COMMIT;
