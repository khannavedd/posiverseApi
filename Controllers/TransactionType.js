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
  // Added by migration 041 — mirrors customerMandatory for the
  // inventory side. A stock update needs no vendor.
  "vendorMandatory",
];

// Closed vocabularies, matching the CHECK constraints migration 038 put
// on the columns (DEC-024). Validated here as well as in the database so
// the client gets a readable message instead of a raw 23514 constraint
// violation — the DB constraint is the guarantee, this is the manners.
//
// 'purchase' is deliberately absent: a purchase is how stock arrives,
// so it belongs to the inventory module.
const MODULES = ["sales", "inventory"];

// Direction is only consulted for types that actually move stock —
// posiverse-engine checks UpdateStock first. 'adjustment' means the
// line quantity carries its own sign, as opposed to 'in' (always add)
// and 'out' (always subtract). NOTE: the engine does not implement
// 'adjustment' yet and skips those documents, so it is currently an
// accurate label with no behaviour behind it. See migration 038.
const DIRECTIONS = ["in", "out", "adjustment"];

// What sort of document a type represents. Drives which form the app
// opens and which rules the API enforces — Module is too coarse, since
// Purchase Entry and Stock Update are both 'inventory'. See
// Utils/transactionTypeBlueprints.js and migration 041 (DEC-027).
const { KINDS, byKind, availableBlueprints } = require("../Utils/transactionTypeBlueprints");

// The catalogue the app's "add transaction type" picker renders. Served
// rather than duplicated in the app so there is one definition of what
// each kind means and which ones have a working form.
module.exports.getBlueprints = async (req, res) => {
  return res.json({ success: true, blueprints: availableBlueprints() });
};

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
    const { kind, code, name, discountPercentage, numberingFormat } = req.body;
    if (!kind || !code || !name) {
      return res.status(400).json({ success: false, message: "kind, code, and name are required" });
    }
    if (!KINDS.includes(kind)) {
      return res.status(400).json({ success: false, message: `kind must be one of: ${KINDS.join(", ")}` });
    }

    // Module comes from the blueprint, NOT from the client. It is a
    // property of the kind, and accepting it separately would allow a
    // 'sale' kind filed under the inventory module — which
    // resolveTransactionType would then accept on /inventory.
    const blueprint = byKind[kind];
    const moduleName = blueprint.defaults.module;
    const direction = DIRECTIONS.includes(req.body.direction)
      ? req.body.direction
      : blueprint.defaults.direction;

    // Flags fall back to the blueprint's, not to `true`. The previous
    // code defaulted every unspecified flag ON, which is wrong for kinds
    // like stock_update where most should be off.
    const flags = BOOLEAN_FIELDS.reduce((acc, field) => {
      acc[field] = req.body[field] != null ? !!req.body[field] : !!blueprint.defaults[field];
      return acc;
    }, {});

    const result = await pool.query(
      `INSERT INTO "TransactionType"
        ("TransactionTypeID", "RegistrationID", "Module", "Kind", "Code", "Name", "Direction",
         "CalculateTax", "CustomerMandatory", "DiscountAllowed", "DiscountPercentage",
         "EmployeeMandatory", "PaymentModeRequired", "SalesImpact", "UpdateStock",
         "VendorMandatory", "NumberingFormat", "IsActive")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, true)
       RETURNING *`,
      [
        crypto.randomUUID(),
        req.user.RegistrationID,
        moduleName.trim(),
        kind,
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
        flags.vendorMandatory,
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
    const { name, direction, discountPercentage, numberingFormat } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, message: "name is required" });
    }
    if (direction && !DIRECTIONS.includes(direction)) {
      return res.status(400).json({ success: false, message: `direction must be one of: ${DIRECTIONS.join(", ")}` });
    }

    // Kind, Module and Code are all IMMUTABLE after creation, and are
    // deliberately not read from the body here:
    //
    //   Kind/Module — changing them would silently reinterpret every
    //   document already filed under this type. A purchase history would
    //   become a stock-adjustment history.
    //
    //   Code — it is the stable internal key. Controllers/Sale.js looks
    //   up 'RECEIVE_PAYMENT' and 'SALE_RETURN' by Code, and
    //   resolveTransactionType falls back to 'SALE'/'PURCHASE' by Code
    //   when the client names no type. Letting the owner edit it would
    //   break those lookups with no warning. Name is the editable label —
    //   that was migration 012's stated intent and it was not enforced.
    const existing = await pool.query(
      `SELECT * FROM "TransactionType" WHERE "TransactionTypeID" = $1 AND "RegistrationID" = $2`,
      [req.params.id, req.user.RegistrationID]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Transaction type not found" });
    }
    const current = existing.rows[0];
    const moduleName = current.Module;
    const code = current.Code;
    const effectiveDirection = direction || current.Direction;

    const flags = BOOLEAN_FIELDS.reduce((acc, field) => {
      const dbField = field.charAt(0).toUpperCase() + field.slice(1);
      acc[field] = req.body[field] != null ? !!req.body[field] : !!current[dbField];
      return acc;
    }, {});

    const result = await pool.query(
      `UPDATE "TransactionType"
       SET "Module" = $1, "Code" = $2, "Name" = $3, "Direction" = $4,
           "CalculateTax" = $5, "CustomerMandatory" = $6, "DiscountAllowed" = $7, "DiscountPercentage" = $8,
           "EmployeeMandatory" = $9, "PaymentModeRequired" = $10, "SalesImpact" = $11, "UpdateStock" = $12,
           "VendorMandatory" = $13, "NumberingFormat" = $14
       WHERE "TransactionTypeID" = $15 AND "RegistrationID" = $16
       RETURNING *`,
      [
        moduleName.trim(),
        code.trim().toUpperCase(),
        name.trim(),
        effectiveDirection,
        flags.calculateTax,
        flags.customerMandatory,
        flags.discountAllowed,
        Number(discountPercentage) || 0,
        flags.employeeMandatory,
        flags.paymentModeRequired,
        flags.salesImpact,
        flags.updateStock,
        flags.vendorMandatory,
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
         (SELECT COUNT(*)::int FROM "Inventory" WHERE "TransactionTypeID" = $1) AS purchase_count`,
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
