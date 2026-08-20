-- Migration 023: Add IsActive to Customer
--
-- Customer had no soft-delete support (unlike Vendor/Category/Brand/Tax/
-- Product, which all use an IsActive flag). The Customer CRUD feature
-- needs DELETE /customers/:id to soft-delete rather than hard-delete, so
-- existing Sale rows referencing a removed customer don't dangle. Default
-- true so every existing row stays visible after this migration runs.
--
-- Run with:
--   psql "$DATABASE_URL" -f DB/migrations/023_add_customer_isactive.sql

BEGIN;

ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "IsActive" boolean NOT NULL DEFAULT true;

COMMIT;
