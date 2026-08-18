-- Fixes a type mismatch from migration 002: columns meant to hold a
-- reference to a User were typed `uuid`, but "User"."UID" (used
-- everywhere in Middleware/auth.js as req.user.UID) is a Firebase UID —
-- a string, not a UUID. Inserting one into a uuid column would fail.
--
-- Safe to run: these tables were just created and are still empty, so
-- there's no data to lose by widening the column type.
--
-- Run the same way as the previous migrations:
--   psql "$DATABASE_URL" -f DB/migrations/003_fix_user_reference_columns.sql
-- or paste into the Neon SQL editor.

BEGIN;

ALTER TABLE "Sale" ALTER COLUMN "CashierID" TYPE varchar(128);
ALTER TABLE "Purchase" ALTER COLUMN "CreatedBy" TYPE varchar(128);
ALTER TABLE "StockLedger" ALTER COLUMN "CreatedBy" TYPE varchar(128);
ALTER TABLE "CashRegisterSession" ALTER COLUMN "OpenedBy" TYPE varchar(128);
ALTER TABLE "CashRegisterSession" ALTER COLUMN "ClosedBy" TYPE varchar(128);
ALTER TABLE "CashMovement" ALTER COLUMN "CreatedBy" TYPE varchar(128);
ALTER TABLE "Payment" ALTER COLUMN "CreatedBy" TYPE varchar(128);
ALTER TABLE "ACL" ALTER COLUMN "UserID" TYPE varchar(128);
ALTER TABLE "ACL" ALTER COLUMN "GrantedBy" TYPE varchar(128);

COMMIT;
