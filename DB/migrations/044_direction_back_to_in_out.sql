-- 044: Direction is two values again — 'in' and 'out'.
--
-- Owner's decision (DEC-030). Migration 043 introduced 'adjustment' to
-- carry the "set stock to this quantity" behaviour. That put the same
-- fact in two places: a Stock Update was identified both by its Kind
-- and by a direction value that only ever applied to it.
--
-- Behaviour now lives on KIND alone. A Stock Update sets stock because
-- it IS a stock update, not because a dropdown says 'adjustment'. That
-- leaves Direction meaning exactly what it says:
--
--   'in'   the quantity is ADDED to stock
--   'out'  the quantity is SUBTRACTED from stock
--
-- posiverse-engine now tests `Kind = 'stock_update'` for the absolute
-- set, and only consults Direction for the delta-based kinds.
-- **Deploy the engine before running this.** An engine still keyed on
-- Direction would see 'out' here and start SUBTRACTING counted
-- quantities — the exact bug DEC-029 fixed. This is the one ordering
-- in this whole sequence that actually matters.
--
-- WHERE DIRECTION IS SIMPLY UNREAD
-- Two kinds carry a Direction that nothing consults, because the column
-- is NOT NULL and needs *a* value:
--   stock_update     — the set is keyed on Kind
--   receive_payment  — UpdateStock is false, so the engine returns
--                      before Direction is reached
-- Both are set to 'out' here. Changing them has no effect; that is the
-- point. The Module Configuration form hides the picker when a type
-- doesn't move stock, so nobody is asked to make a meaningless choice.
--
-- SUPERSEDES migration 043, which set stock_update types to
-- 'adjustment'. Running 043 first and then this is a no-op net — both
-- orders land on 'out' — so it is safe whether or not 043 was applied.
--
-- TO REVERSE:
--   ALTER TABLE "TransactionType" DROP CONSTRAINT IF EXISTS chk_transactiontype_direction;
--   ALTER TABLE "TransactionType" ADD CONSTRAINT chk_transactiontype_direction
--     CHECK ("Direction" IN ('in', 'out', 'adjustment'));
--   UPDATE "TransactionType" SET "Direction" = 'adjustment' WHERE "Kind" = 'stock_update';
--   ALTER TABLE "TransactionType" DROP CONSTRAINT IF EXISTS chk_transactiontype_kind;
--   ALTER TABLE "TransactionType" ADD CONSTRAINT chk_transactiontype_kind
--     CHECK ("Kind" IN ('sale','sale_return','receive_payment','purchase',
--                       'purchase_return','stock_update','stock_transfer'));
-- (and redeploy the engine build that keys the set on Direction).
-- The deleted stock_transfer rows are not restored — they held no data.

BEGIN;

-- Drop first: the UPDATE below would otherwise be checked against the
-- old three-value constraint, which is harmless, but the new constraint
-- cannot be added while 'adjustment' rows still exist.
ALTER TABLE "TransactionType" DROP CONSTRAINT IF EXISTS chk_transactiontype_direction;

-- Every remaining 'adjustment' becomes 'out'. For stock_update and
-- receive_payment this value is never read; for anything else it is the
-- conservative choice, since 'out' cannot inflate stock.
UPDATE "TransactionType"
SET "Direction" = 'out'
WHERE "Direction" NOT IN ('in', 'out');

ALTER TABLE "TransactionType"
  ADD CONSTRAINT chk_transactiontype_direction
  CHECK ("Direction" IN ('in', 'out'));

-- ---------------------------------------------------------------
-- Kind drops to the six the owner settled on: sale, sale_return,
-- receive_payment, purchase, purchase_return, stock_update.
--
-- 'stock_transfer' was seeded by migration 012 and given a Kind by 041,
-- but has never had an entry screen and was never offered in the
-- picker, so no document can reference one. It is removed rather than
-- left hidden — an unreachable value in a closed vocabulary is clutter,
-- and a narrower CHECK is a stronger guarantee.
--
-- Guarded on the absence of references anyway. If a row somehow IS
-- referenced the DELETE skips it, and the CHECK below then fails loudly
-- rather than this migration quietly orphaning history. That is the
-- correct failure: it means an assumption here was wrong.
DELETE FROM "TransactionType" t
WHERE t."Kind" = 'stock_transfer'
  AND NOT EXISTS (SELECT 1 FROM "Inventory" i WHERE i."TransactionTypeID" = t."TransactionTypeID")
  AND NOT EXISTS (SELECT 1 FROM "Sale" s WHERE s."TransactionTypeID" = t."TransactionTypeID")
  AND NOT EXISTS (SELECT 1 FROM "DocumentSeries" d WHERE d."TransactionTypeID" = t."TransactionTypeID");

ALTER TABLE "TransactionType" DROP CONSTRAINT IF EXISTS chk_transactiontype_kind;

ALTER TABLE "TransactionType"
  ADD CONSTRAINT chk_transactiontype_kind
  CHECK ("Kind" IN ('sale', 'sale_return', 'receive_payment',
                    'purchase', 'purchase_return', 'stock_update'));

COMMIT;
