const crypto = require("crypto");
const pool = require("../DB/postgres");

// Everything a Sale touches happens in one transaction: the Sale row,
// its SaleItems, Payment record(s), and the resulting stock movement.
// This is a simplification of the fuller design in the Application
// Workflow doc — there, inventory updates happen asynchronously via a
// Pub/Sub worker so they're off the request's critical path. This API
// doesn't have Pub/Sub wired up yet, so for now it's synchronous and in
// the same transaction as the sale itself, which is simpler and still
// correct — just something to revisit if sale volume ever makes that
// path slow enough to matter.
module.exports.createSale = async (req, res) => {
  const {
    id,
    storeId,
    customerId,
    items,
    payments,
  } = req.body;

  // Validated before opening a connection, so there's nothing to
  // release if this fails.
  if (!storeId || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({
      success: false,
      message: "storeId and at least one item are required",
    });
  }

  const saleId = id || crypto.randomUUID();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Idempotency guard: if this sale id was already processed (e.g. the
    // app retried after a dropped connection but the first request had
    // actually gone through), return the existing sale instead of
    // creating a duplicate or double-decrementing stock.
    const existing = await client.query(
      `SELECT * FROM "Sale" WHERE "SaleID" = $1`,
      [saleId]
    );
    if (existing.rows.length > 0) {
      await client.query("COMMIT");
      return res.json({ success: true, sale: existing.rows[0], idempotent: true });
    }

    const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
    const totalAmount = subtotal;

    // Look up the real TransactionType rows (seeded in migration 004)
    // instead of leaving TransactionTypeID null — SALE for the Sale
    // itself, STOCK_OUT for the resulting inventory movement, since
    // those are the two different things being recorded even though
    // they both stem from the same request.
    const transactionTypes = await client.query(
      `SELECT "Code", "TransactionTypeID" FROM "TransactionType" WHERE "Code" IN ('SALE', 'STOCK_OUT')`
    );
    const saleTypeId = transactionTypes.rows.find(t => t.Code === "SALE")?.TransactionTypeID ?? null;
    const stockOutTypeId = transactionTypes.rows.find(t => t.Code === "STOCK_OUT")?.TransactionTypeID ?? null;

    // Invoice numbering from DocumentSeries (section 19 of the schema
    // doc) — lock the row so two simultaneous sales at the same store
    // can't be handed the same number.
    let seriesResult = await client.query(
      `SELECT * FROM "DocumentSeries" WHERE "StoreID" = $1 AND "DocumentType" = 'SALE_INVOICE' FOR UPDATE`,
      [storeId]
    );

    let series;
    if (seriesResult.rows.length === 0) {
      const created = await client.query(
        `INSERT INTO "DocumentSeries" ("DocumentSeriesID", "StoreID", "DocumentType", "Prefix", "CurrentNumber", "Padding")
         VALUES ($1, $2, 'SALE_INVOICE', 'INV-', 0, 4)
         RETURNING *`,
        [crypto.randomUUID(), storeId]
      );
      series = created.rows[0];
    } else {
      series = seriesResult.rows[0];
    }
    
    const nextNumber = series.CurrentNumber + 1;
    const invoiceNumber = `${series.Prefix || ""}${String(nextNumber).padStart(series.Padding || 4, "0")}${series.Suffix || ""}`;

    await client.query(
      `UPDATE "DocumentSeries" SET "CurrentNumber" = $1 WHERE "DocumentSeriesID" = $2`,
      [nextNumber, series.DocumentSeriesID]
    );

    const saleResult = await client.query(
      `INSERT INTO "Sale"
        ("SaleID", "StoreID", "InvoiceNumber", "CustomerID", "TransactionTypeID", "SaleDate", "CashierID",
         "Subtotal", "TaxAmount", "DiscountAmount", "TotalAmount", "PaymentMethod", "PaymentStatus", "Status")
       VALUES ($1, $2, $3, $4, $5, now(), $6, $7, 0, 0, $8, $9, 'paid', 'completed')
       RETURNING *`,
      [
        saleId,
        storeId,
        invoiceNumber,
        customerId ?? null,
        saleTypeId,
        req.user.UID,
        subtotal,
        totalAmount,
        payments?.[0]?.method ?? "cash",
      ]
    );
    const sale = saleResult.rows[0];

    for (const item of items) {
      const lineTotal = item.quantity * item.unitPrice;

      await client.query(
        `INSERT INTO "SaleItem"
          ("SaleItemID", "SaleID", "ProductID", "Quantity", "UnitPrice", "TaxAmount", "DiscountAmount", "LineTotal")
         VALUES ($1, $2, $3, $4, $5, 0, 0, $6)`,
        [crypto.randomUUID(), saleId, item.productId, item.quantity, item.unitPrice, lineTotal]
      );

      // Decrement stock — insert a negative starting balance if this
      // product has no InventoryStock row yet, otherwise subtract from
      // the existing quantity. Same query shape either way.
      const stockResult = await client.query(
        `INSERT INTO "InventoryStock" ("InventoryStockID", "StoreID", "ProductID", "QuantityOnHand", "UpdatedAt")
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT ("StoreID", "ProductID") DO UPDATE SET
           "QuantityOnHand" = "InventoryStock"."QuantityOnHand" - $4,
           "UpdatedAt" = now()
         RETURNING "QuantityOnHand"`,
        [crypto.randomUUID(), storeId, item.productId, item.quantity]
      );

      await client.query(
        `INSERT INTO "StockLedger"
          ("StockLedgerID", "StoreID", "ProductID", "TransactionTypeID", "ReferenceType", "ReferenceID", "QuantityChange", "BalanceAfter", "CreatedBy")
         VALUES ($1, $2, $3, $4, 'sale', $5, $6, $7, $8)`,
        [
          crypto.randomUUID(),
          storeId,
          item.productId,
          stockOutTypeId,
          saleId,
          -item.quantity,
          stockResult.rows[0].QuantityOnHand,
          req.user.UID,
        ]
      );
    }

    const paymentRows = payments?.length ? payments : [{ method: "cash", amount: totalAmount }];
    for (const payment of paymentRows) {
      await client.query(
        `INSERT INTO "Payment"
          ("PaymentID", "StoreID", "ReferenceType", "ReferenceID", "Amount", "Method", "PaymentDate", "CreatedBy")
         VALUES ($1, $2, 'sale', $3, $4, $5, now(), $6)`,
        [crypto.randomUUID(), storeId, saleId, payment.amount, payment.method, req.user.UID]
      );
    }

    await client.query("COMMIT");

    return res.json({ success: true, sale });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Error creating sale",
    });
  } finally {
    client.release();
  }
};
