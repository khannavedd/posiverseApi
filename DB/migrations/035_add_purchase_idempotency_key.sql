-- Migration 035: idempotency key on Purchase
--
-- Same defect and same fix as migration 034 did for Sale — see that
-- file for the full reasoning. POST /purchases created a new Purchase
-- unconditionally, so a retried request produced a duplicate: stock
-- added twice, vendor credited twice.
--
-- Lower frequency than the sales case (purchases are entered
-- occasionally in the back office, not rapid-fire at a till) but harder
-- to notice, which is why it's worth closing rather than accepting. A
-- duplicate sale is visible — someone is at the counter, the receipt
-- prints twice. A duplicate purchase is silent: InStock and
-- Vendor.DueAmount are simply double what they should be, and nothing
-- surfaces that until a physical stock count.
--
-- Customer payments deliberately need no migration of their own:
-- Controllers/Sale.js's recordCustomerPayment writes a "Sale" row (the
-- RECEIVE_PAYMENT TransactionType — see DEC-017), so it reuses
-- Sale.IdempotencyKey and the index migration 034 already created.
--
--   psql "$DATABASE_URL" -f DB/migrations/035_add_purchase_idempotency_key.sql

BEGIN;

ALTER TABLE "Purchase" ADD COLUMN IF NOT EXISTS "IdempotencyKey" varchar(64);

CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_idempotency_key
  ON "Purchase" ("StoreID", "IdempotencyKey")
  WHERE "IdempotencyKey" IS NOT NULL;

COMMIT;
