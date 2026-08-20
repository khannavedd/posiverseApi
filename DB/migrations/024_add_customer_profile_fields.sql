-- Migration 024: Add Customer profile fields
--
-- Matches key fields from the legacy (pre-Postgres) customer record shape
-- the owner shared, minus StoreID — Customer stays scoped by
-- RegistrationID only (a customer is shared across every branch/store
-- under the business, not per-store), per explicit decision. Also skips
-- the legacy FirstName/LastName split (kept as a single Name field).
--
-- Run with:
--   psql "$DATABASE_URL" -f DB/migrations/024_add_customer_profile_fields.sql

BEGIN;

ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "Gender" varchar(16);
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "DateOfBirth" date;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "AnniversaryDate" date;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "Note" text;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "CustomerCode" varchar(64);
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "OutstandingAmountReceived" numeric(12,2) NOT NULL DEFAULT 0;

COMMIT;
