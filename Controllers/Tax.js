const crypto = require("crypto");
const pool = require("../DB/postgres");

// Tax is a GROUP of one or more components (CGST/SGST/IGST/etc), not a
// single flat rate — see migration 010. TotalPercentage is the sum of
// each component's TaxPercentage, stored denormalized so the app can
// show/sort by it without unpacking the jsonb every time.
module.exports.getTaxes = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM "Tax" WHERE "RegistrationID" = $1 AND "IsActive" = true ORDER BY "Name" ASC`,
      [req.user.RegistrationID]
    );
    return res.json({ success: true, taxes: result.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error fetching tax rates" });
  }
};

// Shared by create and update — validates the raw {taxType,
// taxPercentage} pairs from the client and turns them into the stored
// component shape (see migration 010's notes on TaxAmount/TaxPerAmt
// always being 0/"" in the catalog master). Returns null on the array
// itself being invalid so callers can 400 before touching the DB.
function normalizeComponents(components) {
  if (!Array.isArray(components) || components.length === 0) return null;

  const normalized = [];
  let total = 0;
  for (const c of components) {
    const percentage = Number(c.taxPercentage);
    if (!c.taxType || Number.isNaN(percentage) || percentage < 0) return null;
    total += percentage;
    normalized.push({
      TaxName: c.taxType,
      TaxType: c.taxType,
      TaxPercentage: percentage,
      TaxAmount: 0,
      TaxPerAmt: "",
    });
  }
  return { normalized, total };
}

module.exports.createTax = async (req, res) => {
  try {
    const { name, components } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, message: "name is required" });
    }
    const result0 = normalizeComponents(components);
    if (!result0) {
      return res.status(400).json({
        success: false,
        message: "At least one component is required, each with a type and a valid percentage",
      });
    }

    const result = await pool.query(
      `INSERT INTO "Tax" ("TaxID", "RegistrationID", "Name", "Components", "TotalPercentage", "HSNCode", "IsActive")
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING *`,
      [
        crypto.randomUUID(),
        req.user.RegistrationID,
        name.trim(),
        JSON.stringify(result0.normalized),
        result0.total,
        req.body.hsnCode ?? null,
      ]
    );

    return res.json({ success: true, tax: result.rows[0] });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error creating tax rate" });
  }
};

module.exports.updateTax = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, components } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, message: "name is required" });
    }
    const result0 = normalizeComponents(components);
    if (!result0) {
      return res.status(400).json({
        success: false,
        message: "At least one component is required, each with a type and a valid percentage",
      });
    }

    const result = await pool.query(
      `UPDATE "Tax" SET "Name" = $1, "Components" = $2, "TotalPercentage" = $3, "HSNCode" = $4
       WHERE "TaxID" = $5 AND "RegistrationID" = $6
       RETURNING *`,
      [
        name.trim(),
        JSON.stringify(result0.normalized),
        result0.total,
        req.body.hsnCode ?? null,
        id,
        req.user.RegistrationID,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Tax group not found" });
    }

    return res.json({ success: true, tax: result.rows[0] });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error updating tax rate" });
  }
};

// Soft delete — sets IsActive false. Blocked if any active product
// still points at this row (same reasoning as Category.deleteCategory
// — a deleted row just stops appearing in GET /taxes, so a product
// still referencing it would otherwise render a blank tax label with
// no indication anything was deleted).
module.exports.deleteTax = async (req, res) => {
  try {
    const { id } = req.params;

    const productResult = await pool.query(
      `SELECT COUNT(*)::int AS count FROM "Product"
       WHERE "TaxID" = $1 AND "RegistrationID" = $2 AND "IsActive" = true`,
      [id, req.user.RegistrationID]
    );
    const productCount = productResult.rows[0].count;

    if (productCount > 0) {
      return res.status(409).json({
        success: false,
        message: `Can't delete — ${productCount} product${productCount === 1 ? "" : "s"} still use this tax group. Reassign them first.`,
      });
    }

    const result = await pool.query(
      `UPDATE "Tax" SET "IsActive" = false
       WHERE "TaxID" = $1 AND "RegistrationID" = $2
       RETURNING "TaxID"`,
      [id, req.user.RegistrationID]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Tax group not found" });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error deleting tax rate" });
  }
};
