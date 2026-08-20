-- New Setup entity: PaymentType. Right now the POS payment screen
-- (Modules/Sales/Hooks/usePosSale.js) has a hardcoded array of payment
-- method names ("Cash", "GPay", "Card", "UPI", "Wallet", "Loyalty",
-- "Cash From Counter") — this table replaces that hardcoded list with
-- a per-business, admin-editable one under Setup > Payment Types, same
-- pattern as TransactionType.
--
-- This is a lookup/config table, not the "Payment" ledger table that
-- migration 007 deliberately dropped (see DATABASE_SCHEMA.md's
-- "Dropped and never rebuilt" section) — Sale.PaymentMethod stays
-- exactly what it already is, a plain varchar(32) holding whatever
-- name was picked here. Nothing here introduces a Payment/ledger
-- table or changes how a Sale records its payment.
--
-- IsSystemDefined marks the seeded defaults below (matches the
-- reference JSON's field of the same name) — the API blocks deleting
-- these (see Controllers/PaymentType.js) so a business can't
-- accidentally empty out its own payment screen, but they can still be
-- renamed, reordered, or hidden from Sales via ShowInSales.
--
--   psql "$DATABASE_URL" -f DB/migrations/026_create_payment_type.sql

BEGIN;

CREATE TABLE "PaymentType" (
  "PaymentTypeID" uuid PRIMARY KEY,
  "RegistrationID" uuid NOT NULL,
  "Name" varchar(64) NOT NULL,
  "SequenceNo" integer NOT NULL DEFAULT 0,
  "ShowInSales" boolean NOT NULL DEFAULT true,
  "IsSystemDefined" boolean NOT NULL DEFAULT false,
  "IsActive" boolean NOT NULL DEFAULT true,
  "CreatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("RegistrationID", "Name")
);

CREATE INDEX idx_paymenttype_registration ON "PaymentType"("RegistrationID");

-- Seed every business with the same 7 names the POS payment screen has
-- always hardcoded, in the same order, so nobody's payment screen goes
-- blank the moment this ships.
INSERT INTO "PaymentType"
  ("PaymentTypeID", "RegistrationID", "Name", "SequenceNo", "ShowInSales", "IsSystemDefined")
SELECT
  ('90000000-0000-4000-8000-' || lpad((row_number() OVER ())::text, 12, '0'))::uuid,
  r."RegistrationID",
  t.name,
  t.seq,
  true,
  true
FROM (SELECT DISTINCT "RegistrationID" FROM "User") r
CROSS JOIN (VALUES
  ('Cash', 1),
  ('GPay', 2),
  ('Card', 3),
  ('UPI', 4),
  ('Wallet', 5),
  ('Loyalty', 6),
  ('Cash From Counter', 7)
) AS t(name, seq)
ON CONFLICT ("RegistrationID", "Name") DO NOTHING;

COMMIT;
