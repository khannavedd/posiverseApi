-- Migration 034: idempotency key on Sale
--
-- POST /sales unconditionally created a new Sale on every call, so any
-- retry of the same checkout produced a genuine duplicate: two invoice
-- numbers, stock deducted twice, revenue counted twice. A mobile POS on
-- a flaky connection hits this routinely — the request times out
-- client-side (30s, see Services/Api/client.js) while the server
-- happily commits, the cashier sees a failure, and rings it up again.
--
-- The client now sends an "Idempotency-Key" header: one UUID per
-- checkout attempt, reused across retries of THAT attempt and
-- regenerated for a genuinely new sale. The server records it on the
-- Sale row; a second request carrying a key it has already seen gets
-- the original sale back instead of creating another.
--
-- The unique index is what actually makes this safe. Checking
-- "does this key exist?" before inserting would be a check-then-act
-- race — two concurrent retries could both find nothing and both
-- insert. Instead the insert is allowed to fail on the constraint
-- (23505) and the handler then returns the row that won, so
-- correctness does not depend on timing.
--
-- Scoped per RegistrationID rather than globally: keys are generated
-- client-side, and one business's key space should not be able to
-- collide with (or probe for) another's. Partial index so the many
-- rows without a key — every sale created before this, and any caller
-- that doesn't send the header — don't collide with each other on NULL.
--
--   psql "$DATABASE_URL" -f DB/migrations/034_add_sale_idempotency_key.sql

BEGIN;

ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "IdempotencyKey" varchar(64);

-- RegistrationID isn't a column on Sale (it reaches the tenant through
-- Store), so the index carries StoreID instead — a key is only ever
-- reused within one store's checkout flow anyway, and StoreID is
-- already tenant-scoped.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sale_idempotency_key
  ON "Sale" ("StoreID", "IdempotencyKey")
  WHERE "IdempotencyKey" IS NOT NULL;

COMMIT;
