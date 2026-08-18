const crypto = require("crypto");
const pool = require("../DB/postgres");
const { formatTransactionNumber } = require("../Utils/numberingFormat");
const { publishPurchaseEvent } = require("../Utils/publishEvent");

// Shared by createPurchase and updatePurchase — looks up every Tax row
// referenced by the line items in one go (so each item's tax split is
// computed server-side, not trusted from the client), validates each
// item, and returns the aggregates both header totals need. Returns
// { error } instead of throwing so callers can roll back their own
// transaction and respond with a clean 400.
//
// registrationId scopes both lookups to the requesting business.
// Before this, a crafted productId/taxId belonging to a DIFFERENT
// business would still resolve — the FK on PurchaseItem only checks
// that the row exists somewhere, not that it's this tenant's — which
// would leak another business's tax rate into this purchase's totals
// and record a PurchaseItem/InStock entry against a product that
// isn't this business's. Every other lookup in this controller
// (Store, Vendor) was already scoped this way; this brings Product and
// Tax in line with that.
async function computeItems(client, items, registrationId) {
  // Deliberately NOT filtering IsActive = true here — this check is
  // about tenant ownership (can this business reference this product
  // at all), not current catalogue visibility. updatePurchase replaces
  // a purchase's items wholesale, including ones that weren't touched,
  // so requiring every referenced product to still be active would
  // block editing (e.g. just fixing a typo in Notes) any purchase that
  // contains a line for a product deactivated sometime after the
  // purchase was made — a real product this business owns, just not
  // one they'd pick again today. That's a legitimate historical
  // reference, not a security problem.
  const productIds = [...new Set(items.map(i => i.productId).filter(Boolean))];
  let ownedProductIds = new Set();
  if (productIds.length > 0) {
    const productResult = await client.query(
      `SELECT "ProductID" FROM "Product" WHERE "ProductID" = ANY($1::uuid[]) AND "RegistrationID" = $2`,
      [productIds, registrationId]
    );
    ownedProductIds = new Set(productResult.rows.map(r => r.ProductID));
  }

  const taxIds = [...new Set(items.map(i => i.taxId).filter(Boolean))];
  let taxById = {};
  if (taxIds.length > 0) {
    const taxResult = await client.query(
      `SELECT * FROM "Tax" WHERE "TaxID" = ANY($1::uuid[]) AND "RegistrationID" = $2`,
      [taxIds, registrationId]
    );
    taxById = Object.fromEntries(taxResult.rows.map(t => [t.TaxID, t]));
  }

  let subtotal = 0;
  let totalQty = 0;
  let lineDiscountTotal = 0;
  let taxAmountTotal = 0;
  const preparedItems = [];

  for (const item of items) {
    const qty = Number(item.qty);
    const unitCost = Number(item.unitCost);
    if (!item.productId || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unitCost) || unitCost < 0) {
      return { error: "Each item needs a valid productId, qty, and unitCost" };
    }
    if (!ownedProductIds.has(item.productId)) {
      return { error: "One or more products in this purchase aren't available" };
    }
    if (item.taxId && !taxById[item.taxId]) {
      return { error: "One or more selected taxes aren't available" };
    }

    const lineDiscount = Number(item.discountAmount) || 0;
    const gross = qty * unitCost;
    const taxableAmount = Math.max(gross - lineDiscount, 0);

    const tax = item.taxId ? taxById[item.taxId] : null;
    const taxInclusive = !!item.taxInclusive;
    const taxPercentage = tax ? Number(tax.TotalPercentage) || 0 : 0;

    let taxAmount = 0;
    if (tax && taxPercentage > 0) {
      taxAmount = taxInclusive
        ? taxableAmount - taxableAmount / (1 + taxPercentage / 100)
        : taxableAmount * (taxPercentage / 100);
    }

    const subTotal = taxInclusive ? taxableAmount : taxableAmount + taxAmount;

    subtotal += gross;
    totalQty += qty;
    lineDiscountTotal += lineDiscount;
    taxAmountTotal += taxAmount;

    preparedItems.push({
      productId: item.productId,
      qty,
      unitCost,
      mrp: item.mrp != null ? Number(item.mrp) : null,
      retailPrice: item.retailPrice != null ? Number(item.retailPrice) : null,
      discountAmount: lineDiscount,
      taxId: item.taxId || null,
      taxInclusive,
      taxableAmount,
      taxAmount,
      taxComponents: tax ? tax.Components : null,
      subTotal,
      notes: item.notes || null,
    });
  }

  return { preparedItems, subtotal, totalQty, lineDiscountTotal, taxAmountTotal };
}

