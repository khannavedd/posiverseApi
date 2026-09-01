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

// Which way the quantity moves stock. Two values, and they mean exactly
// what they say (DEC-030).
//
// Only consulted for delta-based kinds. A stock_update SETS stock —
// that is keyed on Kind in posiverse-engine, not on a direction value —
// and receive_payment never reaches Direction at all because
// UpdateStock is false. Both carry a value only because the column is
// NOT NULL, and the form hides the picker when stock isn't touched.
const DIRECTIONS = ["in", "out"];

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

    // A deleted transaction type is only SOFT deleted (IsActive = false,
    // see deleteTransactionType), but the unique constraint is on
    // (RegistrationID, Code) and ignores IsActive — so a deleted type
    // permanently reserves its code against a row the owner can no
    // longer see. Creating it again returned "this code already exists"
    // about something invisible, which is indistinguishable from a bug.
    //
    // Reactivating is safe: deleteTransactionType refuses to delete a
    // type that any document or numbering series references, so a
    // soft-deleted row provably has no history. Nothing is reinterpreted
    // by giving it a new kind or new flags.
    const revivable = await pool.query(
      `SELECT "TransactionTypeID" FROM "TransactionType"
       WHERE "RegistrationID" = $1 AND "Code" = $2 AND "IsActive" = false`,
      [req.user.RegistrationID, code.trim().toUpperCase()]
    );
    if (revivable.rows.length > 0) {
      const revived = await pool.query(
        `UPDATE "TransactionType"
         SET "Module" = $1, "Kind" = $2, "Name" = $3, "Direction" = $4,
             "CalculateTax" = $5, "CustomerMandatory" = $6, "DiscountAllowed" = $7,
             "DiscountPercentage" = $8, "EmployeeMandatory" = $9, "PaymentModeRequired" = $10,
             "SalesImpact" = $11, "UpdateStock" = $12, "VendorMandatory" = $13,
             "NumberingFormat" = $14, "IsActive" = true
         WHERE "TransactionTypeID" = $15
         RETURNING *`,
        [
          moduleName.trim(), kind, name.trim(), direction,
          flags.calculateTax, flags.customerMandatory, flags.discountAllowed,
          Number(discountPercentage) || 0, flags.employeeMandatory, flags.paymentModeRequired,
          flags.salesImpact, flags.updateStock, flags.vendorMandatory,
          JSON.stringify(Array.isArray(numberingFormat) ? numberingFormat : []),
          revivable.rows[0].TransactionTypeID,
        ]
      );
      return res.json({ success: true, transactionType: revived.rows[0] });
    }

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
      return res.status(409).json({
        success: false,
        message: "A transaction type with this code already exists. Codes have to be unique — pick a different one.",
      });
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
        // Preserved, not defaulted. The app stopped sending this when
        // the dead controls were removed (DEC-030), and `Number(undefined)
        // || 0` would silently zero it on every edit. Nothing reads it
        // today, but wiping stored data because a form dropped a field is
        // the kind of thing only noticed once it matters.
        discountPercentage != null ? Number(discountPercentage) || 0 : Number(current.DiscountPercentage) || 0,
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
         (SELECT COUNT(*)::int FROM "Inventory" WHERE "TransactionTypeID" = $1) AS purchase_count,
         -- Sale was missing from this guard: a SALE or RECEIVE_PAYMENT
         -- type could be deleted with real sales behind it, orphaning
         -- their history from the type that describes them. Inventory
         -- was checked, Sale never was.
         (SELECT COUNT(*)::int FROM "Sale" WHERE "TransactionTypeID" = $1) AS sale_count`,
      [id]
    );
    const { series_count: seriesCount, purchase_count: purchaseCount, sale_count: saleCount } =
      usageResult.rows[0];

    // The last active type of a kind cannot be deleted. These six kinds
    // ARE the app's working vocabulary — delete the only 'sale' type and
    // the business can no longer sell, the POS entry vanishes from the
    // drawer, and resolveTransactionType's Code = 'SALE' fallback stops
    // resolving for any older client. Nothing in the app could recover
    // from that; it would need database access.
    //
    // Deactivating is still allowed and is the reversible way to hide
    // one — createTransactionType revives a soft-deleted row if the
    // owner re-adds the same code.
    const target = await pool.query(
      `SELECT "Kind", "Name" FROM "TransactionType" WHERE "TransactionTypeID" = $1 AND "RegistrationID" = $2`,
      [id, req.user.RegistrationID]
    );
    if (target.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Transaction type not found" });
    }
    const siblings = await pool.query(
      `SELECT COUNT(*)::int AS c FROM "TransactionType"
       WHERE "RegistrationID" = $1 AND "Kind" = $2 AND "IsActive" = true AND "TransactionTypeID" <> $3`,
      [req.user.RegistrationID, target.rows[0].Kind, id]
    );
    if (siblings.rows[0].c === 0) {
      return res.status(409).json({
        success: false,
        message: `Can't delete — ${target.rows[0].Name} is the only one of its kind, and the app needs it. Create a replacement first.`,
      });
    }

    const documentCount = purchaseCount + saleCount;
    if (documentCount > 0) {
      return res.status(409).json({
        success: false,
        message: `Can't delete — ${documentCount} document${documentCount === 1 ? "" : "s"} already use this transaction type.`,
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
