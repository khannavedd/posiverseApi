-- The transactional outbox pattern (migration 015) has been replaced
-- with a direct, awaited publish straight from the request handler
-- (see Utils/publishEvent.js and Controllers/Purchase.js) — no more
-- OutboxEvent table, no background sweep, no /internal/outbox route.
-- ProcessedOutboxEvent (migration 016/017) is unrelated and stays —
-- consumers still need to dedupe Pub/Sub's at-least-once deliveries,
-- keyed on Pub/Sub's own messageId, regardless of how the message got
-- published.
--
--   psql "$DATABASE_URL" -f DB/migrations/018_drop_outbox_event.sql

BEGIN;

DROP INDEX IF EXISTS idx_outbox_unpublished;
DROP TABLE IF EXISTS "OutboxEvent";

COMMIT;