async function insertPurchaseItems(client, purchaseId, preparedItems) {
  for (const item of preparedItems) {
    await client.query(
      `INSERT INTO "PurchaseItem"
        ("PurchaseItemID", "PurchaseID", "ProductID", "Qty", "UnitCost", "MRP", "RetailPrice",
         "DiscountAmount", "TaxID", "TaxInclusive", "TaxableAmount", "TaxAmount", "TaxComponents",
         "SubTotal", "Notes")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        crypto.randomUUID(),
        purchaseId,
        item.productId,
        item.qty,
        item.unitCost,
        item.mrp,
        item.retailPrice,
        item.discountAmount,
        item.taxId,
        item.taxInclusive,
        item.taxableAmount,
        item.taxAmount,
        item.taxComponents ? JSON.stringify(item.taxComponents) : null,
        item.subTotal,
        item.notes,
      ]
    );
  }
}

// Creates a Purchase header + its PurchaseItem lines in one transaction,
// generating the running TransactionNo off DocumentSeries. Deliberately
// does NOT touch InStock or Vendor.DueAmount here — this endpoint only
// records the purchase itself. Both of those are downstream effects of
// "a purchase happened," applied by posiverse-engine's subscribers
// reacting to the PurchaseCreated event, not computed inline as part
// of handling this request.
module.exports.createPurchase = async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      storeId,
      vendorId,
      refNo,
      transactionDate,
      notes,
      items,
      discountAmount: headerDiscount,
      additionalCharges,
      roundOff,
      paidAmount,
    } = req.body;

    if (!storeId) return res.status(400).json({ success: false, message: "storeId is required" });
    if (!vendorId) return res.status(400).json({ success: false, message: "vendorId is required" });
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: "At least one item is required" });
    }

    await client.query("BEGIN");

    // Confirm the store belongs to this business and the vendor is
    // theirs too, same ownership-scoping every other controller does.
    const storeCheck = await client.query(
      `SELECT "StoreID", "StoreCode" FROM "Store" WHERE "StoreID" = $1 AND "RegistrationID" = $2`,
      [storeId, req.user.RegistrationID]
    );
    if (storeCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Store not found" });
    }
    const store = storeCheck.rows[0];

    const vendorCheck = await client.query(
      `SELECT "VendorID" FROM "Vendor" WHERE "VendorID" = $1 AND "RegistrationID" = $2 AND "IsActive" = true`,
      [vendorId, req.user.RegistrationID]
    );
    if (vendorCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Vendor not found" });
    }

    const txnTypeResult = await client.query(
      `SELECT * FROM "TransactionType"
       WHERE "RegistrationID" = $1 AND "Code" = 'PURCHASE' AND "IsActive" = true`,
      [req.user.RegistrationID]
    );
    if (txnTypeResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "Purchase Entry transaction type isn't set up for this business" });
    }
    const transactionType = txnTypeResult.rows[0];

    // Purchase itself has no CashRegisterID (purchases aren't processed
    // at a till), but the numbering format can still reference a Cash
    // Register Code segment — this pulls the store's default register
    // purely for that formatting purpose, not as a real relationship.
    const cashRegisterResult = await client.query(
      `SELECT "Code" FROM "CashRegister" WHERE "StoreID" = $1 AND "IsActive" = true ORDER BY "CreatedAt" ASC LIMIT 1`,
      [storeId]
    );
    const defaultCashRegisterCode = cashRegisterResult.rows[0]?.Code || null;

    // Purchase numbers per-Store, not per-till (no CashRegisterID) —
    // the DocumentSeries row this locks is the store-wide one.
    let seriesResult = await client.query(
      `SELECT * FROM "DocumentSeries"
       WHERE "StoreID" = $1 AND "TransactionTypeID" = $2 AND "CashRegisterID" IS NULL
       FOR UPDATE`,
      [storeId, transactionType.TransactionTypeID]
    );

    let series;
    if (seriesResult.rows.length === 0) {
      try {
        const inserted = await client.query(
          `INSERT INTO "DocumentSeries"
            ("DocumentSeriesID", "StoreID", "TransactionTypeID", "CurrentNumber", "IsActive")
           VALUES ($1, $2, $3, 0, true)
           RETURNING *`,
          [crypto.randomUUID(), storeId, transactionType.TransactionTypeID]
        );
        series = inserted.rows[0];
      } catch (insertError) {
        // Another concurrent first-purchase for this store/type won
        // the race and already created the row — re-select (now that
        // it exists, FOR UPDATE actually locks it) instead of failing
        // this request over a race that isn't really an error.
        if (insertError.code === "23505") {
          const retry = await client.query(
            `SELECT * FROM "DocumentSeries"
             WHERE "StoreID" = $1 AND "TransactionTypeID" = $2 AND "CashRegisterID" IS NULL
             FOR UPDATE`,
            [storeId, transactionType.TransactionTypeID]
          );
          series = retry.rows[0];
        } else {
          throw insertError;
        }
      }
    } else {
      series = seriesResult.rows[0];
    }

    const nextNumber = series.CurrentNumber + 1;
    await client.query(
      `UPDATE "DocumentSeries" SET "CurrentNumber" = $1 WHERE "DocumentSeriesID" = $2`,
      [nextNumber, series.DocumentSeriesID]
    );
    const transactionNo = formatTransactionNumber(transactionType.NumberingFormat, {
      code: transactionType.Code,
      storeCode: store.StoreCode,
      cashRegisterCode: defaultCashRegisterCode,
      runningNumber: nextNumber,
    });

    const computed = await computeItems(client, items, req.user.RegistrationID);
    if (computed.error) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: computed.error });
    }
    const { preparedItems, subtotal, totalQty, lineDiscountTotal, taxAmountTotal } = computed;

    const extraDiscount = Number(headerDiscount) || 0;
    const extraCharges = Number(additionalCharges) || 0;
    const roundOffAmount = Number(roundOff) || 0;
    const totalDiscount = lineDiscountTotal + extraDiscount;
    const totalAmount = subtotal - totalDiscount + taxAmountTotal + extraCharges + roundOffAmount;

    const paid = Math.max(Number(paidAmount) || 0, 0);
    const dueAmount = Math.max(totalAmount - paid, 0);
    const paymentStatus = dueAmount <= 0 ? "paid" : paid > 0 ? "partial" : "unpaid";

    const purchaseId = crypto.randomUUID();
    const purchaseResult = await client.query(
      `INSERT INTO "Purchase"
        ("PurchaseID", "StoreID", "VendorID", "TransactionTypeID", "TransactionNo", "TransactionDate",
         "Status", "RefNo", "Notes", "Subtotal", "DiscountAmount", "TaxAmount", "AdditionalCharges",
         "RoundOff", "TotalAmount", "TotalQty", "PaymentStatus", "DueAmount",
         "Action", "ActionBy", "ActionByUID", "ActionOn")
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()),
         'completed', $7, $8, $9, $10, $11, $12,
         $13, $14, $15, $16, $17,
         'NEW', $18, $19, now())
       RETURNING *`,
      [
        purchaseId,
        storeId,
        vendorId,
        transactionType.TransactionTypeID,
        transactionNo,
        transactionDate || null,
        refNo || null,
        notes || null,
        subtotal,
        totalDiscount,
        taxAmountTotal,
        extraCharges,
        roundOffAmount,
        totalAmount,
        totalQty,
        paymentStatus,
        dueAmount,
        req.user.Name || req.user.Email || null,
        req.user.UserID || null,
      ]
    );

    await insertPurchaseItems(client, purchaseId, preparedItems);

    // No Vendor.DueAmount update here, and no InStock write either —
    // this endpoint only records the purchase itself. Both downstream
    // effects are applied by posiverse-engine's subscribers, reacting
    // to the PurchaseCreated event published below, not computed
    // inline as part of handling this request.
    await client.query("COMMIT");

    // Published straight to Pub/Sub, after commit, awaited — see
    // Utils/publishEvent.js for what this does and doesn't guarantee
    // now that there's no outbox table backstopping it.
    await publishPurchaseEvent({
      eventType: "PurchaseCreated",
      purchase: purchaseResult.rows[0],
      items: preparedItems,
    });

    return res.json({ success: true, purchase: purchaseResult.rows[0], items: preparedItems });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ success: false, message: "Error creating purchase" });
  } finally {
    client.release();
  }
};

// Edits an already-posted Purchase — header fields + a wholesale
// replacement of its line items (simpler and safer than diffing
// add/remove/change, and PurchaseItem rows have no identity outside
// their parent Purchase anyway). TransactionNo/TransactionTypeID/
// StoreID never change on edit — this revises a document, it doesn't
// renumber or relocate it. Like createPurchase, this doesn't touch
// Vendor.DueAmount or InStock itself — it captures the pre-edit
// purchase + items (below) purely so publishPurchaseEvent can hand
// posiverse-engine's subscribers a real beforeData/afterData diff to
// work from (e.g. the vendor-due subscriber needs the OLD due amount
// and vendor to reverse before applying the new one).
module.exports.updatePurchase = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const {
      vendorId,
      refNo,
      transactionDate,
      notes,
      items,
      discountAmount: headerDiscount,
      additionalCharges,
      roundOff,
      paidAmount,
    } = req.body;

    if (!vendorId) return res.status(400).json({ success: false, message: "vendorId is required" });
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: "At least one item is required" });
    }

    await client.query("BEGIN");

    const existingResult = await client.query(
      `SELECT p.* FROM "Purchase" p
       JOIN "Store" s ON s."StoreID" = p."StoreID"
       WHERE p."PurchaseID" = $1 AND s."RegistrationID" = $2
       FOR UPDATE OF p`,
      [id, req.user.RegistrationID]
    );
    if (existingResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Purchase not found" });
    }
    const existing = existingResult.rows[0];

    const vendorCheck = await client.query(
      `SELECT "VendorID" FROM "Vendor" WHERE "VendorID" = $1 AND "RegistrationID" = $2 AND "IsActive" = true`,
      [vendorId, req.user.RegistrationID]
    );
    if (vendorCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Vendor not found" });
    }

    const computed = await computeItems(client, items, req.user.RegistrationID);
    if (computed.error) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: computed.error });
    }
    const { preparedItems, subtotal, totalQty, lineDiscountTotal, taxAmountTotal } = computed;

    const extraDiscount = Number(headerDiscount) || 0;
    const extraCharges = Number(additionalCharges) || 0;
    const roundOffAmount = Number(roundOff) || 0;
    const totalDiscount = lineDiscountTotal + extraDiscount;
    const totalAmount = subtotal - totalDiscount + taxAmountTotal + extraCharges + roundOffAmount;

    const paid = Math.max(Number(paidAmount) || 0, 0);
    const newDueAmount = Math.max(totalAmount - paid, 0);
    const paymentStatus = newDueAmount <= 0 ? "paid" : paid > 0 ? "partial" : "unpaid";

    const updateResult = await client.query(
      `UPDATE "Purchase"
       SET "VendorID" = $1, "RefNo" = $2, "TransactionDate" = COALESCE($3, "TransactionDate"), "Notes" = $4,
           "Subtotal" = $5, "DiscountAmount" = $6, "TaxAmount" = $7, "AdditionalCharges" = $8, "RoundOff" = $9,
           "TotalAmount" = $10, "TotalQty" = $11, "PaymentStatus" = $12, "DueAmount" = $13,
           "Action" = 'EDIT', "ActionBy" = $14, "ActionByUID" = $15, "ActionOn" = now(), "UpdatedAt" = now()
       WHERE "PurchaseID" = $16
       RETURNING *`,
      [
        vendorId,
        refNo || null,
        transactionDate || null,
        notes || null,
        subtotal,
        totalDiscount,
        taxAmountTotal,
        extraCharges,
        roundOffAmount,
        totalAmount,
        totalQty,
        paymentStatus,
        newDueAmount,
        req.user.Name || req.user.Email || null,
        req.user.UserID || null,
        id,
      ]
    );

    // Old items captured BEFORE the delete/replace below, purely to
    // hand posiverse-engine's subscribers a real "what changed" diff —
    // this controller doesn't do anything with them itself.
    const oldItemsResult = await client.query(
      `SELECT * FROM "PurchaseItem" WHERE "PurchaseID" = $1`,
      [id]
    );
    const oldItems = oldItemsResult.rows.map(row => ({
      productId: row.ProductID,
      qty: Number(row.Qty),
      unitCost: Number(row.UnitCost),
      mrp: row.MRP != null ? Number(row.MRP) : null,
      retailPrice: row.RetailPrice != null ? Number(row.RetailPrice) : null,
    }));

    await client.query(`DELETE FROM "PurchaseItem" WHERE "PurchaseID" = $1`, [id]);
    await insertPurchaseItems(client, id, preparedItems);

    await client.query("COMMIT");

    await publishPurchaseEvent({
      eventType: "PurchaseUpdated",
      purchase: updateResult.rows[0],
      items: preparedItems,
      beforePurchase: existing,
      beforeItems: oldItems,
    });

    return res.json({ success: true, purchase: updateResult.rows[0], items: preparedItems });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ success: false, message: "Error updating purchase" });
  } finally {
    client.release();
  }
};

module.exports.getPurchases = async (req, res) => {
  try {
    const { storeId } = req.query;
    const params = [req.user.RegistrationID];
    let storeFilter = "";
    if (storeId) {
      params.push(storeId);
      storeFilter = `AND p."StoreID" = $${params.length}`;
    }

    const result = await pool.query(
      `SELECT p.*, v."Name" AS "VendorName"
       FROM "Purchase" p
       JOIN "Vendor" v ON v."VendorID" = p."VendorID"
       JOIN "Store" s ON s."StoreID" = p."StoreID"
       WHERE s."RegistrationID" = $1 ${storeFilter}
       ORDER BY p."TransactionDate" DESC`,
      params
    );

    return res.json({ success: true, purchases: result.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error fetching purchases" });
  }
};

module.exports.getPurchase = async (req, res) => {
  try {
    const { id } = req.params;

    const purchaseResult = await pool.query(
      `SELECT p.*, v."Name" AS "VendorName"
       FROM "Purchase" p
       JOIN "Vendor" v ON v."VendorID" = p."VendorID"
       JOIN "Store" s ON s."StoreID" = p."StoreID"
       WHERE p."PurchaseID" = $1 AND s."RegistrationID" = $2`,
      [id, req.user.RegistrationID]
    );
    if (purchaseResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Purchase not found" });
    }

    const itemsResult = await pool.query(
      `SELECT pi.*, pr."Name" AS "ProductName", pr."SKU", pr."Barcode"
       FROM "PurchaseItem" pi
       JOIN "Product" pr ON pr."ProductID" = pi."ProductID"
       WHERE pi."PurchaseID" = $1`,
      [id]
    );

    return res.json({ success: true, purchase: purchaseResult.rows[0], items: itemsResult.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error fetching purchase" });
  }
};
