-- Migration 025: Bring Sale/SaleItem up to Purchase/PurchaseItem's parity
--
-- Sale/SaleItem were dropped by migration 007 and recreated with their
-- original (2002-era) migration 002 shape when Customer was recently
-- resurrected the same way — much thinner than Purchase/PurchaseItem's
-- current shape (Purchase gained RefNo/Notes/AdditionalCharges/RoundOff/
-- TotalQty/DueAmount/Action*/TaxInclusive over time; Sale never did,
-- since it's been dead code until now). No real Sale data exists yet
-- (the POS checkout screen has never called the backend), so this is
-- purely additive and safe.
--
-- Run with:
--   psql "$DATABASE_URL" -f DB/migrations/025_add_sale_purchase_parity_fields.sql

BEGIN;

ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "RefNo" varchar(64);
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "Notes" text;
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "AdditionalCharges" numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "RoundOff" numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "TotalQty" numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "DueAmount" numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "Action" varchar(16) NOT NULL DEFAULT 'NEW';
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "ActionBy" varchar(255);
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "ActionByUID" uuid;
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "ActionOn" timestamptz NOT NULL DEFAULT now();
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "UpdatedAt" timestamptz NOT NULL DEFAULT now();

ALTER TABLE "SaleItem" ADD COLUMN IF NOT EXISTS "MRP" numeric(12,2);
ALTER TABLE "SaleItem" ADD COLUMN IF NOT EXISTS "TaxInclusive" boolean NOT NULL DEFAULT false;
ALTER TABLE "SaleItem" ADD COLUMN IF NOT EXISTS "TaxableAmount" numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "SaleItem" ADD COLUMN IF NOT EXISTS "TaxComponents" jsonb;
ALTER TABLE "SaleItem" ADD COLUMN IF NOT EXISTS "Notes" varchar(255);

COMMIT;
