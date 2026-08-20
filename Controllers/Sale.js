const crypto = require("crypto");
const pool = require("../DB/postgres");
const { formatTransactionNumber } = require("../Utils/numberingFormat");
const { publishSaleEvent } = require("../Utils/publishEvent");

// Same shape/purpose as Controllers/Purchase.js's computeItems — looks
// up every Tax row referenced by the line items in one go, validates
// each item, and returns the aggregates the header totals need. Reuses
// the same tenant-ownership scoping (registrationId) Purchase's version
// has, for the same reason: an unscoped lookup would let a crafted
// productId/taxId belonging to a different business leak into this
// sale's totals.
//
// unitPrice (not unitCost) is the per-line input here — a sale sells at
// SellingPrice, a purchase buys at CostPrice — everything else about
// the tax/discount math is identical to Purchase's.
async function computeItems(client, items, registrationId) {
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
    const unitPrice = Number(item.unitPrice);
    if (!item.productId || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) {
      return { error: "Each item needs a valid productId, qty, and unitPrice" };
    }
    if (!ownedProductIds.has(item.productId)) {
      return { error: "One or more products in this sale aren't available" };
    }
    if (item.taxId && !taxById[item.taxId]) {
      return { error: "One or more selected taxes aren't available" };
    }

    const lineDiscount = Number(item.discountAmount) || 0;
    const gross = qty * unitPrice;
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

    const lineTotal = taxInclusive ? taxableAmount : taxableAmount + taxAmount;

    subtotal += gross;
    totalQty += qty;
    lineDiscountTotal += lineDiscount;
    taxAmountTotal += taxAmount;

    preparedItems.push({
      productId: item.productId,
      qty,
      unitPrice,
      mrp: item.mrp != null ? Number(item.mrp) : null,
      discountAmount: lineDiscount,
      taxId: item.taxId || null,
      taxInclusive,
      taxableAmount,
      taxAmount,
      taxComponents: tax ? tax.Components : null,
      lineTotal,
      notes: item.notes || null,
    });
  }

  return { preparedItems, subtotal, totalQty, lineDiscountTotal, taxAmountTotal };
}

