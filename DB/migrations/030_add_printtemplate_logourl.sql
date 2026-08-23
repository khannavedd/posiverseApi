-- Adds a per-business uploaded store logo, stored as a public GCS
-- object URL — see DEC-011. Nullable: NULL means "no logo uploaded
-- yet," in which case PrintableDocument.js on the mobile app falls
-- back to the bundled app logo (Assets/logo.png), same as it did
-- before this column existed. ShowLogo (added by migration 028) still
-- governs whether a logo shows at all; LogoURL only controls *which*
-- image shows when it does.
--
--   psql "$DATABASE_URL" -f DB/migrations/030_add_printtemplate_logourl.sql

BEGIN;

ALTER TABLE "PrintTemplate" ADD COLUMN "LogoURL" varchar(512);

COMMIT;
