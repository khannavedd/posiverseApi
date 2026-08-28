const crypto = require("crypto");
const pool = require("../DB/postgres");

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

// recordCustomerPayment / getCustomerPayments used to live here, backed
// by a standalone CustomerPayment ledger table. Moved to
// Controllers/Sale.js — "receive payment" is recorded as an actual Sale
// row (RECEIVE_PAYMENT TransactionType, no line items) instead, so it
// gets real document numbering and Sale's existing edit/cancel
// endpoints for free. Routes/Customer.js still exposes both under
// /customers/:id/payments, just imported from Sale's controller now.
