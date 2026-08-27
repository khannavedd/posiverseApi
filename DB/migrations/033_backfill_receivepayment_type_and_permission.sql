-- Migration 033: backfill for businesses that existed before the
-- split-payment / receive-payment feature.
--
-- Two independent backfills, same reasoning as migrations 027/029/031:
-- migration 032 seeded "RECEIVE_PAYMENT" for every RegistrationID that
-- existed AT THAT TIME, and Controllers/Registration.js now seeds it
-- for brand-new signups — but ACL.Permissions is a jsonb snapshot taken
-- once at grant time, not recomputed from OWNER_PERMISSIONS on every
-- request, so every owner who registered before today still can't hit
-- the new /customers/:id/payments endpoints no matter what
-- OWNER_PERMISSIONS says now. Safe to run more than once — both
-- statements are no-ops on a row that's already correct.
--
--   psql "$DATABASE_URL" -f DB/migrations/033_backfill_receivepayment_type_and_permission.sql

BEGIN;

-- In case this runs against a database where a business was created
-- between migration 032 running and this one (registration itself
-- already seeds RECEIVE_PAYMENT going forward, so this is belt-and-
-- suspenders, not the primary path).
INSERT INTO "TransactionType"
  ("TransactionTypeID", "RegistrationID", "Module", "Code", "Name", "Direction",
   "CalculateTax", "CustomerMandatory", "DiscountAllowed", "PaymentModeRequired",
   "SalesImpact", "UpdateStock")
SELECT
  ('81000000-0000-4000-8000-' || lpad((row_number() OVER ())::text, 12, '0'))::uuid,
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

UPDATE "ACL"
SET "Permissions" = "Permissions" || '["sales.payment"]'::jsonb
WHERE "Role" = 'owner'
  AND "Permissions" IS NOT NULL
  AND NOT ("Permissions" ? 'sales.payment');

COMMIT;
