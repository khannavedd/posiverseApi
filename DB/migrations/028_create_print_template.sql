-- New Setup entity: PrintTemplate. Lets a business edit what shows on
-- its printed Sales receipt and Purchase document — store display
-- name, header note ("Tax Invoice" / "Purchase Order"), footer
-- message, whether a signature line shows, optional terms text —
-- instead of the hardcoded strings the Sales receipt screen has always
-- used (see Modules/Sales/Screens/SalesInvoice.js) and the Purchase
-- side never had at all until now.
--
-- One row per (RegistrationID, DocumentType) — 'sale' and 'purchase'
-- are separate rows so a business can word its customer-facing receipt
-- differently from its vendor-facing purchase document. This is a
-- template/config table only: no rendering, PDF, or physical-printer
-- wiring happens here — see DEC-010.
--
--   psql "$DATABASE_URL" -f DB/migrations/028_create_print_template.sql

BEGIN;

CREATE TABLE "PrintTemplate" (
  "PrintTemplateID" uuid PRIMARY KEY,
  "RegistrationID" uuid NOT NULL,
  "DocumentType" varchar(16) NOT NULL,        -- 'sale' | 'purchase'
  "StoreDisplayName" varchar(128),            -- NULL = fall back to Store.StoreName at render time
  "ShowLogo" boolean NOT NULL DEFAULT true,
  "HeaderNote" varchar(128) NOT NULL DEFAULT '',
  "FooterMessage" varchar(255) NOT NULL DEFAULT '',
  "ShowSignatureLine" boolean NOT NULL DEFAULT true,
  "TermsText" varchar(500),
  "CreatedAt" timestamptz NOT NULL DEFAULT now(),
  "UpdatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("RegistrationID", "DocumentType")
);

CREATE INDEX idx_printtemplate_registration ON "PrintTemplate"("RegistrationID");

-- Seed one 'sale' and one 'purchase' row per existing business with the
-- same defaults the Sales receipt screen already hardcoded, so nothing
-- changes visually until someone actually edits the template.
INSERT INTO "PrintTemplate"
  ("PrintTemplateID", "RegistrationID", "DocumentType", "HeaderNote", "FooterMessage", "ShowSignatureLine")
SELECT
  ('a0000000-0000-4000-8000-' || lpad((row_number() OVER ())::text, 12, '0'))::uuid,
  r."RegistrationID",
  t.document_type,
  t.header_note,
  t.footer_message,
  true
FROM (SELECT DISTINCT "RegistrationID" FROM "User") r
CROSS JOIN (VALUES
  ('sale',     'Tax Invoice',     'THANK YOU FOR YOUR BUSINESS'),
  ('purchase', 'Purchase Order',  '')
) AS t(document_type, header_note, footer_message)
ON CONFLICT ("RegistrationID", "DocumentType") DO NOTHING;

COMMIT;
