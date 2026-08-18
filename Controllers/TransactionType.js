const crypto = require("crypto");
const pool = require("../DB/postgres");

const BOOLEAN_FIELDS = [
  "calculateTax",
  "customerMandatory",
  "discountAllowed",
  "employeeMandatory",
  "paymentModeRequired",
  "salesImpact",
  "updateStock",
];

module.exports.getTransactionTypes = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM "TransactionType" WHERE "RegistrationID" = $1 AND "IsActive" = true ORDER BY "Module" ASC, "Name" ASC`,
      [req.user.RegistrationID]
    );
    return res.json({ success: true, transactionTypes: result.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error fetching transaction types" });
  }
};

module.exports.createTransactionType = async (req, res) => {
  try {
    const { module: moduleName, code, name, direction, discountPercentage, numberingFormat } = req.body;
    if (!moduleName || !code || !name || !direction) {
      return res.status(400).json({ success: false, message: "module, code, name, and direction are required" });
    }

    const flags = BOOLEAN_FIELDS.reduce((acc, field) => {
      acc[field] = req.body[field] != null ? !!req.body[field] : true;
      return acc;
    }, {});

    const result = await pool.query(
      `INSERT INTO "TransactionType"
        ("TransactionTypeID", "RegistrationID", "Module", "Code", "Name", "Direction",
         "CalculateTax", "CustomerMandatory", "DiscountAllowed", "DiscountPercentage",
         "EmployeeMandatory", "PaymentModeRequired", "SalesImpact", "UpdateStock",
         "NumberingFormat", "IsActive")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, true)
       RETURNING *`,
      [
        crypto.randomUUID(),
        req.user.RegistrationID,
        moduleName.trim(),
        code.trim().toUpperCase(),
        name.trim(),
        direction,
        flags.calculateTax,
        flags.customerMandatory,
        flags.discountAllowed,
        Number(discountPercentage) || 0,
        flags.employeeMandatory,
        flags.paymentModeRequired,
        flags.salesImpact,
        flags.updateStock,
        JSON.stringify(Array.isArray(numberingFormat) ? numberingFormat : []),
      ]
    );

    return res.json({ success: true, transactionType: result.rows[0] });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ success: false, message: "A transaction type with this code already exists" });
    }
    console.error(error);
    return res.status(500).json({ success: false, message: "Error creating transaction type" });
  }
};

module.exports.updateTransactionType = async (req, res) => {
  try {
    const { id } = req.params;
    const { module: moduleName, code, name, direction, discountPercentage, numberingFormat } = req.body;
    if (!moduleName || !code || !name || !direction) {
      return res.status(400).json({ success: false, message: "module, code, name, and direction are required" });
    }

    const flags = BOOLEAN_FIELDS.reduce((acc, field) => {
      acc[field] = req.body[field] != null ? !!req.body[field] : true;
      return acc;
    }, {});

    const result = await pool.query(
      `UPDATE "TransactionType"
       SET "Module" = $1, "Code" = $2, "Name" = $3, "Direction" = $4,
           "CalculateTax" = $5, "CustomerMandatory" = $6, "DiscountAllowed" = $7, "DiscountPercentage" = $8,
           "EmployeeMandatory" = $9, "PaymentModeRequired" = $10, "SalesImpact" = $11, "UpdateStock" = $12,
           "NumberingFormat" = $13
       WHERE "TransactionTypeID" = $14 AND "RegistrationID" = $15
       RETURNING *`,
      [
        moduleName.trim(),
        code.trim().toUpperCase(),
        name.trim(),
        direction,
        flags.calculateTax,
        flags.customerMandatory,
        flags.discountAllowed,
        Number(discountPercentage) || 0,
        flags.employeeMandatory,
        flags.paymentModeRequired,
        flags.salesImpact,
        flags.updateStock,
        JSON.stringify(Array.isArray(numberingFormat) ? numberingFormat : []),
        id,
        req.user.RegistrationID,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Transaction type not found" });
    }

    return res.json({ success: true, transactionType: result.rows[0] });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ success: false, message: "A transaction type with this code already exists" });
    }
    console.error(error);
    return res.status(500).json({ success: false, message: "Error updating transaction type" });
  }
};

// Soft delete — blocked if any DocumentSeries or Purchase already
// reference it, same guard pattern as Vendor/Category/Brand/Tax. A
// TransactionType with history disappearing out from under an already-
// posted Purchase (or its running number series) would be far more
// confusing than just refusing the delete.
module.exports.deleteTransactionType = async (req, res) => {
  try {
    const { id } = req.params;

    const usageResult = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM "DocumentSeries" WHERE "TransactionTypeID" = $1) AS series_count,
         (SELECT COUNT(*)::int FROM "Purchase" WHERE "TransactionTypeID" = $1) AS purchase_count`,
      [id]
    );
    const { series_count: seriesCount, purchase_count: purchaseCount } = usageResult.rows[0];

    if (purchaseCount > 0) {
      return res.status(409).json({
        success: false,
        message: `Can't delete — ${purchaseCount} purchase${purchaseCount === 1 ? "" : "s"} already use this transaction type.`,
      });
    }
    if (seriesCount > 0) {
      return res.status(409).json({
        success: false,
        message: "Can't delete — this transaction type already has a running number series started.",
      });
    }

    const result = await pool.query(
      `UPDATE "TransactionType" SET "IsActive" = false
       WHERE "TransactionTypeID" = $1 AND "RegistrationID" = $2
       RETURNING "TransactionTypeID"`,
      [id, req.user.RegistrationID]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Transaction type not found" });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error deleting transaction type" });
  }
};
