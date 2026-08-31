-- 041: TransactionType gains a Kind; Inventory documents stop requiring a vendor.
--
-- Owner's decision (DEC-027). This is the foundation for letting a
-- business create its own transaction types and actually use them.
--
-- THE PROBLEM THIS SOLVES
-- A business can already create a TransactionType in Setup > Module
-- Configuration. The row saves and then nothing happens: the drawer is a
-- hardcoded list, the entry screen's fields are fixed, and the create
-- endpoint looks up `WHERE "Code" = 'PURCHASE'` regardless of what was
-- chosen. Worse, even if all of that were fixed, the document could not
-- be stored — "Inventory"."VendorID" is NOT NULL, and a stock update
-- has no vendor.
--
-- Three things are needed before any of that can be built, and all three
-- are here:
--
-- 1. "Kind" — what sort of document this is, from a closed vocabulary.
--    Module ('sales' | 'inventory') is too coarse: Purchase Entry and
--    Stock Update are both 'inventory' but need different forms and
--    different required fields. Kind is what tells the app which form to
--    open and the API which rules to enforce. A business can have
--    several types of the same Kind — "Damage write-off" and "Expiry
--    write-off" are both stock_update, with their own names and their
--    own document numbering.
--
-- 2. "VendorMandatory" — mirrors the "CustomerMandatory" that already
--    exists on this table. Whether a vendor is required becomes a
--    property of the TYPE rather than of the schema.
--
-- 3. "Inventory"."VendorID" becomes nullable, so a vendorless document
--    (a stock update) can physically exist.
--
-- >>> A TRAP THIS MIGRATION CREATES, HANDLED IN THE SAME CHANGE <<<
-- Controllers/Inventory.js's list query used an INNER JOIN on "Vendor".
-- Once VendorID is nullable, an inner join silently DROPS every
-- vendorless document from Inventory History — no error, just missing
-- rows. That query is changed to a LEFT JOIN in the same commit. Any
-- new query joining "Inventory" to "Vendor" must do the same.
--
-- KIND VOCABULARY, and which of them has a working entry screen today:
--   sale             -> SalesInvoice        (works)
--   sale_return      -> SaleReturn          (works)
--   receive_payment  -> ReceivePayment      (works)
--   purchase         -> InventoryEntry      (works)
--   purchase_return  -> InventoryEntry      (needs the flag-driven form)
--   stock_update     -> InventoryEntry      (needs the flag-driven form)
--   stock_transfer   -> none                (needs a destination store)
-- The blueprint picker must only offer kinds whose form exists, or a
-- business can create a type that opens nothing.
--
-- THE THREE DEAD ROWS
-- STOCK_IN, STOCK_OUT and STOCK_ADJUSTMENT have been seeded since
-- migration 012 and are reachable from nowhere — no screen, no menu
-- entry, no code reference outside comments. They collapse into a single
-- stock_update type per business, keeping STOCK_ADJUSTMENT's row (the
-- most general of the three) and deleting the other two. Direction is
-- set to 'out', because the overwhelmingly common manual correction is
-- removing stock (damage, theft, expiry); a business wanting the other
-- direction creates its own type. Note 'adjustment' is NOT used here:
-- posiverse-engine skips it entirely (DEC-024), so a stock update set to
-- 'adjustment' would record a document and move no stock.
--
-- SAFE TO RUN: additive columns with defaults, one DROP NOT NULL, and
-- deletes limited to two rows that provably nothing references. No
-- existing purchase is touched — every one keeps its VendorID.
--
-- TO REVERSE:
--   ALTER TABLE "Inventory" ALTER COLUMN "VendorID" SET NOT NULL;   -- fails if any vendorless document exists
--   ALTER TABLE "TransactionType" DROP CONSTRAINT IF EXISTS chk_transactiontype_kind;
--   ALTER TABLE "TransactionType" DROP COLUMN IF EXISTS "Kind";
--   ALTER TABLE "TransactionType" DROP COLUMN IF EXISTS "VendorMandatory";
-- (The deleted STOCK_IN/STOCK_OUT rows are not restored. They held no
-- data and nothing referenced them.)