async function insertSaleItems(client, saleId, preparedItems) {
  for (const item of preparedItems) {
    await client.query(
      `INSERT INTO "SaleItem"
        ("SaleItemID", "SaleID", "ProductID", "Quantity", "UnitPrice", "MRP",
         "DiscountAmount", "TaxID", "TaxInclusive", "TaxableAmount", "TaxAmount", "TaxComponents",
         "LineTotal", "Notes")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        crypto.randomUUID(),
        saleId,
        item.productId,
        item.qty,
        item.unitPrice,
        item.mrp,
        item.discountAmount,
        item.taxId,
        item.taxInclusive,
        item.taxableAmount,
        item.taxAmount,
        item.taxComponents ? JSON.stringify(item.taxComponents) : null,
        item.lineTotal,
        item.notes,
      ]
    );
  }
}

// Creates a Sale header + its SaleItem lines in one transaction — same
// structure as Controllers/Purchase.js's createPurchase (store
// ownership check, TransactionType/DocumentSeries numbering, server-side
// tax computation, commit, then publish for posiverse-engine to apply
// the InStock deduction asynchronously). One deliberate simplification
// vs. Purchase: no partial/credit payment — every sale is recorded
// fully paid at checkout (DueAmount always 0), matching what the POS
// payment screen actually captures today. CustomerID is optional
// (walk-in sale, same as the POS screen's default).
module.exports.createSale = async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      storeId,
      customerId,
      refNo,
      transactionDate,
      notes,
      items,
      discountAmount: headerDiscount,
      additionalCharges,
      roundOff,
      paymentMethod,
    } = req.body;

    if (!storeId) return res.status(400).json({ success: false, message: "storeId is required" });
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: "At least one item is required" });
    }

    await client.query("BEGIN");

    const storeCheck = await client.query(
      `SELECT "StoreID", "StoreCode" FROM "Store" WHERE "StoreID" = $1 AND "RegistrationID" = $2`,
      [storeId, req.user.RegistrationID]
    );
    if (storeCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Store not found" });
    }
    const store = storeCheck.rows[0];

    // Customer is optional (walk-in) — only checked for tenant
    // ownership when one was actually picked.
    if (customerId) {
      const customerCheck = await client.query(
        `SELECT "CustomerID" FROM "Customer" WHERE "CustomerID" = $1 AND "RegistrationID" = $2 AND "IsActive" = true`,
        [customerId, req.user.RegistrationID]
      );
      if (customerCheck.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, message: "Customer not found" });
      }
    }

    const txnTypeResult = await client.query(
      `SELECT * FROM "TransactionType"
       WHERE "RegistrationID" = $1 AND "Code" = 'SALE' AND "IsActive" = true`,
      [req.user.RegistrationID]
    );
    if (txnTypeResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "Sales Invoice transaction type isn't set up for this business" });
    }
    const transactionType = txnTypeResult.rows[0];

    const cashRegisterResult = await client.query(
      `SELECT "Code" FROM "CashRegister" WHERE "StoreID" = $1 AND "IsActive" = true ORDER BY "CreatedAt" ASC LIMIT 1`,
      [storeId]
    );
    const defaultCashRegisterCode = cashRegisterResult.rows[0]?.Code || null;

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
    const invoiceNumber = formatTransactionNumber(transactionType.NumberingFormat, {
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

    const saleId = crypto.randomUUID();
    const saleResult = await client.query(
      `INSERT INTO "Sale"
        ("SaleID", "StoreID", "InvoiceNumber", "CustomerID", "TransactionTypeID", "SaleDate", "CashierID",
         "Subtotal", "DiscountAmount", "TaxAmount", "AdditionalCharges", "RoundOff", "TotalAmount", "TotalQty",
         "PaymentMethod", "PaymentStatus", "DueAmount", "Status", "RefNo", "Notes",
         "Action", "ActionBy", "ActionByUID", "ActionOn")
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), $7,
         $8, $9, $10, $11, $12, $13, $14,
         $15, 'paid', 0, 'completed', $16, $17,
         'NEW', $18, $19, now())
       RETURNING *`,
      [
        saleId,
        storeId,
        invoiceNumber,
        customerId || null,
        transactionType.TransactionTypeID,
        transactionDate || null,
        req.user.UserID || null,
        subtotal,
        extraDiscount,
        taxAmountTotal,
        extraCharges,
        roundOffAmount,
        totalAmount,
        totalQty,
        paymentMethod || "cash",
        refNo || null,
        notes || null,
        req.user.Name || req.user.Email || null,
        req.user.UserID || null,
      ]
    );
    const sale = saleResult.rows[0];

    await insertSaleItems(client, saleId, preparedItems);

    // No Customer.OutstandingBalance write here, and no InStock write
    // either — this endpoint only records the sale itself. The InStock
    // deduction is applied by posiverse-engine's Sale consumer, reacting
    // to the SaleCreated event published below, on its own dedicated
    // topic (kept separate from Purchase's, by explicit decision).
    await client.query("COMMIT");

    await publishSaleEvent({
      eventType: "SaleCreated",
      sale,
      items: preparedItems,
    });

    return res.json({ success: true, sale, items: preparedItems });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ success: false, message: "Error creating sale" });
  } finally {
    client.release();
  }
};

// Edits a posted (not cancelled) Sale — header fields + a wholesale
// replacement of its line items, same approach updatePurchase uses.
// InvoiceNumber/TransactionTypeID/StoreID never change on edit — this
// revises a document, it doesn't renumber or relocate it. Captures the
// pre-edit sale + items purely so publishSaleEvent can hand
// posiverse-engine's Sale consumer a real beforeData/afterData diff —
// that consumer already does per-product qty delta math (before vs.
// after), so an edit that changes quantities/items just works, the same
// way updatePurchase's PurchaseUpdated already does on the Purchase
// side.
module.exports.updateSale = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const {
      customerId,
      refNo,
      transactionDate,
      notes,
      items,
      discountAmount: headerDiscount,
      additionalCharges,
      roundOff,
      paymentMethod,
    } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: "At least one item is required" });
    }

    await client.query("BEGIN");

    const existingResult = await client.query(
      `SELECT s.* FROM "Sale" s
       JOIN "Store" st ON st."StoreID" = s."StoreID"
       WHERE s."SaleID" = $1 AND st."RegistrationID" = $2
       FOR UPDATE OF s`,
      [id, req.user.RegistrationID]
    );
    if (existingResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Sale not found" });
    }
    const existing = existingResult.rows[0];

    if (existing.Status === "cancelled") {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "Can't edit a cancelled sale" });
    }

    if (customerId) {
      const customerCheck = await client.query(
        `SELECT "CustomerID" FROM "Customer" WHERE "CustomerID" = $1 AND "RegistrationID" = $2 AND "IsActive" = true`,
        [customerId, req.user.RegistrationID]
      );
      if (customerCheck.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, message: "Customer not found" });
      }
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

    const updateResult = await client.query(
      `UPDATE "Sale"
       SET "CustomerID" = $1, "RefNo" = $2, "SaleDate" = COALESCE($3, "SaleDate"), "Notes" = $4,
           "Subtotal" = $5, "DiscountAmount" = $6, "TaxAmount" = $7, "AdditionalCharges" = $8, "RoundOff" = $9,
           "TotalAmount" = $10, "TotalQty" = $11, "PaymentMethod" = $12,
           "Action" = 'EDIT', "ActionBy" = $13, "ActionByUID" = $14, "ActionOn" = now(), "UpdatedAt" = now()
       WHERE "SaleID" = $15
       RETURNING *`,
      [
        customerId || null,
        refNo || null,
        transactionDate || null,
        notes || null,
        subtotal,
        extraDiscount,
        taxAmountTotal,
        extraCharges,
        roundOffAmount,
        totalAmount,
        totalQty,
        paymentMethod || existing.PaymentMethod || "cash",
        req.user.Name || req.user.Email || null,
        req.user.UserID || null,
        id,
      ]
    );

    // Old items captured BEFORE the delete/replace below, purely to
    // hand posiverse-engine's Sale consumer a real "what changed" diff
    // — this controller doesn't do anything with them itself.
    const oldItemsResult = await client.query(`SELECT * FROM "SaleItem" WHERE "SaleID" = $1`, [id]);
    const oldItems = oldItemsResult.rows.map(row => ({
      productId: row.ProductID,
      qty: Number(row.Quantity),
      unitPrice: Number(row.UnitPrice),
    }));

    await client.query(`DELETE FROM "SaleItem" WHERE "SaleID" = $1`, [id]);
    await insertSaleItems(client, id, preparedItems);

    await client.query("COMMIT");

    await publishSaleEvent({
      eventType: "SaleUpdated",
      sale: updateResult.rows[0],
      items: preparedItems,
      beforeSale: existing,
      beforeItems: oldItems,
    });

    return res.json({ success: true, sale: updateResult.rows[0], items: preparedItems });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ success: false, message: "Error updating sale" });
  } finally {
    client.release();
  }
};

// Cancels (voids) a posted Sale. Doesn't delete anything — Status flips
// to 'cancelled' and the InStock this sale deducted is fully restored,
// reusing the exact same before/after-delta mechanism updateSale (and
// posiverse-engine's Sale consumer) already has: publish a SaleUpdated
// event whose "after" item list is empty. The consumer computes
// before=this sale's actual quantities, after=0, and applies the
// reverse of the original deduction — no separate "SaleCancelled" event
// type or extra consumer logic needed. A cancelled sale stays visible
// in Sales/SaleView (Status shows as 'cancelled') rather than being
// hidden or deleted, same as this app's soft-delete convention
// elsewhere.
module.exports.cancelSale = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    await client.query("BEGIN");

    const existingResult = await client.query(
      `SELECT s.* FROM "Sale" s
       JOIN "Store" st ON st."StoreID" = s."StoreID"
       WHERE s."SaleID" = $1 AND st."RegistrationID" = $2
       FOR UPDATE OF s`,
      [id, req.user.RegistrationID]
    );
    if (existingResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Sale not found" });
    }
    const existing = existingResult.rows[0];

    if (existing.Status === "cancelled") {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "Sale is already cancelled" });
    }

    const existingItemsResult = await client.query(`SELECT * FROM "SaleItem" WHERE "SaleID" = $1`, [id]);
    const existingItems = existingItemsResult.rows.map(row => ({
      productId: row.ProductID,
      qty: Number(row.Quantity),
      unitPrice: Number(row.UnitPrice),
    }));

    const updateResult = await client.query(
      `UPDATE "Sale"
       SET "Status" = 'cancelled', "Action" = 'CANCEL', "ActionBy" = $1, "ActionByUID" = $2, "ActionOn" = now(), "UpdatedAt" = now()
       WHERE "SaleID" = $3
       RETURNING *`,
      [req.user.Name || req.user.Email || null, req.user.UserID || null, id]
    );

    await client.query("COMMIT");

    await publishSaleEvent({
      eventType: "SaleUpdated",
      sale: updateResult.rows[0],
      items: [],
      beforeSale: existing,
      beforeItems: existingItems,
    });

    return res.json({ success: true, sale: updateResult.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ success: false, message: "Error cancelling sale" });
  } finally {
    client.release();
  }
};

module.exports.getSales = async (req, res) => {
  try {
    const { storeId } = req.query;
    const params = [req.user.RegistrationID];
    let storeFilter = "";
    if (storeId) {
      params.push(storeId);
      storeFilter = `AND s."StoreID" = $${params.length}`;
    }

    const result = await pool.query(
      `SELECT s.*, c."Name" AS "CustomerName"
       FROM "Sale" s
       JOIN "Store" st ON st."StoreID" = s."StoreID"
       LEFT JOIN "Customer" c ON c."CustomerID" = s."CustomerID"
       WHERE st."RegistrationID" = $1 ${storeFilter}
       ORDER BY s."SaleDate" DESC`,
      params
    );

    return res.json({ success: true, sales: result.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error fetching sales" });
  }
};

module.exports.getSale = async (req, res) => {
  try {
    const { id } = req.params;

    const saleResult = await pool.query(
      `SELECT s.*, c."Name" AS "CustomerName"
       FROM "Sale" s
       JOIN "Store" st ON st."StoreID" = s."StoreID"
       LEFT JOIN "Customer" c ON c."CustomerID" = s."CustomerID"
       WHERE s."SaleID" = $1 AND st."RegistrationID" = $2`,
      [id, req.user.RegistrationID]
    );
    if (saleResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Sale not found" });
    }

    const itemsResult = await pool.query(
      `SELECT si.*, pr."Name" AS "ProductName", pr."SKU", pr."Barcode"
       FROM "SaleItem" si
       JOIN "Product" pr ON pr."ProductID" = si."ProductID"
       WHERE si."SaleID" = $1`,
      [id]
    );

    return res.json({ success: true, sale: saleResult.rows[0], items: itemsResult.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error fetching sale" });
  }
};
