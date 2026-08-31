-- 043: Stock Update sets the quantity instead of subtracting it.
--
-- Owner's decision (DEC-029). A stock update is a COUNT, not a movement:
-- the shopkeeper counts the shelf, types 7, and stock becomes 7 —
-- regardless of what the system believed a moment earlier. It was
-- previously seeded as Direction 'out', which subtracted the number
-- typed, so counting 7 removed 7 units.
--
-- This gives Direction 'adjustment' a real meaning for the first time.
-- Until now posiverse-engine skipped it entirely and DEC-024 recorded it
-- as "an accurate label with no behaviour behind it". The full set:
--
--   'in'          add the quantity to stock
--   'out'         subtract the quantity from stock
--   'adjustment'  SET stock to the quantity
--
-- The engine change is in posiverse-engine's
-- controllers/Inventory/onInventoryCreateUpdateInStock.js — the InStock
-- upsert now replaces rather than accumulates when the direction is
-- 'adjustment'. **Deploy the engine before running this migration.**
-- Between the two, a stock update would be recorded and skipped rather
-- than applied — a document that moves no stock, which is recoverable.
-- The other order (migration first, old engine) is identically safe,
-- since the old engine also skips 'adjustment'. Neither order corrupts
-- anything; the engine simply has to be current before the first stock
-- update is posted.
--
-- WHY ONLY stock_update ROWS ARE TOUCHED
-- Matched on Kind, not Code or Name, so a business that renamed its
-- type to "Damage write-off" or created several is covered. A type
-- deliberately set to 'in' or 'out' by the owner is NOT changed — only
-- rows still carrying the seeded 'out' default move to 'adjustment'.
-- Someone who wanted pure subtract-on-count keeps it.
--
-- WHAT THIS MIGRATION CANNOT FIX
-- Any stock update already posted under the old 'out' behaviour
-- SUBTRACTED its quantity from stock. Those movements stand; this only
-- changes how future ones are applied. If a wrong figure is in stock
-- now, post a new stock update with the correct count — which is
-- exactly what the new behaviour is for.
--
-- TO REVERSE:
--   UPDATE "TransactionType" SET "Direction" = 'out'
--   WHERE "Kind" = 'stock_update' AND "Direction" = 'adjustment';
-- (and redeploy the previous engine, which skips 'adjustment').

BEGIN;

UPDATE "TransactionType"
SET "Direction" = 'adjustment'
WHERE "Kind" = 'stock_update'
  AND "Direction" = 'out';

COMMIT;
