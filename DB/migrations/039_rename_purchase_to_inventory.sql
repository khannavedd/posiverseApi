-- 039: Purchase/PurchaseItem become Inventory/InventoryItem.
--
-- Owner's decision (DEC-025). The reason is forward-looking, not
-- cosmetic: this table is the home for INVENTORY DOCUMENTS, and a
-- purchase is only one kind. Once a Stock Adjustment or Stock Transfer
-- transaction type gets an entry screen, its documents belong in the
-- same table, discriminated by "TransactionTypeID" — and finding a
-- stock adjustment inside a table called "Purchase" would be
-- misleading.
--
-- This mirrors what the sales side already does. "Sale" holds SALE,
-- SALE_RETURN and RECEIVE_PAYMENT rows, told apart by TransactionTypeID
-- (DEC-017 — the owner's own call to put receive-payment in the Sale
-- table rather than a separate one). The inventory side was the
-- asymmetry: its table was named after one transaction type instead of
-- after the module.
--
--   module 'sales'      -> "Sale"      / "SaleItem"
--   module 'inventory'  -> "Inventory" / "InventoryItem"   <- this migration
--
-- WHY "InventoryStock" IS DROPPED HERE
-- Migration 002 created "InventoryStock" (QuantityOnHand, ReorderLevel,
-- BinLocation). Migration 013 then created "InStock", which is what the
-- engine actually writes and what the app actually reads. Nothing in
-- posiverseApi, posiverse-engine or Posiverse_APP references
-- "InventoryStock" — it has been dead since 013. Leaving it while
-- introducing "Inventory" would put three similarly-named tables in the
-- schema ("Inventory", "InventoryStock", "InStock") where only two are
-- real, which is the exact confusion this migration exists to remove.
--
-- After this migration the vocabulary is unambiguous:
--   "Inventory"      — inventory DOCUMENTS (purchases today, stock
--                      adjustments and transfers later)
--   "InventoryItem"  — their line items
--   "InStock"        — current stock LEVELS per (Store, Product)
--
-- WHAT THIS MIGRATION DOES NOT DO
-- It does not make stock adjustments work. Purchase Entry still creates
-- PURCHASE documents only, because Controllers/Purchase.js hardcodes
-- Code = 'PURCHASE' and there is no adjustment entry screen. This
-- migration prepares the home; the feature is separate work.
--
-- HTTP CONTRACT IS UNCHANGED. Routes stay /purchases and responses
-- still carry "PurchaseID" — Controllers/Purchase.js aliases
-- "InventoryID" AS "PurchaseID" in its SELECTs. The mobile app needs no
-- change and no coordinated release. Deliberate: the owner asked for a
-- schema they can read, not an app-wide rename.
--
-- SAFE TO RUN: ALTER TABLE ... RENAME is a catalogue-only operation in
-- Postgres. No table rewrite, no data copied, no rows touched, and it
-- takes an ACCESS EXCLUSIVE lock for the instant it runs. Renaming a
-- table automatically carries its data, indexes, constraints and
-- foreign keys with it — the explicit index renames below are only so
-- the NAMES stop saying "purchase"; the indexes themselves would work
-- untouched either way.
--
-- TO REVERSE:
--   ALTER TABLE "Inventory" RENAME COLUMN "InventoryID" TO "PurchaseID";
--   ALTER TABLE "InventoryItem" RENAME COLUMN "InventoryItemID" TO "PurchaseItemID";
--   ALTER TABLE "InventoryItem" RENAME COLUMN "InventoryID" TO "PurchaseID";
--   ALTER TABLE "Inventory" RENAME TO "Purchase";
--   ALTER TABLE "InventoryItem" RENAME TO "PurchaseItem";
--   ALTER INDEX idx_inventory_store RENAME TO idx_purchase_store;
--   ALTER INDEX idx_inventory_vendor RENAME TO idx_purchase_vendor;
--   ALTER INDEX idx_inventory_idempotency_key RENAME TO idx_purchase_idempotency_key;
--   ALTER INDEX idx_inventoryitem_inventory RENAME TO idx_purchaseitem_purchase;
--   ALTER INDEX idx_inventoryitem_product RENAME TO idx_purchaseitem_product;
-- ("InventoryStock" is not restored — it held no data and no code has
-- referenced it since migration 013.)

BEGIN;

-- 1. Retire the dead table first, so the name is free and the schema
--    never momentarily contains both it and "Inventory".
DROP TABLE IF EXISTS "InventoryStock";

-- 2. The tables.
ALTER TABLE "Purchase" RENAME TO "Inventory";
ALTER TABLE "PurchaseItem" RENAME TO "InventoryItem";

-- 3. The key columns. The FK on "InventoryItem" follows the rename
--    automatically — Postgres tracks constraints by OID, not by name.
ALTER TABLE "Inventory" RENAME COLUMN "PurchaseID" TO "InventoryID";
ALTER TABLE "InventoryItem" RENAME COLUMN "PurchaseItemID" TO "InventoryItemID";
ALTER TABLE "InventoryItem" RENAME COLUMN "PurchaseID" TO "InventoryID";

-- 4. Index names. Purely cosmetic — but an index called
--    idx_purchase_store on a table called "Inventory" is precisely the
--    kind of leftover that makes a schema hard to trust.
ALTER INDEX IF EXISTS idx_purchase_store RENAME TO idx_inventory_store;
ALTER INDEX IF EXISTS idx_purchase_vendor RENAME TO idx_inventory_vendor;
ALTER INDEX IF EXISTS idx_purchase_idempotency_key RENAME TO idx_inventory_idempotency_key;
ALTER INDEX IF EXISTS idx_purchaseitem_purchase RENAME TO idx_inventoryitem_inventory;
ALTER INDEX IF EXISTS idx_purchaseitem_product RENAME TO idx_inventoryitem_product;

COMMIT;
