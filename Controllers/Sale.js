const crypto = require("crypto");
const pool = require("../DB/postgres");
const { formatTransactionNumber } = require("../Utils/numberingFormat");
const { publishSaleEvent } = require("../Utils/publishEvent");
const { publishAfterCommit } = require("../Utils/publishAfterCommit");

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
  // TaxID/TaxInclusive now come back too — they are the source of truth
  // for a line's tax treatment, not whatever the client sent. See the
  // override handling further down.
  let productById = {};
  if (productIds.length > 0) {
    const productResult = await client.query(
      `SELECT "ProductID", "Name", "TaxID", "TaxInclusive" FROM "Product"
       WHERE "ProductID" = ANY($1::uuid[]) AND "RegistrationID" = $2`,
      [productIds, registrationId]
    );
    ownedProductIds = new Set(productResult.rows.map(r => r.ProductID));
    productById = Object.fromEntries(productResult.rows.map(p => [p.ProductID, p]));
  }

  // Includes the taxes the *products* carry, not just any the request
  // named — a line that sends no taxId falls back to its product's tax
  // below, and that tax still has to be loaded here to be applied.
  const taxIds = [
    ...new Set([
      ...items.map(i => i.taxId),
      ...Object.values(productById).map(p => p.TaxID),
    ].filter(Boolean)),
  ];
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
  // The sum the header total is actually built from — see the return
  // below. Accumulated here rather than re-derived from subtotal/tax,
  // because only the per-line figure knows whether its tax was
  // inclusive (already inside the price) or exclusive (added on top).
  let lineTotalSum = 0;
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

    // A line's tax treatment DEFAULTS to the product's own, but the
    // request may change it — an explicit decision (see DEC-018): the
    // till needs to be able to sell the same product with different tax
    // treatment when the situation calls for it, so this is not
    // permission-gated.
    //
    // What did change is the default. Previously an omitted taxId meant
    // "no tax" and an omitted taxInclusive meant "exclusive", so a
    // client that simply didn't send them silently sold taxable goods
    // untaxed. Now anything the request doesn't state is taken from the
    // Product row, and only a value it actually sends overrides that.
    //
    // Worth knowing when reading a stored SaleItem: its TaxID/
    // TaxInclusive are a snapshot of what was applied at sale time, and
    // may legitimately differ from the product's current values —
    // either because the product was edited later, or because this line
    // was overridden.
    const product = productById[item.productId];
    const productTaxId = product?.TaxID ?? null;
    const productTaxInclusive = !!product?.TaxInclusive;

    const requestedTaxId = item.taxId === undefined ? productTaxId : (item.taxId || null);
    const requestedTaxInclusive =
      item.taxInclusive === undefined ? productTaxInclusive : !!item.taxInclusive;

    const lineDiscount = Number(item.discountAmount) || 0;
    const gross = qty * unitPrice;
    const taxableAmount = Math.max(gross - lineDiscount, 0);

    const tax = requestedTaxId ? taxById[requestedTaxId] : null;
    const taxInclusive = requestedTaxInclusive;
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
    lineTotalSum += lineTotal;

    preparedItems.push({
      productId: item.productId,
      qty,
      unitPrice,
      mrp: item.mrp != null ? Number(item.mrp) : null,
      discountAmount: lineDiscount,
      taxId: requestedTaxId,
      taxInclusive,
      taxableAmount,
      taxAmount,
      taxComponents: tax ? tax.Components : null,
      lineTotal,
      notes: item.notes || null,
    });
  }

  return { preparedItems, subtotal, totalQty, lineDiscountTotal, taxAmountTotal, lineTotalSum };
}

// The one place a header total is derived, so Sale and its line items
// can never disagree. Callers pass the lineTotalSum computeItems
// returned; everything else is header-level and applies once.
//
// Previously each caller did `subtotal - totalDiscount + taxAmountTotal`,
// which double-counted tax on every tax-INCLUSIVE line: `subtotal` is
// the gross (tax already inside, since an inclusive price contains it)
// and `taxAmountTotal` then added that same tax a second time. A 3 x
// Rs10 inclusive-5% cart stored 31.43 against line items summing to
// 30.00 — the customer was overcharged the embedded tax and the Sale
// row contradicted itself.
//
// Line-level discounts are deliberately NOT subtracted here: each
// lineTotal is already net of its own discount (taxableAmount = gross -
// lineDiscount). Only the header's own "additional discount" applies at
// this level.
//
// Sale.Subtotal and Sale.TaxAmount are still stored, but as reporting
// figures — TaxAmount is the tax extracted from inclusive prices and
// added to exclusive ones, which is what GST reporting needs. Neither
// participates in the total any more.
function deriveTotalAmount({ lineTotalSum, headerDiscount, additionalCharges, roundOff }) {
  return lineTotalSum - headerDiscount + additionalCharges + roundOff;
}

// Refuses to write a header that disagrees with its own line items.
// Cheap, runs before COMMIT, and turns any future regression in the
// totals math into a loud failure instead of silently wrong money.
// One paisa of tolerance for float representation — see the float
// reconciliation issue logged separately in the audit.
function assertTotalMatchesLines({ totalAmount, lineTotalSum, headerDiscount, additionalCharges, roundOff }) {
  const expected = lineTotalSum - headerDiscount + additionalCharges + roundOff;
  if (Math.abs(totalAmount - expected) > 0.01) {
    return {
      error: `Total mismatch: header ${totalAmount.toFixed(2)} vs line items ${expected.toFixed(2)}`,
    };
  }
  return null;
}

