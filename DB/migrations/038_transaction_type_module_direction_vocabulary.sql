-- 038: TransactionType — two Modules, three Directions.
--
-- Owner's decision (DEC-024). Module Configuration offers exactly two
-- modules and three directions from here on:
--
--   Module     'sales' | 'inventory'
--   Direction  'in' | 'out' | 'adjustment'
--
-- WHY 'purchase' FOLDS INTO 'inventory'
-- A purchase is how stock arrives; it was never a third peer of sales
-- and inventory. Collapsing it makes Module the single thing that says
-- which part of the app a document belongs to, which is what lets the
-- drawer group transaction types by Module instead of by a hardcoded
-- menu list.
--
-- WHY 'neutral' BECOMES 'adjustment'
-- 'neutral' read as "no stock effect", but TransactionType already has
-- a separate boolean for that — "UpdateStock" — and posiverse-engine
-- checks it FIRST (see onSaleCreateUpdateInStock.js and
-- onPurchaseCreateUpdateInStock.js: `if (!txnType.UpdateStock) skip`).
-- Direction is only ever consulted for types that DO move stock, so the
-- third value should describe a way of moving stock, not the absence of
-- one. 'adjustment' means "the line quantity carries its own sign"
-- (+5 received back, -3 written off) as opposed to 'in' (always add)
-- and 'out' (always subtract).
--
-- HONEST LIMITATION, DO NOT MISREAD THIS MIGRATION
-- 'adjustment' does not adjust anything yet. Both engine consumers bail
-- on any Direction that is not 'in' or 'out', so an 'adjustment' type
-- is inert — exactly as 'neutral' was. This migration renames the
-- concept and constrains the vocabulary; it does not implement signed
-- stock movement. That needs an engine branch plus a Stock Adjustment
-- entry screen, neither of which exists. Deliberately deferred.
--
-- Note this makes an existing contradiction visible rather than
-- creating it: STOCK_ADJUSTMENT has been seeded with UpdateStock=true
-- AND Direction='neutral' since migration 012 — a stock adjustment that
-- cannot adjust stock.
--
-- ROWS AFFECTED (per business): PURCHASE and PURCHASE_RETURN change
-- Module; STOCK_ADJUSTMENT, STOCK_TRANSFER and RECEIVE_PAYMENT change
-- Direction. RECEIVE_PAYMENT has UpdateStock=false so its Direction is
-- never read — the form hides the picker when stock is off, so it is
-- not shown a direction that would be meaningless for it.
--
-- TO REVERSE (before the CHECKs make the old values illegal again):
--   ALTER TABLE "TransactionType" DROP CONSTRAINT IF EXISTS chk_transactiontype_module;
--   ALTER TABLE "TransactionType" DROP CONSTRAINT IF EXISTS chk_transactiontype_direction;
--   UPDATE "TransactionType" SET "Module" = 'purchase'
--     WHERE "Module" = 'inventory' AND "Code" IN ('PURCHASE', 'PURCHASE_RETURN');
--   UPDATE "TransactionType" SET "Direction" = 'neutral' WHERE "Direction" = 'adjustment';
-- The Module reversal is keyed on Code because once folded, nothing
-- else distinguishes a former 'purchase' row from a native 'inventory'
-- one. A type the owner created under 'purchase' with some other Code
-- would not be restored — acceptable, as this runs pre-launch.

BEGIN;

-- 1. Fold 'purchase' into 'inventory'.
UPDATE "TransactionType"
SET "Module" = 'inventory'
WHERE "Module" = 'purchase';

-- 2. Rename the third direction.
UPDATE "TransactionType"
SET "Direction" = 'adjustment'
WHERE "Direction" = 'neutral';

-- 3. Anything else that drifted in (the columns are plain varchar and
--    the API did not validate them until this change) gets pinned to a
--    safe default rather than blocking the migration on the CHECKs
--    below. 'inventory' and 'adjustment' are the inert choices: an
--    unknown module just groups elsewhere in the drawer, and an
--    unknown direction was already being skipped by the engine.
UPDATE "TransactionType"
SET "Module" = 'inventory'
WHERE "Module" NOT IN ('sales', 'inventory');

UPDATE "TransactionType"
SET "Direction" = 'adjustment'
WHERE "Direction" NOT IN ('in', 'out', 'adjustment');

-- 4. Constrain the vocabulary in the database, not just in the API.
--    Without this the columns stay free-text varchar and drift returns
--    the moment anything writes to them directly.
ALTER TABLE "TransactionType"
  ADD CONSTRAINT chk_transactiontype_module
  CHECK ("Module" IN ('sales', 'inventory'));

ALTER TABLE "TransactionType"
  ADD CONSTRAINT chk_transactiontype_direction
  CHECK ("Direction" IN ('in', 'out', 'adjustment'));

COMMIT;
