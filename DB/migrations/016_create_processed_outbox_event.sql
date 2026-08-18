-- Idempotency guard for Pub/Sub consumers. Pub/Sub is at-least-once
-- delivery — the same message can legitimately arrive twice (a retry
-- after a slow ack, redelivery after a timeout, etc.). For a consumer
-- like "add this purchase's quantities to InStock", processing the
-- same event twice would double-count the stock, which is exactly the
-- kind of silent corruption an inventory system can't tolerate.
--
-- Every consumer inserts the event's EventID here (see
-- Controllers/Inventory.js) before doing its actual work, inside the
-- same transaction. A duplicate delivery hits the primary key
-- collision, the consumer sees the conflict, and skips reprocessing —
-- while still acking the message so Pub/Sub stops redelivering it.
--
--   psql "$DATABASE_URL" -f DB/migrations/016_create_processed_outbox_event.sql

BEGIN;

-- Keyed by (EventID, Consumer) rather than EventID alone — the same
-- event fans out to multiple independent consumers (InStock
-- adjustment, audit trail, ...), each with its own Pub/Sub
-- subscription, so each needs to independently record having
-- processed it without colliding with another consumer doing the same
-- for that event.
CREATE TABLE IF NOT EXISTS "ProcessedOutboxEvent" (
  "EventID" uuid NOT NULL,
  "Consumer" varchar(64) NOT NULL,
  "ProcessedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("EventID", "Consumer")
);

COMMIT;