BEGIN;

-- 1. A vendorless inventory document can now exist.
ALTER TABLE "Inventory" ALTER COLUMN "VendorID" DROP NOT NULL;

-- 2. Whether a vendor is required is a property of the type.
ALTER TABLE "TransactionType"
  ADD COLUMN IF NOT EXISTS "VendorMandatory" boolean NOT NULL DEFAULT false;

-- 3. Kind. Added nullable first so the backfill can run, then
--    constrained — adding it NOT NULL up front would need a default that
--    would be wrong for most rows.
ALTER TABLE "TransactionType"
  ADD COLUMN IF NOT EXISTS "Kind" varchar(32);

-- 4. Backfill Kind from the existing stable Code.
UPDATE "TransactionType" SET "Kind" = CASE "Code"
  WHEN 'SALE'             THEN 'sale'
  WHEN 'SALE_RETURN'      THEN 'sale_return'
  WHEN 'RECEIVE_PAYMENT'  THEN 'receive_payment'
  WHEN 'PURCHASE'         THEN 'purchase'
  WHEN 'PURCHASE_RETURN'  THEN 'purchase_return'
  WHEN 'STOCK_IN'         THEN 'stock_update'
  WHEN 'STOCK_OUT'        THEN 'stock_update'
  WHEN 'STOCK_ADJUSTMENT' THEN 'stock_update'
  WHEN 'STOCK_TRANSFER'   THEN 'stock_transfer'
  ELSE NULL
END
WHERE "Kind" IS NULL;

-- 5. Anything the un-validated create endpoint let through with an
--    unrecognised Code gets the most conservative kind: stock_update
--    moves stock but needs no vendor, customer or payment, so a
--    mis-typed row cannot silently behave like a sale.
UPDATE "TransactionType"
SET "Kind" = 'stock_update', "Module" = 'inventory'
WHERE "Kind" IS NULL;

ALTER TABLE "TransactionType" ALTER COLUMN "Kind" SET NOT NULL;

ALTER TABLE "TransactionType"
  ADD CONSTRAINT chk_transactiontype_kind
  CHECK ("Kind" IN ('sale', 'sale_return', 'receive_payment',
                    'purchase', 'purchase_return',
                    'stock_update', 'stock_transfer'));

-- 6. Purchases are the only kinds that need a vendor.
UPDATE "TransactionType"
SET "VendorMandatory" = true
WHERE "Kind" IN ('purchase', 'purchase_return');

-- 7. Collapse the three unreachable stock rows into one per business.
--    STOCK_ADJUSTMENT is kept because it is the most general of the
--    three; the other two are deleted. Guarded on the absence of any
--    referencing document so this can never orphan real data — if a
--    document somehow exists, the DELETE simply skips that row and the
--    foreign key stays intact.
UPDATE "TransactionType"
SET "Name" = 'Stock Update', "Direction" = 'out', "UpdateStock" = true,
    "CalculateTax" = false, "PaymentModeRequired" = false,
    "DiscountAllowed" = false, "SalesImpact" = false,
    "CustomerMandatory" = false, "VendorMandatory" = false
WHERE "Code" = 'STOCK_ADJUSTMENT';

DELETE FROM "TransactionType"
WHERE "Code" IN ('STOCK_IN', 'STOCK_OUT')
  AND NOT EXISTS (
    SELECT 1 FROM "Inventory" i
    WHERE i."TransactionTypeID" = "TransactionType"."TransactionTypeID"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "Sale" s
    WHERE s."TransactionTypeID" = "TransactionType"."TransactionTypeID"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "DocumentSeries" d
    WHERE d."TransactionTypeID" = "TransactionType"."TransactionTypeID"
  );

COMMIT;
