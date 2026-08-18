-- Transactional outbox — every business event that needs to reach a
-- Pub/Sub consumer (InStock adjustment, audit trail, and whatever else
-- subscribes later) gets written here in the SAME DB transaction as the
-- row it describes (see Controllers/Purchase.js's createPurchase). That
-- way the event can never exist without the data it describes, or vice
-- versa — no dual-write gap between "saved to Postgres" and "published
-- to Pub/Sub".
--
-- This table only ever gets written to and read from here. The actual
-- publish-to-Pub/Sub step (reading PublishedAt IS NULL rows and calling
-- Pub/Sub, then stamping PublishedAt) lives in a separate project per
-- the app owner's plan — nothing in this codebase polls or publishes
-- this table.
--
--   psql "$DATABASE_URL" -f DB/migrations/015_create_outbox_event.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "OutboxEvent" (
  "EventID" uuid PRIMARY KEY,
  "AggregateType" varchar(32) NOT NULL,   -- 'Purchase', later 'Sale' / 'InStock' / ...
  "AggregateID" uuid NOT NULL,            -- the PurchaseID (etc.) this event is about
  "EventType" varchar(32) NOT NULL,       -- 'PurchaseCreated', 'PurchaseUpdated', ...
  "Payload" jsonb NOT NULL,
  "CreatedAt" timestamptz NOT NULL DEFAULT now(),
  "PublishedAt" timestamptz
);

-- What the external publisher polls: unpublished rows, oldest first.
CREATE INDEX IF NOT EXISTS idx_outbox_unpublished ON "OutboxEvent"("CreatedAt") WHERE "PublishedAt" IS NULL;

COMMIT;