// Split-payment validation + the same paid/due/status derivation
// Controllers/Purchase.js's createPurchase already uses for
// paidAmount/dueAmount/paymentStatus — mirrored here rather than
// extracted into a shared helper, matching how computeItems-style logic
// is already duplicated once between these two files rather than
// factored out.
//
// Accepts either the new `payments: [{method, amount}]` array, or the
// old single `paymentMethod` string for backward compatibility with any
// caller that hasn't moved to the array shape yet — a bare string is
// treated as one tender covering the full total. Rejects (does not
// clamp) if the tendered total exceeds the sale total: the payment
// screen caps entry so this should never legitimately happen, and
// silently clamping would hide a real client bug instead of surfacing
// it. A due balance is only allowed against a real customer — a
// walk-in has no identity to collect from later.
function derivePayments({ payments, paymentMethod, totalAmount, customerId }) {
  let preparedPayments;
  if (Array.isArray(payments) && payments.length > 0) {
    preparedPayments = payments.map(p => ({
      method: typeof p.method === "string" ? p.method.trim() : "",
      amount: Number(p.amount),
    }));
  } else if (paymentMethod) {
    preparedPayments = [{ method: String(paymentMethod).trim(), amount: totalAmount }];
  } else {
    return { error: "Select a payment method" };
  }

  for (const p of preparedPayments) {
    if (!p.method || !Number.isFinite(p.amount) || p.amount <= 0) {
      return { error: "Each payment needs a valid method and amount" };
    }
  }

  const totalPaid = preparedPayments.reduce((sum, p) => sum + p.amount, 0);
  if (totalPaid > totalAmount + 0.01) {
    return { error: "Payments add up to more than the sale total" };
  }

  const dueAmount = Math.max(totalAmount - totalPaid, 0);
  if (dueAmount > 0 && !customerId) {
    return { error: "A customer is required to record a sale with an outstanding balance" };
  }

  const paymentStatus = dueAmount <= 0 ? "paid" : totalPaid > 0 ? "partial" : "unpaid";
  const paymentMethodSummary = preparedPayments.length === 1 ? preparedPayments[0].method : "Split";

  return { preparedPayments, totalPaid, dueAmount, paymentStatus, paymentMethodSummary };
}

async function insertSalePayments(client, saleId, preparedPayments) {
  for (const p of preparedPayments) {
    await client.query(
      `INSERT INTO "SalePayment" ("SalePaymentID", "SaleID", "Method", "Amount") VALUES ($1, $2, $3, $4)`,
      [crypto.randomUUID(), saleId, p.method, p.amount]
    );
  }
}

// Closes the "can you oversell" gap: before a Sale is committed, checks
// each 'goods' item's requested qty against what's actually on hand for
// this store, treating a missing InStock row as 0 (a product with no
// purchase history has never actually been received, so it isn't
// sellable — consistent with how InStock rows only ever get created by
// a Purchase in the first place). 'service' products don't carry stock
// and are skipped entirely.
//
// existingItems (only passed by updateSale) lets an edit compare
// against this sale's own current holding, not just raw InStockQty —
// InStockQty already reflects this sale's ORIGINAL deduction (assuming
// posiverse-engine has processed it by now), so the real ceiling for an
// edit is InStockQty + whatever this sale already holds of that
// product, not InStockQty alone (which would wrongly block someone
// editing a sale without changing its quantities at all).
//
// This is a synchronous PRE-CHECK only — actual deduction still happens
// asynchronously via posiverse-engine after commit. It closes the
// realistic "rang up more than what's on the shelf" case, but does NOT
// fully close a true race between two concurrent sales of the very last
// unit landing in the same instant (that would need the deduction
// itself to happen synchronously and row-locked — a bigger change,
// deliberately not done here; see DECISIONS.md).
async function assertStockAvailable(client, storeId, preparedItems, existingItems = []) {
  const requestedByProduct = new Map();
  for (const item of preparedItems) {
    requestedByProduct.set(item.productId, (requestedByProduct.get(item.productId) || 0) + item.qty);
  }
  if (requestedByProduct.size === 0) return null;

  const existingByProduct = new Map();
  for (const item of existingItems) {
    existingByProduct.set(item.productId, (existingByProduct.get(item.productId) || 0) + (Number(item.qty) || 0));
  }

  const productIds = [...requestedByProduct.keys()];
  const stockResult = await client.query(
    `SELECT pr."ProductID", pr."Name", pr."ProductType", COALESCE(i."InStockQty", 0) AS "InStockQty"
     FROM "Product" pr
     LEFT JOIN "InStock" i ON i."ProductID" = pr."ProductID" AND i."StoreID" = $2
     WHERE pr."ProductID" = ANY($1::uuid[])`,
    [productIds, storeId]
  );

  for (const row of stockResult.rows) {
    if (row.ProductType !== "goods") continue; // services carry no stock
    const requested = requestedByProduct.get(row.ProductID) || 0;
    const alreadyHeld = existingByProduct.get(row.ProductID) || 0;
    const available = Number(row.InStockQty) + alreadyHeld;
    if (requested > available) {
      return { error: `Not enough stock for "${row.Name}" — ${available} available, ${requested} requested` };
    }
  }
  return null;
}

