-- Supports fanning an OutboxEvent row out into one Pub/Sub message per
-- line item (see Controllers/Outbox.js's buildItemMessages/
-- publishNextItem) instead of one message for the whole purchase.
-- "PublishedItems" tracks which item InventoryIDs have already gone
-- out, so a crash mid-fan-out only risks re-publishing the ONE item in
-- flight rather than the whole row, and so a concurrent caller can
-- pick up exactly where a previous call left off.
--
-- Also switches ProcessedOutboxEvent's idempotency key from the
-- OutboxEvent row's own EventID to Pub/Sub's own messageId. Once
-- publishing is per-item, one OutboxEvent row produces N distinct
-- Pub/Sub messages — there's no longer a single eventId that
-- identifies "this specific message," but Pub/Sub already hands
-- consumers a unique messageId per publish, so that's what dedup uses
-- now instead of a custom field carried in the payload.
--
--   psql "$DATABASE_URL" -f DB/migrations/017_outbox_item_fanout.sql

BEGIN;

ALTER TABLE "OutboxEvent"
  ADD COLUMN IF NOT EXISTS "PublishedItems" jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "ProcessedOutboxEvent" DROP CONSTRAINT IF EXISTS "ProcessedOutboxEvent_pkey";
ALTER TABLE "ProcessedOutboxEvent" RENAME COLUMN "EventID" TO "MessageID";
ALTER TABLE "ProcessedOutboxEvent" ALTER COLUMN "MessageID" TYPE varchar(128);
ALTER TABLE "ProcessedOutboxEvent" ADD PRIMARY KEY ("MessageID", "Consumer");

COMMIT;
