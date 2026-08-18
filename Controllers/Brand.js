const crypto = require("crypto");
const pool = require("../DB/postgres");

module.exports.getBrands = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM "Brand" WHERE "RegistrationID" = $1 AND "IsActive" = true ORDER BY "Name" ASC`,
      [req.user.RegistrationID]
    );
    return res.json({ success: true, brands: result.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error fetching brands" });
  }
};

module.exports.createBrand = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, message: "name is required" });
    }

    const result = await pool.query(
      `INSERT INTO "Brand" ("BrandID", "RegistrationID", "Name", "IsActive")
       VALUES ($1, $2, $3, true)
       RETURNING *`,
      [crypto.randomUUID(), req.user.RegistrationID, name.trim()]
    );

    return res.json({ success: true, brand: result.rows[0] });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error creating brand" });
  }
};

module.exports.updateBrand = async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, message: "name is required" });
    }

    const result = await pool.query(
      `UPDATE "Brand" SET "Name" = $1
       WHERE "BrandID" = $2 AND "RegistrationID" = $3
       RETURNING *`,
      [name.trim(), id, req.user.RegistrationID]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Brand not found" });
    }

    return res.json({ success: true, brand: result.rows[0] });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error updating brand" });
  }
};

// Soft delete — sets IsActive false. Blocked if any active product
// still points at this row (same reasoning as Category.deleteCategory
// — a deleted row just stops appearing in GET /brands, so a product
// still referencing it would otherwise render a blank brand label with
// no indication anything was deleted).
module.exports.deleteBrand = async (req, res) => {
  try {
    const { id } = req.params;

    const productResult = await pool.query(
      `SELECT COUNT(*)::int AS count FROM "Product"
       WHERE "BrandID" = $1 AND "RegistrationID" = $2 AND "IsActive" = true`,
      [id, req.user.RegistrationID]
    );
    const productCount = productResult.rows[0].count;

    if (productCount > 0) {
      return res.status(409).json({
        success: false,
        message: `Can't delete — ${productCount} product${productCount === 1 ? "" : "s"} still use this brand. Reassign them first.`,
      });
    }

    const result = await pool.query(
      `UPDATE "Brand" SET "IsActive" = false
       WHERE "BrandID" = $1 AND "RegistrationID" = $2
       RETURNING "BrandID"`,
      [id, req.user.RegistrationID]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Brand not found" });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error deleting brand" });
  }
};
