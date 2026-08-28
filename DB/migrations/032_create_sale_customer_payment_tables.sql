-- Migration 032: Split payment + receive-payment-for-outstanding
--
-- One new table, purely additive — no existing column touched:
--
-- "SalePayment" — one row per tender, on ANY Sale (a regular goods
-- sale split across methods, or a "Receive Payment" collection — see
-- below). Sale.PaymentMethod stays as the single-string summary column
-- it already is (now holding the sole method's name, or 'Split' when
-- >1 tender was used); this table is the itemized breakdown. "Method"
-- is a plain string, not a FK to PaymentType — same deliberate no-FK
-- choice PaymentType.js's own comment already documents for
-- Sale.PaymentMethod (a PaymentType can be renamed/soft-deleted later
-- without orphaning historical rows).
--
-- Receiving a payment against a customer's outstanding balance is NOT
-- a separate ledger table — by explicit decision, it's recorded as an
-- ordinary row in "Sale" itself, under the "RECEIVE_PAYMENT"
-- TransactionType seeded below (Direction 'neutral', no stock/sales
-- impact, no line items). This gets it a real DocumentSeries-issued
-- number and full edit/cancel support for free, via the same Sale
-- endpoints/UI a goods sale already has — see Controllers/Sale.js's
-- recordCustomerPayment. posiverse-engine's customerDue consumer reads
-- a Sale row's TransactionType to tell the two apart: a regular sale's
-- DueAmount ADDS to Customer.OutstandingBalance, a RECEIVE_PAYMENT
-- sale's TotalAmount SUBTRACTS from it.
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
