const crypto = require("crypto");
const pool = require("../DB/postgres");

module.exports.getPaymentTypes = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM "PaymentType" WHERE "RegistrationID" = $1 AND "IsActive" = true ORDER BY "SequenceNo" ASC, "Name" ASC`,
      [req.user.RegistrationID]
    );
    return res.json({ success: true, paymentTypes: result.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error fetching payment types" });
  }
};

module.exports.createPaymentType = async (req, res) => {
  try {
    const { name, sequenceNo, showInSales } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, message: "name is required" });
    }

    const result = await pool.query(
      `INSERT INTO "PaymentType"
        ("PaymentTypeID", "RegistrationID", "Name", "SequenceNo", "ShowInSales", "IsSystemDefined", "IsActive")
       VALUES ($1, $2, $3, $4, $5, false, true)
       RETURNING *`,
      [
        crypto.randomUUID(),
        req.user.RegistrationID,
        name.trim(),
        Number(sequenceNo) || 0,
        showInSales != null ? !!showInSales : true,
      ]
    );

    return res.json({ success: true, paymentType: result.rows[0] });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ success: false, message: "A payment type with this name already exists" });
    }
    console.error(error);
    return res.status(500).json({ success: false, message: "Error creating payment type" });
  }
};

module.exports.updatePaymentType = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, sequenceNo, showInSales } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, message: "name is required" });
    }

    const result = await pool.query(
      `UPDATE "PaymentType"
       SET "Name" = $1, "SequenceNo" = $2, "ShowInSales" = $3
       WHERE "PaymentTypeID" = $4 AND "RegistrationID" = $5
       RETURNING *`,
      [
        name.trim(),
        Number(sequenceNo) || 0,
        showInSales != null ? !!showInSales : true,
        id,
        req.user.RegistrationID,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Payment type not found" });
    }

    return res.json({ success: true, paymentType: result.rows[0] });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ success: false, message: "A payment type with this name already exists" });
    }
    console.error(error);
    return res.status(500).json({ success: false, message: "Error updating payment type" });
  }
};

// Soft delete — sets IsActive false. Blocked for IsSystemDefined rows
// (the ones seeded by migration 026) so a business can't accidentally
// empty out its own POS payment screen; those can still be renamed,
// reordered, or hidden from Sales via ShowInSales instead of removed.
// No usage guard against past Sales the way Brand/Category guard
// against Product — Sale.PaymentMethod is a plain string with no
// foreign key to this table (see DATABASE_SCHEMA.md), so there's
// nothing reliable to check.
module.exports.deletePaymentType = async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await pool.query(
      `SELECT "IsSystemDefined" FROM "PaymentType" WHERE "PaymentTypeID" = $1 AND "RegistrationID" = $2`,
      [id, req.user.RegistrationID]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Payment type not found" });
    }

    if (existing.rows[0].IsSystemDefined) {
      return res.status(409).json({
        success: false,
        message: "Can't delete a default payment type. Turn off \"Show in sales\" instead if you don't want it to show at checkout.",
      });
    }

    const result = await pool.query(
      `UPDATE "PaymentType" SET "IsActive" = false
       WHERE "PaymentTypeID" = $1 AND "RegistrationID" = $2
       RETURNING "PaymentTypeID"`,
      [id, req.user.RegistrationID]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Payment type not found" });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error deleting payment type" });
  }
};
