-- 042: give every business the standard transaction types it is missing.
--
-- THE BUG THIS FIXES
-- Migration 012 seeded eight TransactionTypes for every business that
-- existed WHEN IT RAN. Businesses created since — through the signup
-- endpoint — got only what Controllers/Registration.js seeds, which was
-- SALE, PURCHASE and RECEIVE_PAYMENT. SALE_RETURN and PURCHASE_RETURN
-- were never in that list.
--
-- The visible symptom: returning items fails with "Sales Return
-- transaction type isn't set up for this business", because
-- Controllers/Sale.js's createSaleReturn looks that type up by Code and
-- finds nothing. The Return button exists, the screen works, the
-- document simply cannot be filed.
--
-- Migration 041 had the same blind spot from the other direction: it
-- converts STOCK_ADJUSTMENT into a stock_update type, but a business
-- created after 012 never had a STOCK_ADJUSTMENT row to convert, so it
-- ends up with no way to correct stock at all.
--
-- This inserts any of the six standard types a business is missing,
-- matched on Code. A business that already has one keeps it exactly as
-- it is — including any renaming or flag changes the owner made.
-- Nothing is overwritten.
--
-- INACTIVE ROWS COUNT AS PRESENT. The NOT EXISTS check deliberately
-- ignores IsActive: a type the owner deactivated on purpose should stay
-- deactivated, not silently reappear. (Reactivating one is handled in
-- Controllers/TransactionType.js's create path — see DEC-028.)
--
-- Flags follow Utils/transactionTypeBlueprints.js. Keep the two in step:
-- this file seeds what a business starts with, that file is what the
-- picker offers.
--
-- TO REVERSE — only removes rows this migration could have added, and
-- only where nothing references them:
--   DELETE FROM "TransactionType" t
--   WHERE t."Code" IN ('SALE_RETURN','PURCHASE_RETURN','STOCK_UPDATE')
--     AND NOT EXISTS (SELECT 1 FROM "Inventory" i WHERE i."TransactionTypeID" = t."TransactionTypeID")
--     AND NOT EXISTS (SELECT 1 FROM "Sale" s WHERE s."TransactionTypeID" = t."TransactionTypeID")
--     AND NOT EXISTS (SELECT 1 FROM "DocumentSeries" d WHERE d."TransactionTypeID" = t."TransactionTypeID");

BEGIN;

INSERT INTO "TransactionType"
  ("TransactionTypeID", "RegistrationID", "Module", "Kind", "Code", "Name", "Direction",
   "CalculateTax", "CustomerMandatory", "DiscountAllowed", "PaymentModeRequired",
   "SalesImpact", "UpdateStock", "VendorMandatory", "IsActive")
SELECT
  gen_random_uuid(),
  r."RegistrationID",
  d.module,
  d.kind,
  d.code,
  d.name,
  d.direction,
  d.calculate_tax,
  d.customer_mandatory,
  d.discount_allowed,
  d.payment_mode_required,
  d.sales_impact,
  d.update_stock,
  d.vendor_mandatory,
  true
FROM "Registration" r
CROSS JOIN (
  VALUES
    -- module      kind               code               name              dir    tax    cust   disc   pay    sales  stock  vendor
    ('sales',     'sale_return',     'SALE_RETURN',     'Sales Return',    'in',  true,  false, false, true,  true,  true,  false),
    ('inventory', 'purchase_return', 'PURCHASE_RETURN', 'Purchase Return', 'out', true,  false, false, true,  false, true,  true),
    -- Direction is unread for a stock update: it SETS stock to the
    -- counted quantity, and posiverse-engine keys that on Kind rather
    -- than Direction (DEC-029, DEC-030). 'out' satisfies NOT NULL.
    ('inventory', 'stock_update',    'STOCK_UPDATE',    'Stock Update',    'out', false, false, false, false, false, true,  false)
) AS d(module, kind, code, name, direction, calculate_tax, customer_mandatory,
       discount_allowed, payment_mode_required, sales_impact, update_stock, vendor_mandatory)
WHERE NOT EXISTS (
  SELECT 1 FROM "TransactionType" t
  WHERE t."RegistrationID" = r."RegistrationID"
    AND t."Code" = d.code
);

COMMIT;
