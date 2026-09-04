-- Product and Category images.
--
-- Additive and nullable: no backfill, no data migration, and every
-- existing row keeps working with no image. Safe to run against live
-- data while the old API is still serving.
--
-- WHY A URL COLUMN AND NOT A BLOB. The image itself lives in the same
-- GCS bucket the print-template logo already uses (DEC-011); this
-- stores only the public URL. Keeping binaries out of Postgres keeps
-- backups small and lets the CDN serve the bytes.
--
-- Product.ImageURL is per ROW, which means a variant carries its own.
-- That is deliberate (DEC-041): variants here are sizes AND colours, so
-- "Shoes - 42 / Black" and "Shoes - 42 / Brown" are visually different
-- things. A variant with no image of its own falls back to its parent's
-- at read time — the fallback is resolved in the app, not stored, so
-- setting a parent image later automatically covers every variant that
-- has not been given one.
--
--   psql "$DATABASE_URL" -f DB/migrations/045_product_category_images.sql

BEGIN;

ALTER TABLE "Product"  ADD COLUMN IF NOT EXISTS "ImageURL" text;
ALTER TABLE "Category" ADD COLUMN IF NOT EXISTS "ImageURL" text;

COMMIT;