// Re-reads a sale previously created under this idempotency key, in the
// same shape createSale's success response has, so a retry is
// indistinguishable from the original call apart from the
// `idempotentReplay` flag.
//
// Returns null when the key has never been seen, which is the signal to
// go ahead and create the sale.
async function returnExistingSale(client, storeId, idempotencyKey) {
  const existing = await client.query(
    `SELECT * FROM "Sale" WHERE "StoreID" = $1 AND "IdempotencyKey" = $2`,
    [storeId, idempotencyKey]
  );
  if (existing.rows.length === 0) return null;

  const sale = existing.rows[0];
  const items = await client.query(
    `SELECT si.*, pr."Name" AS "ProductName", pr."SKU", pr."Barcode"
     FROM "SaleItem" si
     JOIN "Product" pr ON pr."ProductID" = si."ProductID"
     WHERE si."SaleID" = $1`,
    [sale.SaleID]
  );
  return { success: true, sale, items: items.rows };
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
      payments,
    } = req.body;

    if (!storeId) return res.status(400).json({ success: false, message: "storeId is required" });
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: "At least one item is required" });
    }

    // One key per checkout attempt, reused across retries of that
    // attempt — see migration 034. Optional: a caller that doesn't send
    // it gets the old unprotected behaviour rather than being refused,
    // so an older app build keeps working.
    const idempotencyKey = req.headers["idempotency-key"] || null;

    // Fast path — the common retry, where the original request already
    // finished and committed. The unique index below is what makes this
    // actually safe (this check alone would be a check-then-act race);
    // this just avoids doing all the work again in the usual case.
    if (idempotencyKey) {
      const replay = await returnExistingSale(client, storeId, idempotencyKey);
      if (replay) return res.json({ ...replay, idempotentReplay: true });
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
    const { preparedItems, subtotal, totalQty, taxAmountTotal, lineTotalSum } = computed;

    const stockCheck = await assertStockAvailable(client, storeId, preparedItems);
    if (stockCheck?.error) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: stockCheck.error });
    }

    const extraDiscount = Number(headerDiscount) || 0;
    const extraCharges = Number(additionalCharges) || 0;
    const roundOffAmount = Number(roundOff) || 0;
    const totalAmount = deriveTotalAmount({
      lineTotalSum,
      headerDiscount: extraDiscount,
      additionalCharges: extraCharges,
      roundOff: roundOffAmount,
    });

    const totalCheck = assertTotalMatchesLines({
      totalAmount,
      lineTotalSum,
      headerDiscount: extraDiscount,
      additionalCharges: extraCharges,
      roundOff: roundOffAmount,
    });
    if (totalCheck?.error) {
      await client.query("ROLLBACK");
      console.error("createSale:", totalCheck.error);
      return res.status(500).json({ success: false, message: "Sale totals didn't balance — nothing was saved." });
    }

    const paymentResult = derivePayments({ payments, paymentMethod, totalAmount, customerId });
    if (paymentResult.error) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: paymentResult.error });
    }
    const { preparedPayments, dueAmount, paymentStatus, paymentMethodSummary } = paymentResult;

    const saleId = crypto.randomUUID();
    const saleResult = await client.query(
      `INSERT INTO "Sale"
        ("SaleID", "StoreID", "InvoiceNumber", "CustomerID", "TransactionTypeID", "SaleDate", "CashierID",
         "Subtotal", "DiscountAmount", "TaxAmount", "AdditionalCharges", "RoundOff", "TotalAmount", "TotalQty",
         "PaymentMethod", "PaymentStatus", "DueAmount", "Status", "RefNo", "Notes",
         "Action", "ActionBy", "ActionByUID", "ActionOn", "IdempotencyKey")
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), $7,
         $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, 'completed', $18, $19,
         'NEW', $20, $21, now(), $22)
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
        paymentMethodSummary,
        paymentStatus,
        dueAmount,
        refNo || null,
        notes || null,
        req.user.Name || req.user.Email || null,
        req.user.UserID || null,
        idempotencyKey,
      ]
    );
    const sale = saleResult.rows[0];

    await insertSaleItems(client, saleId, preparedItems);
    await insertSalePayments(client, saleId, preparedPayments);

    // No Customer.OutstandingBalance write here, and no InStock write
    // either — this endpoint only records the sale itself. The InStock
    // deduction, and now the Customer.OutstandingBalance adjustment for
    // any dueAmount above, are both applied by posiverse-engine,
    // reacting to the SaleCreated event published below (see
    // onSaleCreateUpdateInStock.js and the new customerDue.js).
    await client.query("COMMIT");

    const synced = await publishAfterCommit(
      () => publishSaleEvent({ eventType: "SaleCreated", sale, items: preparedItems }),
      `SaleCreated for invoice ${sale.InvoiceNumber} (SaleID ${sale.SaleID})`
    );

    return res.json({ success: true, sale, items: preparedItems, stockSyncPending: !synced });
  } catch (error) {
    await client.query("ROLLBACK");

    // Two retries of the same checkout arriving close enough together
    // that both passed the pre-check above and both tried to insert.
    // The unique index on ("StoreID","IdempotencyKey") let exactly one
    // through; this is the loser, so hand back the winner's sale rather
    // than reporting a failure for a sale that demonstrably exists.
    // This — not the pre-check — is what actually makes retries safe.
    if (error.code === "23505" && error.constraint === "idx_sale_idempotency_key") {
      const key = req.headers["idempotency-key"];
      const winner = await returnExistingSale(client, req.body.storeId, key);
      if (winner) return res.json({ ...winner, idempotentReplay: true });
    }

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
      payments,
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
    const { preparedItems, subtotal, totalQty, taxAmountTotal, lineTotalSum } = computed;

    // Fetched here (before the replace below) so assertStockAvailable
    // can compare against what THIS sale already holds, not just raw
    // InStockQty — also reused further down as beforeItems for
    // publishSaleEvent's diff, same row set either way.
    const oldItemsResult = await client.query(`SELECT * FROM "SaleItem" WHERE "SaleID" = $1`, [id]);
    const oldItems = oldItemsResult.rows.map(row => ({
      productId: row.ProductID,
      qty: Number(row.Quantity),
      unitPrice: Number(row.UnitPrice),
    }));

    const stockCheck = await assertStockAvailable(client, existing.StoreID, preparedItems, oldItems);
    if (stockCheck?.error) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: stockCheck.error });
    }

    const extraDiscount = Number(headerDiscount) || 0;
    const extraCharges = Number(additionalCharges) || 0;
    const roundOffAmount = Number(roundOff) || 0;
    const totalAmount = deriveTotalAmount({
      lineTotalSum,
      headerDiscount: extraDiscount,
      additionalCharges: extraCharges,
      roundOff: roundOffAmount,
    });

    const totalCheck = assertTotalMatchesLines({
      totalAmount,
      lineTotalSum,
      headerDiscount: extraDiscount,
      additionalCharges: extraCharges,
      roundOff: roundOffAmount,
    });
    if (totalCheck?.error) {
      await client.query("ROLLBACK");
      console.error("updateSale:", totalCheck.error);
      return res.status(500).json({ success: false, message: "Sale totals didn't balance — nothing was saved." });
    }

    // Resolved the same way the UPDATE below actually writes CustomerID
    // (customerId || null — an edit that omits it clears the customer,
    // same pre-existing behavior as before this change), so the due-
    // amount-needs-a-customer check matches what's really being saved.
    const resolvedCustomerId = customerId || null;
    const paymentResult = derivePayments({
      payments,
      paymentMethod: paymentMethod || existing.PaymentMethod,
      totalAmount,
      customerId: resolvedCustomerId,
    });
    if (paymentResult.error) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: paymentResult.error });
    }
    const { preparedPayments, dueAmount, paymentStatus, paymentMethodSummary } = paymentResult;

    const updateResult = await client.query(
      `UPDATE "Sale"
       SET "CustomerID" = $1, "RefNo" = $2, "SaleDate" = COALESCE($3, "SaleDate"), "Notes" = $4,
           "Subtotal" = $5, "DiscountAmount" = $6, "TaxAmount" = $7, "AdditionalCharges" = $8, "RoundOff" = $9,
           "TotalAmount" = $10, "TotalQty" = $11, "PaymentMethod" = $12, "PaymentStatus" = $13, "DueAmount" = $14,
           "Action" = 'EDIT', "ActionBy" = $15, "ActionByUID" = $16, "ActionOn" = now(), "UpdatedAt" = now()
       WHERE "SaleID" = $17
       RETURNING *`,
      [
        resolvedCustomerId,
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
        paymentMethodSummary,
        paymentStatus,
        dueAmount,
        req.user.Name || req.user.Email || null,
        req.user.UserID || null,
        id,
      ]
    );

    // oldItems (this sale's pre-edit lines) was already captured above,
    // before assertStockAvailable ran — reused here as-is for
    // publishSaleEvent's before/after diff.
    await client.query(`DELETE FROM "SaleItem" WHERE "SaleID" = $1`, [id]);
    await insertSaleItems(client, id, preparedItems);

    await client.query(`DELETE FROM "SalePayment" WHERE "SaleID" = $1`, [id]);
    await insertSalePayments(client, id, preparedPayments);

    await client.query("COMMIT");

    const synced = await publishAfterCommit(
      () => publishSaleEvent({
        eventType: "SaleUpdated",
        sale: updateResult.rows[0],
        items: preparedItems,
        beforeSale: existing,
        beforeItems: oldItems,
      }),
      `SaleUpdated for invoice ${existing.InvoiceNumber} (SaleID ${id})`
    );

    return res.json({ success: true, sale: updateResult.rows[0], items: preparedItems, stockSyncPending: !synced });
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

    // DueAmount zeroed alongside Status — a cancelled sale no longer
    // owes anything, and this is what lets the delta math below (and
    // posiverse-engine's customerDue consumer, reading this same
    // before/after diff) correctly reverse whatever this sale had
    // contributed to Customer.OutstandingBalance. Same idea as items:
    // [] below already reversing the InStock deduction.
    const updateResult = await client.query(
      `UPDATE "Sale"
       SET "Status" = 'cancelled', "DueAmount" = 0, "Action" = 'CANCEL', "ActionBy" = $1, "ActionByUID" = $2, "ActionOn" = now(), "UpdatedAt" = now()
       WHERE "SaleID" = $3
       RETURNING *`,
      [req.user.Name || req.user.Email || null, req.user.UserID || null, id]
    );

    await client.query("COMMIT");

    const synced = await publishAfterCommit(
      () => publishSaleEvent({
        eventType: "SaleUpdated",
        sale: updateResult.rows[0],
        items: [],
        beforeSale: existing,
        beforeItems: existingItems,
      }),
      `SaleUpdated (cancel) for invoice ${existing.InvoiceNumber} (SaleID ${id})`
    );

    return res.json({ success: true, sale: updateResult.rows[0], stockSyncPending: !synced });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ success: false, message: "Error cancelling sale" });
  } finally {
    client.release();
  }
};

// Recording a payment against a customer's outstanding balance IS a
// Sale — same table, same DocumentSeries numbering, same split-tender
// machinery (SalePayment via insertSalePayments), just under the
// "RECEIVE_PAYMENT" TransactionType instead of "SALE", and with no line
// items (there's nothing being sold). This is a deliberate choice over
// a bespoke ledger table: it gets a real document number, shows up
// wherever Sales are listed, and — for free — can be edited/cancelled
// through the exact same `PUT /sales/:id` / `PUT /sales/:id/cancel`
// endpoints any other Sale already has, no new code needed for that.
//
// Unlike createSale, TotalAmount isn't computed from items/tax/discount
// — there's nothing to derive it from, so it simply IS the sum of the
// tendered payments. DueAmount is always 0 and PaymentStatus always
// 'paid' — a payment record can't itself be "partially paid"; if less
// was collected than intended, that's just a smaller payment amount,
// not a due balance on the payment itself.
//
// posiverse-engine's customerDue consumer tells this apart from a
// regular sale by TransactionType.Code, and applies the OPPOSITE sign
// to Customer.OutstandingBalance — a regular sale's DueAmount adds to
// what's owed, this sale's TotalAmount subtracts from it.
module.exports.recordCustomerPayment = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id: customerId } = req.params;
    const { storeId, payments, refNo, notes, transactionDate } = req.body;

    if (!storeId) return res.status(400).json({ success: false, message: "storeId is required" });
    if (!Array.isArray(payments) || payments.length === 0) {
      return res.status(400).json({ success: false, message: "At least one payment is required" });
    }

    const preparedPayments = payments.map(p => ({
      method: typeof p.method === "string" ? p.method.trim() : "",
      amount: Number(p.amount),
    }));
    for (const p of preparedPayments) {
      if (!p.method || !Number.isFinite(p.amount) || p.amount <= 0) {
        return res.status(400).json({ success: false, message: "Each payment needs a valid method and amount" });
      }
    }
    const totalAmount = preparedPayments.reduce((sum, p) => sum + p.amount, 0);

    // A payment IS a Sale row (RECEIVE_PAYMENT type — see DEC-017), so
    // it reuses Sale.IdempotencyKey and the index migration 034 already
    // created; no separate column is needed. Without this a retried
    // payment would double-credit the customer's balance.
    const idempotencyKey = req.headers["idempotency-key"] || null;

    if (idempotencyKey) {
      const replay = await returnExistingSale(client, storeId, idempotencyKey);
      if (replay) return res.json({ success: true, sale: replay.sale, idempotentReplay: true });
    }

    await client.query("BEGIN");

    const customerCheck = await client.query(
      `SELECT "CustomerID" FROM "Customer" WHERE "CustomerID" = $1 AND "RegistrationID" = $2 AND "IsActive" = true`,
      [customerId, req.user.RegistrationID]
    );
    if (customerCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Customer not found" });
    }

    const storeCheck = await client.query(
      `SELECT "StoreID", "StoreCode" FROM "Store" WHERE "StoreID" = $1 AND "RegistrationID" = $2`,
      [storeId, req.user.RegistrationID]
    );
    if (storeCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Store not found" });
    }
    const store = storeCheck.rows[0];

    const txnTypeResult = await client.query(
      `SELECT * FROM "TransactionType"
       WHERE "RegistrationID" = $1 AND "Code" = 'RECEIVE_PAYMENT' AND "IsActive" = true`,
      [req.user.RegistrationID]
    );
    if (txnTypeResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "Receive Payment transaction type isn't set up for this business" });
    }
    const transactionType = txnTypeResult.rows[0];

    const cashRegisterResult = await client.query(
      `SELECT "Code" FROM "CashRegister" WHERE "StoreID" = $1 AND "IsActive" = true ORDER BY "CreatedAt" ASC LIMIT 1`,
      [storeId]
    );
    const defaultCashRegisterCode = cashRegisterResult.rows[0]?.Code || null;

    // Same series lookup/lock/increment pattern as createSale, scoped
    // to this TransactionType so "Receive Payment" gets its own running
    // number sequence, independent of Sales Invoice's.
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
    const paymentNumber = formatTransactionNumber(transactionType.NumberingFormat, {
      code: transactionType.Code,
      storeCode: store.StoreCode,
      cashRegisterCode: defaultCashRegisterCode,
      runningNumber: nextNumber,
    });

    const saleId = crypto.randomUUID();
    const saleResult = await client.query(
      `INSERT INTO "Sale"
        ("SaleID", "StoreID", "InvoiceNumber", "CustomerID", "TransactionTypeID", "SaleDate", "CashierID",
         "Subtotal", "DiscountAmount", "TaxAmount", "AdditionalCharges", "RoundOff", "TotalAmount", "TotalQty",
         "PaymentMethod", "PaymentStatus", "DueAmount", "Status", "RefNo", "Notes",
         "Action", "ActionBy", "ActionByUID", "ActionOn", "IdempotencyKey")
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), $7,
         $8, 0, 0, 0, 0, $8, 0,
         $9, 'paid', 0, 'completed', $10, $11,
         'NEW', $12, $13, now(), $14)
       RETURNING *`,
      [
        saleId,
        storeId,
        paymentNumber,
        customerId,
        transactionType.TransactionTypeID,
        transactionDate || null,
        req.user.UserID || null,
        totalAmount,
        preparedPayments.length === 1 ? preparedPayments[0].method : "Split",
        refNo || null,
        notes || null,
        req.user.Name || req.user.Email || null,
        req.user.UserID || null,
        idempotencyKey,
      ]
    );
    const sale = saleResult.rows[0];

    // No insertSaleItems call — a payment collection has no line items.
    await insertSalePayments(client, saleId, preparedPayments);

    await client.query("COMMIT");

    const synced = await publishAfterCommit(
      () => publishSaleEvent({ eventType: "SaleCreated", sale, items: [] }),
      `SaleCreated (customer payment) ${sale.InvoiceNumber} for CustomerID ${customerId}`
    );

    return res.json({ success: true, sale, balanceSyncPending: !synced });
  } catch (error) {
    await client.query("ROLLBACK");

    // Concurrent retries of the same payment — same reasoning as
    // createSale's; the unique index is what actually guarantees one.
    if (error.code === "23505" && error.constraint === "idx_sale_idempotency_key") {
      const key = req.headers["idempotency-key"];
      const winner = await returnExistingSale(client, req.body.storeId, key);
      if (winner) return res.json({ success: true, sale: winner.sale, idempotentReplay: true });
    }

    console.error(error);
    return res.status(500).json({ success: false, message: "Error recording payment" });
  } finally {
    client.release();
  }
};

// Payment history for one customer — every Sale under the
// "RECEIVE_PAYMENT" TransactionType for this CustomerID, newest first.
// Cancelled ones stay in the list (Status shows 'cancelled') rather
// than being filtered out, same convention SaleView already uses for
// regular sales — the customerDue consumer already excludes a
// cancelled payment's amount from OutstandingBalance, so showing it
// here too is just an honest record, not a double-count risk.
module.exports.getCustomerPayments = async (req, res) => {
  try {
    const { id } = req.params;

    const customerCheck = await pool.query(
      `SELECT "CustomerID" FROM "Customer" WHERE "CustomerID" = $1 AND "RegistrationID" = $2`,
      [id, req.user.RegistrationID]
    );
    if (customerCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }

    const result = await pool.query(
      `SELECT s.* FROM "Sale" s
       JOIN "TransactionType" tt ON tt."TransactionTypeID" = s."TransactionTypeID"
       WHERE s."CustomerID" = $1 AND tt."Code" = 'RECEIVE_PAYMENT'
       ORDER BY s."SaleDate" DESC`,
      [id]
    );

    return res.json({ success: true, payments: result.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error fetching payments" });
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

    // Itemized tender breakdown — only meaningfully different from
    // sale.PaymentMethod when that field reads "Split" (see
    // derivePayments), but always returned so SaleView doesn't need a
    // second round-trip.
    const paymentsResult = await pool.query(
      `SELECT * FROM "SalePayment" WHERE "SaleID" = $1 ORDER BY "CreatedAt" ASC`,
      [id]
    );

    // Returns already recorded against this sale, so the client can
    // show what's left returnable and SaleView can say "partly
    // returned" rather than looking untouched.
    const returnsResult = await pool.query(
      `SELECT s."SaleID", s."InvoiceNumber", s."SaleDate", s."TotalAmount", s."Status",
              si."ProductID", si."Quantity"
       FROM "Sale" s
       JOIN "SaleItem" si ON si."SaleID" = s."SaleID"
       WHERE s."ReturnOfSaleID" = $1 AND s."Status" != 'cancelled'`,
      [id]
    );

    // Collapsed to "how much of each product has come back", which is
    // the shape the Return screen actually needs to cap its inputs.
    const returnedByProduct = {};
    for (const row of returnsResult.rows) {
      returnedByProduct[row.ProductID] = (returnedByProduct[row.ProductID] || 0) + Number(row.Quantity);
    }

    return res.json({
      success: true,
      sale: saleResult.rows[0],
      items: itemsResult.rows,
      payments: paymentsResult.rows,
      returnedByProduct,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error fetching sale" });
  }
};

// Records a return against a posted sale.
//
// A return is an ordinary "Sale" row under the SALE_RETURN
// TransactionType — the same modelling choice DEC-017 made for Receive
// Payment. That buys a lot for free:
//   * Direction 'in' on that type means posiverse-engine's existing
//     InStock consumer ADDS the returned quantities back with no code
//     change at all.
//   * Its own SaleItem rows carry per-product quantities, so a partial
//     return (1 of 3) is just a return document with smaller lines.
//   * It gets a real DocumentSeries number and shows up wherever sales
//     do.
//
// Settlement is one of two, and the difference is only in how the money
// is recorded:
//   "refund"  — a SalePayment row on the return. Cash back out of the
//               drawer. The only option for a walk-in, since there's no
//               account to credit.
//   "credit"  — no payment row; the return's TotalAmount reduces the
//               customer's OutstandingBalance instead (applied by
//               posiverse-engine's customerDue consumer). Requires a
//               customer. If they owed nothing they end up in credit,
//               which the app already renders as "In credit".
module.exports.createSaleReturn = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { items, settlement, refundMethod, notes } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: "Pick at least one item to return" });
    }
    if (!["refund", "credit"].includes(settlement)) {
      return res.status(400).json({ success: false, message: "settlement must be 'refund' or 'credit'" });
    }

    const idempotencyKey = req.headers["idempotency-key"] || null;

    await client.query("BEGIN");

    // Lock the original sale for the duration — the over-return guard
    // below reads what's already been returned against it, and without
    // this two concurrent returns could each see the same "already
    // returned" figure and together exceed what was sold.
    const originalResult = await client.query(
      `SELECT s.* FROM "Sale" s
       JOIN "Store" st ON st."StoreID" = s."StoreID"
       WHERE s."SaleID" = $1 AND st."RegistrationID" = $2
       FOR UPDATE OF s`,
      [id, req.user.RegistrationID]
    );
    if (originalResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Sale not found" });
    }
    const original = originalResult.rows[0];

    if (original.Status === "cancelled") {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "This sale was cancelled — there's nothing to return." });
    }

    if (idempotencyKey) {
      const replay = await returnExistingSale(client, original.StoreID, idempotencyKey);
      if (replay) {
        await client.query("ROLLBACK");
        return res.json({ ...replay, idempotentReplay: true });
      }
    }

    if (settlement === "credit" && !original.CustomerID) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "This was a walk-in sale — there's no account to credit. Refund it instead.",
      });
    }

    // What was originally sold, and what has already come back.
    const soldResult = await client.query(`SELECT * FROM "SaleItem" WHERE "SaleID" = $1`, [id]);
    const soldByProduct = {};
    for (const row of soldResult.rows) {
      soldByProduct[row.ProductID] = {
        qty: (soldByProduct[row.ProductID]?.qty || 0) + Number(row.Quantity),
        unitPrice: Number(row.UnitPrice),
        discountAmount: Number(row.DiscountAmount) || 0,
        taxId: row.TaxID,
        taxInclusive: row.TaxInclusive,
      };
    }

    const priorResult = await client.query(
      `SELECT si."ProductID", SUM(si."Quantity") AS qty
       FROM "Sale" s JOIN "SaleItem" si ON si."SaleID" = s."SaleID"
       WHERE s."ReturnOfSaleID" = $1 AND s."Status" != 'cancelled'
       GROUP BY si."ProductID"`,
      [id]
    );
    const alreadyReturned = Object.fromEntries(priorResult.rows.map(r => [r.ProductID, Number(r.qty)]));

    // Build the return's line items from the ORIGINAL sale's prices, not
    // from anything the request sends. A refund must be for what was
    // actually charged — letting the client state a price would let a
    // return refund more than the sale collected.
    const returnItems = [];
    for (const item of items) {
      const qty = Number(item.qty);
      const sold = soldByProduct[item.productId];

      if (!sold) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: "That item wasn't on this sale." });
      }
      if (!Number.isFinite(qty) || qty <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: "Each returned item needs a quantity above zero." });
      }

      const returnable = sold.qty - (alreadyReturned[item.productId] || 0);
      if (qty > returnable) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          message:
            returnable <= 0
              ? "That item has already been fully returned."
              : `Only ${returnable} of that item can still be returned.`,
        });
      }

      // The line's discount is pro-rated across the returned quantity,
      // so returning 1 of 3 discounted units refunds a third of that
      // line's discount rather than the full undiscounted price.
      returnItems.push({
        productId: item.productId,
        qty,
        unitPrice: sold.unitPrice,
        discountAmount: (sold.discountAmount / sold.qty) * qty,
        taxId: sold.taxId,
        taxInclusive: sold.taxInclusive,
      });
    }

    // Reuse computeItems so the return's tax/line math is identical to
    // the sale's — same function, same rounding, no second
    // implementation to drift.
    const computed = await computeItems(
      client,
      returnItems.map(r => ({
        productId: r.productId,
        qty: r.qty,
        unitPrice: r.unitPrice,
        discountAmount: r.discountAmount,
        taxId: r.taxId,
        taxInclusive: r.taxInclusive,
      })),
      req.user.RegistrationID
    );
    if (computed.error) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: computed.error });
    }
    const { preparedItems, subtotal, totalQty, taxAmountTotal, lineTotalSum } = computed;

    const totalAmount = deriveTotalAmount({
      lineTotalSum,
      headerDiscount: 0,
      additionalCharges: 0,
      roundOff: 0,
    });

    const totalCheck = assertTotalMatchesLines({
      totalAmount,
      lineTotalSum,
      headerDiscount: 0,
      additionalCharges: 0,
      roundOff: 0,
    });
    if (totalCheck?.error) {
      await client.query("ROLLBACK");
      console.error("createSaleReturn:", totalCheck.error);
      return res.status(500).json({ success: false, message: "Return totals didn't balance — nothing was saved." });
    }

    const txnTypeResult = await client.query(
      `SELECT * FROM "TransactionType"
       WHERE "RegistrationID" = $1 AND "Code" = 'SALE_RETURN' AND "IsActive" = true`,
      [req.user.RegistrationID]
    );
    if (txnTypeResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "Sales Return transaction type isn't set up for this business" });
    }
    const transactionType = txnTypeResult.rows[0];

    const storeResult = await client.query(`SELECT "StoreCode" FROM "Store" WHERE "StoreID" = $1`, [original.StoreID]);
    const cashRegisterResult = await client.query(
      `SELECT "Code" FROM "CashRegister" WHERE "StoreID" = $1 AND "IsActive" = true ORDER BY "CreatedAt" ASC LIMIT 1`,
      [original.StoreID]
    );

    // Same lock/increment/format sequence createSale uses, against this
    // type's own series so returns number independently of invoices.
    let seriesResult = await client.query(
      `SELECT * FROM "DocumentSeries"
       WHERE "StoreID" = $1 AND "TransactionTypeID" = $2 AND "CashRegisterID" IS NULL
       FOR UPDATE`,
      [original.StoreID, transactionType.TransactionTypeID]
    );
    let series;
    if (seriesResult.rows.length === 0) {
      try {
        const inserted = await client.query(
          `INSERT INTO "DocumentSeries"
            ("DocumentSeriesID", "StoreID", "TransactionTypeID", "CurrentNumber", "IsActive")
           VALUES ($1, $2, $3, 0, true) RETURNING *`,
          [crypto.randomUUID(), original.StoreID, transactionType.TransactionTypeID]
        );
        series = inserted.rows[0];
      } catch (insertError) {
        if (insertError.code === "23505") {
          const retry = await client.query(
            `SELECT * FROM "DocumentSeries"
             WHERE "StoreID" = $1 AND "TransactionTypeID" = $2 AND "CashRegisterID" IS NULL
             FOR UPDATE`,
            [original.StoreID, transactionType.TransactionTypeID]
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
    await client.query(`UPDATE "DocumentSeries" SET "CurrentNumber" = $1 WHERE "DocumentSeriesID" = $2`, [
      nextNumber,
      series.DocumentSeriesID,
    ]);
    const returnNumber = formatTransactionNumber(transactionType.NumberingFormat, {
      code: transactionType.Code,
      storeCode: storeResult.rows[0]?.StoreCode,
      cashRegisterCode: cashRegisterResult.rows[0]?.Code || null,
      runningNumber: nextNumber,
    });

    // PaymentMethod/PaymentStatus describe how the return was settled.
    // A credit return has no payment rows at all — the money moves on
    // the customer's balance instead, applied by customerDue.
    const isRefund = settlement === "refund";
    const returnId = crypto.randomUUID();
    const returnResult = await client.query(
      `INSERT INTO "Sale"
        ("SaleID", "StoreID", "InvoiceNumber", "CustomerID", "TransactionTypeID", "SaleDate", "CashierID",
         "Subtotal", "DiscountAmount", "TaxAmount", "AdditionalCharges", "RoundOff", "TotalAmount", "TotalQty",
         "PaymentMethod", "PaymentStatus", "DueAmount", "Status", "RefNo", "Notes",
         "Action", "ActionBy", "ActionByUID", "ActionOn", "IdempotencyKey", "ReturnOfSaleID")
       VALUES ($1, $2, $3, $4, $5, now(), $6,
         $7, 0, $8, 0, 0, $9, $10,
         $11, 'paid', 0, 'completed', $12, $13,
         'NEW', $14, $15, now(), $16, $17)
       RETURNING *`,
      [
        returnId,
        original.StoreID,
        returnNumber,
        original.CustomerID,
        transactionType.TransactionTypeID,
        req.user.UserID || null,
        subtotal,
        taxAmountTotal,
        totalAmount,
        totalQty,
        isRefund ? refundMethod || "Cash" : "Credit to account",
        original.InvoiceNumber,
        notes || null,
        req.user.Name || req.user.Email || null,
        req.user.UserID || null,
        idempotencyKey,
        id,
      ]
    );
    const saleReturn = returnResult.rows[0];

    await insertSaleItems(client, returnId, preparedItems);

    if (isRefund) {
      await insertSalePayments(client, returnId, [
        { method: refundMethod || "Cash", amount: totalAmount },
      ]);
    }

    await client.query("COMMIT");

    // Direction 'in' on SALE_RETURN means the existing InStock consumer
    // adds the quantities back; customerDue applies the credit when
    // this was settled that way.
    const synced = await publishAfterCommit(
      () => publishSaleEvent({ eventType: "SaleCreated", sale: saleReturn, items: preparedItems }),
      `SaleCreated (return) ${returnNumber} against ${original.InvoiceNumber}`
    );

    return res.json({ success: true, sale: saleReturn, items: preparedItems, stockSyncPending: !synced });
  } catch (error) {
    await client.query("ROLLBACK");

    if (error.code === "23505" && error.constraint === "idx_sale_idempotency_key") {
      const key = req.headers["idempotency-key"];
      const winner = await returnExistingSale(client, req.body.storeId, key);
      if (winner) return res.json({ ...winner, idempotentReplay: true });
    }

    console.error(error);
    return res.status(500).json({ success: false, message: "Error recording return" });
  } finally {
    client.release();
  }
};
