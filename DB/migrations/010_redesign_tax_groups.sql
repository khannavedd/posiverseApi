-- Redesigns Tax from a flat "one name, one rate" row into a tax GROUP
-- that can bundle multiple components — e.g. "GST 18%" = CGST 9% +
-- SGST 9%, or a single-component IGST 18% for inter-state sales. This
-- mirrors how Indian GST invoicing actually needs to break tax down
-- per line item, and matches the reference shape the app owner
-- provided:
--
--   "Components": [
--     { "TaxName": "CGST", "TaxType": "CGST", "TaxPercentage": 9, "TaxAmount": 0, "TaxPerAmt": "" },
--     { "TaxName": "SGST", "TaxType": "SGST", "TaxPercentage": 9, "TaxAmount": 0, "TaxPerAmt": "" }
--   ]
--
-- TaxAmount/TaxPerAmt stay 0/"" in the catalog master — they're only
-- ever computed per line item at billing time (no billing screen yet,
-- but keeping the shape means no second migration when that arrives).
-- "Name" keeps its existing column name/role (the group's display
-- label, e.g. "GST 18%") rather than renaming to the reference's
-- "TaxGroup" — no reason to rename an existing column just to match a
-- field name from a different project's schema.
--
-- Deliberately skipping the audit-trail fields from the reference
-- (Action/ActionBy/ActionByEmailID/ActionByUID/BackEndUpdate/IsDeleted)
-- — this app doesn't track a change-log anywhere else yet, so adding
-- one just for Tax would be inconsistent. Revisit if that becomes a
-- project-wide pattern.
--
--   psql "$DATABASE_URL" -f DB/migrations/010_redesign_tax_groups.sql

BEGIN;

ALTER TABLE "Tax" ADD COLUMN IF NOT EXISTS "Components" jsonb;
ALTER TABLE "Tax" ADD COLUMN IF NOT EXISTS "TotalPercentage" numeric(5,2);

-- Fold any existing single-rate rows into the new shape so nothing
-- already saved just disappears.
UPDATE "Tax"
SET
  "Components" = jsonb_build_array(
    jsonb_build_object(
      'TaxName', "Name",
      'TaxType', COALESCE("Type", 'tax'),
      'TaxPercentage', "Rate",
      'TaxAmount', 0,
      'TaxPerAmt', ''
    )
  ),
  "TotalPercentage" = "Rate"
WHERE "Components" IS NULL AND "Rate" IS NOT NULL;

-- Anything left with no rate at all (shouldn't exist, but be safe)
-- gets an empty group rather than a NULL that breaks the NOT NULL
-- constraint below.
UPDATE "Tax"
SET "Components" = '[]'::jsonb, "TotalPercentage" = 0
WHERE "Components" IS NULL;

ALTER TABLE "Tax" ALTER COLUMN "Components" SET NOT NULL;
ALTER TABLE "Tax" ALTER COLUMN "TotalPercentage" SET NOT NULL;
ALTER TABLE "Tax" ALTER COLUMN "TotalPercentage" SET DEFAULT 0;

ALTER TABLE "Tax" DROP COLUMN IF EXISTS "Rate";
ALTER TABLE "Tax" DROP COLUMN IF EXISTS "Type";

COMMIT;
