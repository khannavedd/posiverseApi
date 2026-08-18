const crypto = require("crypto");
const pool = require("../DB/postgres");

module.exports.getVendors = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM "Vendor" WHERE "RegistrationID" = $1 AND "IsActive" = true ORDER BY "Name" ASC`,
      [req.user.RegistrationID]
    );
    return res.json({ success: true, vendors: result.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error fetching vendors" });
  }
};

module.exports.createVendor = async (req, res) => {
  try {
    const { name, phone, email, address, gstNumber } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, message: "name is required" });
    }

    const result = await pool.query(
      `INSERT INTO "Vendor"
        ("VendorID", "RegistrationID", "Name", "Phone", "Email", "Address", "GSTNumber", "IsActive")
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       RETURNING *`,
      [
        crypto.randomUUID(),
        req.user.RegistrationID,
        name.trim(),
        phone ?? null,
        email ?? null,
        address ?? null,
        gstNumber ?? null,
      ]
    );

    return res.json({ success: true, vendor: result.rows[0] });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error creating vendor" });
  }
};

module.exports.updateVendor = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, email, address, gstNumber } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, message: "name is required" });
    }

    const result = await pool.query(
      `UPDATE "Vendor"
       SET "Name" = $1, "Phone" = $2, "Email" = $3,
           "Address" = $4, "GSTNumber" = $5, "UpdatedAt" = now()
       WHERE "VendorID" = $6 AND "RegistrationID" = $7
       RETURNING *`,
      [
        name.trim(),
        phone ?? null,
        email ?? null,
        address ?? null,
        gstNumber ?? null,
        id,
        req.user.RegistrationID,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Vendor not found" });
    }

    return res.json({ success: true, vendor: result.rows[0] });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error updating vendor" });
  }
};

// Soft delete — blocked if any active Purchase still points at this
// vendor, same guard pattern as Category/Brand/Tax: a deleted vendor
// just stops appearing in GET /vendors, so a Purchase still referencing
// it would otherwise show a blank/missing vendor with no indication
// anything was deleted.
module.exports.deleteVendor = async (req, res) => {
  try {
    const { id } = req.params;

    const purchaseResult = await pool.query(
      `SELECT COUNT(*)::int AS count FROM "Purchase"
       WHERE "VendorID" = $1 AND "StoreID" IN (SELECT "StoreID" FROM "Store" WHERE "RegistrationID" = $2)`,
      [id, req.user.RegistrationID]
    );
    const purchaseCount = purchaseResult.rows[0].count;

    if (purchaseCount > 0) {
      return res.status(409).json({
        success: false,
        message: `Can't delete — ${purchaseCount} purchase${purchaseCount === 1 ? "" : "s"} still reference this vendor.`,
      });
    }

    const result = await pool.query(
      `UPDATE "Vendor" SET "IsActive" = false, "UpdatedAt" = now()
       WHERE "VendorID" = $1 AND "RegistrationID" = $2
       RETURNING "VendorID"`,
      [id, req.user.RegistrationID]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Vendor not found" });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error deleting vendor" });
  }
};
