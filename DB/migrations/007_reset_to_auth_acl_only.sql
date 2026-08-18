-- DESTRUCTIVE — drops every table currently in the database, then
-- recreates only the four the app actually uses right now: Registration,
-- User, Store, ACL. Everything else (Product, Sale, Category, Tax,
-- Purchase, Payment, CashRegister, etc.) is dropped and NOT recreated —
-- Catalog/Sales were removed from the app to focus on auth + ACL first.
-- If/when those come back, migrations 002+ have their definitions.
--
-- Registration/User/Store are recreated with the exact columns and
-- types confirmed via information_schema before this reset — not a
-- guess. ACL matches migration 002's definition, with UserID/GrantedBy
-- as varchar(128) (not uuid) per migration 003's fix, since Firebase
-- UIDs are strings.
--
--   psql "$DATABASE_URL" -f DB/migrations/007_reset_to_auth_acl_only.sql

BEGIN;

DROP TABLE IF EXISTS
  "ACL",
  "StockLedger",
  "SaleItem",
  "Sale",
  "PurchaseItem",
  "Purchase",
  "Payment",
  "InventoryStock",
  "CashMovement",
  "CashRegisterSession",
  "CashRegister",
  "DocumentSeries",
  "Customer",
  "Vendor",
  "Product",
  "Tax",
  "Brand",
  "Category",
  "TransactionType",
  "Store",
  "User",
  "Registration"
CASCADE;

CREATE TABLE "Registration" (
  "RegistrationID" uuid PRIMARY KEY,
  "BusinessName" varchar NOT NULL,
  "BusinessTypeID" bigint NOT NULL,
  "PlanID" bigint NOT NULL,
  "Email" varchar NOT NULL,
  "PhoneNo" varchar,
  "CountryCode" varchar,
  "SubscriptionStartOn" bigint,
  "SubscriptionEndOn" bigint,
  "IsDeleted" boolean NOT NULL DEFAULT false,
  "ActionBy" bigint,
  "ActionOn" bigint NOT NULL
);

CREATE TABLE "User" (
  "UserID" uuid PRIMARY KEY,
  "RegistrationID" uuid NOT NULL REFERENCES "Registration"("RegistrationID"),
  "UID" varchar NOT NULL UNIQUE,
  "Name" varchar NOT NULL,
  "Email" varchar NOT NULL,
  "PhoneNo" varchar,
  "IsDeleted" boolean NOT NULL DEFAULT false,
  "LastLoginOn" bigint NOT NULL,
  "ActionBy" bigint,
  "ActionOn" bigint NOT NULL
);

CREATE TABLE "Store" (
  "StoreID" uuid PRIMARY KEY,
  "RegistrationID" uuid NOT NULL REFERENCES "Registration"("RegistrationID"),
  "StoreName" varchar NOT NULL,
  "StoreCode" varchar,
  "Email" varchar,
  "PhoneNo" varchar,
  "Address1" text,
  "Address2" text,
  "City" varchar,
  "State" varchar,
  "Country" varchar,
  "Pincode" varchar,
  "Latitude" double precision,
  "Longitude" double precision,
  "GSTNo" varchar,
  "IsDeleted" boolean NOT NULL DEFAULT false,
  "ActionBy" bigint,
  "ActionOn" bigint NOT NULL
);

CREATE TABLE "ACL" (
  "ACLID" uuid PRIMARY KEY,
  "UserID" varchar(128) NOT NULL,
  "StoreID" uuid,
  "Role" varchar(32) NOT NULL,
  "Permissions" jsonb,
  "GrantedBy" varchar(128),
  "GrantedAt" timestamptz NOT NULL DEFAULT now(),
  "Status" varchar(16) NOT NULL DEFAULT 'active'
);

CREATE INDEX idx_acl_user ON "ACL"("UserID");
CREATE INDEX idx_store_registration ON "Store"("RegistrationID");
CREATE INDEX idx_user_registration ON "User"("RegistrationID");

COMMIT;
