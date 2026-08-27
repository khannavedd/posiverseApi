const crypto = require("crypto");
const pool = require("../DB/postgres");
const { formatTransactionNumber } = require("../Utils/numberingFormat");
const { publishCustomerPaymentEvent } = require("../Utils/publishEvent");

module.exports.getCustomers = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM "Customer" WHERE "RegistrationID" = $1 AND "IsActive" = true ORDER BY "Name" ASC`,
      [req.user.RegistrationID]
    );
    return res.json({ success: true, customers: result.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error fetching customers" });
  }
};

module.exports.createCustomer = async (req, res) => {
  try {
    const { name, phone, email, address, gender, dateOfBirth, anniversaryDate, note, customerCode } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, message: "name is required" });
    }

    const result = await pool.query(
      `INSERT INTO "Customer"
        ("CustomerID", "RegistrationID", "Name", "Phone", "Email", "Address",
         "Gender", "DateOfBirth", "AnniversaryDate", "Note", "CustomerCode", "IsActive")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)
       RETURNING *`,
      [
        crypto.randomUUID(),
        req.user.RegistrationID,
        name.trim(),
        phone ?? null,
        email ?? null,
        address ?? null,
        gender ?? null,
        dateOfBirth || null,
        anniversaryDate || null,
        note ?? null,
        customerCode ?? null,
      ]
    );

    return res.json({ success: true, customer: result.rows[0] });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error creating customer" });
  }
};

module.exports.updateCustomer = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, email, address, gender, dateOfBirth, anniversaryDate, note, customerCode } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, message: "name is required" });
    }

    const result = await pool.query(
      `UPDATE "Customer"
       SET "Name" = $1, "Phone" = $2, "Email" = $3, "Address" = $4,
           "Gender" = $5, "DateOfBirth" = $6, "AnniversaryDate" = $7, "Note" = $8, "CustomerCode" = $9,
           "UpdatedAt" = now()
       WHERE "CustomerID" = $10 AND "RegistrationID" = $11
       RETURNING *`,
      [
        name.trim(),
        phone ?? null,
        email ?? null,
        address ?? null,
        gender ?? null,
        dateOfBirth || null,
        anniversaryDate || null,
        note ?? null,
        customerCode ?? null,
        id,
        req.user.RegistrationID,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }

    return res.json({ success: true, customer: result.rows[0] });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error updating customer" });
  }
};

// Soft delete. No reference guard here (unlike Vendor's active-Purchase
// check) — the Sale/SaleItem tables were dropped by migration 007 and
// never rebuilt (see DATABASE_SCHEMA.md's "Tables that do NOT exist"
// section), so there's nothing live to check a customer against yet. Add
// the guard back once Sale exists for real.
module.exports.deleteCustomer = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `UPDATE "Customer" SET "IsActive" = false, "UpdatedAt" = now()
       WHERE "CustomerID" = $1 AND "RegistrationID" = $2
       RETURNING "CustomerID"`,
      [id, req.user.RegistrationID]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error deleting customer" });
  }
};

// Records a payment against this customer's overall running balance —
// NOT allocated to any specific Sale, same "single running balance"
// shape Vendor.DueAmount already has (there's no per-purchase vendor
// settlement either). Customer.OutstandingBalance itself is adjusted
// asynchronously by posiverse-engine's customerDue consumer reacting to
// the CustomerPaymentCreated event published below — this endpoint only
// writes the ledger row + issues its document number, same division of
// responsibility createSale has with InStock.
//
// Numbering mirrors createSale/createPurchase exactly: look up the
// "Receive Payment" TransactionType, lock/increment its per-store
// DocumentSeries counter, format the number from NumberingFormat.
module.exports.recordCustomerPayment = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { storeId, amount, method, notes } = req.body;

    if (!storeId) return res.status(400).json({ success: false, message: "storeId is required" });
    const paymentAmount = Number(amount);
    if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
      return res.status(400).json({ success: false, message: "amount must be a positive number" });
    }

    await client.query("BEGIN");

    const customerCheck = await client.query(
      `SELECT "CustomerID" FROM "Customer" WHERE "CustomerID" = $1 AND "RegistrationID" = $2 AND "IsActive" = true`,
      [id, req.user.RegistrationID]
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

    const paymentResult = await client.query(
      `INSERT INTO "CustomerPayment"
        ("CustomerPaymentID", "RegistrationID", "StoreID", "CustomerID", "TransactionTypeID", "PaymentNumber",
         "Amount", "Method", "Notes", "Action", "ActionBy", "ActionByUID", "ActionOn")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'NEW', $10, $11, now())
       RETURNING *`,
      [
        crypto.randomUUID(),
        req.user.RegistrationID,
        storeId,
        id,
        transactionType.TransactionTypeID,
        paymentNumber,
        paymentAmount,
        method || null,
        notes || null,
        req.user.Name || req.user.Email || null,
        req.user.UserID || null,
      ]
    );
    const payment = paymentResult.rows[0];

    await client.query("COMMIT");

    await publishCustomerPaymentEvent({ customerId: id, storeId, amount: paymentAmount });

    return res.json({ success: true, payment });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ success: false, message: "Error recording payment" });
  } finally {
    client.release();
  }
};

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
      `SELECT * FROM "CustomerPayment" WHERE "CustomerID" = $1 ORDER BY "ActionOn" DESC`,
      [id]
    );

    return res.json({ success: true, payments: result.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error fetching payments" });
  }
};
