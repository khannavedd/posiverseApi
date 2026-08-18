-- Seeds the reference/lookup data that the app assumes exists but that
-- migration 002 only created empty tables for: TransactionType (global,
-- not scoped to a business), a starter Category/Brand/Tax set for the
-- Catalog, and an ACL row so the existing test user actually has a role.
--
-- Uses fixed literal UUIDs for the reference rows themselves (fine for
-- seed data — makes them predictable across environments) but pulls
-- RegistrationID/UserID/StoreID dynamically via SELECT from whatever
-- already exists, rather than assuming a specific id, since this
-- sandbox has no way to know your actual ids.
--
-- Idempotent — ON CONFLICT DO NOTHING throughout, safe to re-run.
--
-- Run the same way as the previous migrations:
--   psql "$DATABASE_URL" -f DB/migrations/004_seed_reference_data.sql

BEGIN;

-- TransactionType — matches the code list used across the Database
-- Schema doc's TransactionTypes section and Controllers/Sale.js.
INSERT INTO "TransactionType" ("TransactionTypeID", "Code", "Name", "Category", "Direction", "IsActive") VALUES
  ('10000000-0000-4000-8000-000000000001', 'SALE',             'Sale',                'sale',      'out',     true),
  ('10000000-0000-4000-8000-000000000002', 'SALE_RETURN',      'Sale Return',         'sale',      'in',      true),
  ('10000000-0000-4000-8000-000000000003', 'PURCHASE',         'Purchase',            'purchase',  'in',      true),
  ('10000000-0000-4000-8000-000000000004', 'PURCHASE_RETURN',  'Purchase Return',     'purchase',  'out',     true),
  ('10000000-0000-4000-8000-000000000005', 'STOCK_IN',         'Stock In',            'inventory', 'in',      true),
  ('10000000-0000-4000-8000-000000000006', 'STOCK_OUT',        'Stock Out',           'inventory', 'out',     true),
  ('10000000-0000-4000-8000-000000000007', 'STOCK_ADJUSTMENT', 'Stock Adjustment',    'inventory', 'neutral', true),
  ('10000000-0000-4000-8000-000000000008', 'STOCK_TRANSFER',   'Stock Transfer',      'inventory', 'neutral', true)
ON CONFLICT ("TransactionTypeID") DO NOTHING;

-- Every RegistrationID that actually exists, sourced from "User" rather
-- than a "Registration" table — this API's code only ever confirms
-- User and Store exist (Middleware/auth.js, Controllers/Auth.js);
-- whether a separate "Registration" table exists too was never
-- verified, so deriving from data we know is real avoids a migration
-- that fails outright if that table isn't there.
-- Tax — standard Indian GST slabs, seeded per existing business.
INSERT INTO "Tax" ("TaxID", "RegistrationID", "Name", "Rate", "Type", "IsActive")
SELECT
  ('20000000-0000-4000-8000-' || lpad((row_number() OVER () * 10 + 1)::text, 12, '0'))::uuid,
  r."RegistrationID",
  slab.name,
  slab.rate,
  'exclusive',
  true
FROM (SELECT DISTINCT "RegistrationID" FROM "User") r
CROSS JOIN (VALUES
  ('GST 0%', 0.00),
  ('GST 5%', 5.00),
  ('GST 12%', 12.00),
  ('GST 18%', 18.00),
  ('GST 28%', 28.00)
) AS slab(name, rate)
ON CONFLICT ("TaxID") DO NOTHING;

-- Category — a small starter set per existing business.
INSERT INTO "Category" ("CategoryID", "RegistrationID", "Name", "IsActive")
SELECT
  ('30000000-0000-4000-8000-' || lpad((row_number() OVER () * 10 + 1)::text, 12, '0'))::uuid,
  r."RegistrationID",
  cat.name,
  true
FROM (SELECT DISTINCT "RegistrationID" FROM "User") r
CROSS JOIN (VALUES
  ('General'),
  ('Groceries'),
  ('Beverages'),
  ('Household')
) AS cat(name)
ON CONFLICT ("CategoryID") DO NOTHING;

-- Brand — a small starter set per existing business.
INSERT INTO "Brand" ("BrandID", "RegistrationID", "Name", "IsActive")
SELECT
  ('40000000-0000-4000-8000-' || lpad((row_number() OVER () * 10 + 1)::text, 12, '0'))::uuid,
  r."RegistrationID",
  'Unbranded',
  true
FROM (SELECT DISTINCT "RegistrationID" FROM "User") r
ON CONFLICT ("BrandID") DO NOTHING;

-- ACL — grants every existing User an 'owner' role with no StoreID
-- (meaning: access to every store under their Registration), so ACL
-- checks have something real to resolve against. Replace with proper
-- per-user roles once user management/invites are built.
INSERT INTO "ACL" ("ACLID", "UserID", "StoreID", "Role", "GrantedAt", "Status")
SELECT
  ('50000000-0000-4000-8000-' || lpad((row_number() OVER ())::text, 12, '0'))::uuid,
  u."UID",
  NULL,
  'owner',
  now(),
  'active'
FROM "User" u
ON CONFLICT ("ACLID") DO NOTHING;

COMMIT;
