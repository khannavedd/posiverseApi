-- Migration 037: link a return to the sale it reverses
--
-- A return is recorded as an ordinary "Sale" row under the SALE_RETURN
-- TransactionType — the same modelling choice DEC-017 made for Receive
-- Payment, and for the same reasons: it gets a real DocumentSeries
-- number, appears wherever sales appear, and reuses the existing
-- pipeline rather than needing a parallel one.
--
-- Almost nothing new is required to make returns work, because
-- SALE_RETURN was already seeded by migration 012 with Direction 'in':
--   * posiverse-engine's InStock consumer already signs its delta off
--     Direction, so an 'in' document ADDS stock back with no code
--     change at all.
--   * Its line items carry the per-item quantities, so partial returns
--     (1 of 3) fall out naturally — the return simply has fewer/smaller
--     lines than the original.
--
-- The one genuinely missing piece is the link back to the original
-- sale, which is what this migration adds. It's needed to show "this
-- invoice has been partly returned", and to stop the same item being
-- returned more times than it was sold.
--
-- Nullable: every existing Sale predates this, and a plain sale never
-- has it. Only SALE_RETURN documents populate it.
--
--   psql "$DATABASE_URL" -f DB/migrations/037_add_sale_return_link.sql

BEGIN;

ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "ReturnOfSaleID" uuid REFERENCES "Sale"("SaleID");

-- Looking up "what has been returned against this sale" happens on
-- every return (to enforce the over-return guard) and on every view of
-- a sale that has returns.
CREATE INDEX IF NOT EXISTS idx_sale_return_of ON "Sale" ("ReturnOfSaleID")
  WHERE "ReturnOfSaleID" IS NOT NULL;

COMMIT;
