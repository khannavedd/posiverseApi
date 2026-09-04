const crypto = require("crypto");
const pool = require("../DB/postgres");
const { uploadImage, deleteImageByUrl } = require("../Utils/imageUpload");

module.exports.getCategories = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM "Category" WHERE "RegistrationID" = $1 AND "IsActive" = true ORDER BY "Name" ASC`,
      [req.user.RegistrationID]
    );
    return res.json({ success: true, categories: result.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error fetching categories" });
  }
};

module.exports.createCategory = async (req, res) => {
  try {
    const { name, parentCategoryId } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, message: "name is required" });
    }

    const result = await pool.query(
      `INSERT INTO "Category" ("CategoryID", "RegistrationID", "Name", "ParentCategoryID", "IsActive")
       VALUES ($1, $2, $3, $4, true)
       RETURNING *`,
      [crypto.randomUUID(), req.user.RegistrationID, name.trim(), parentCategoryId ?? null]
    );

    return res.json({ success: true, category: result.rows[0] });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error creating category" });
  }
};

module.exports.updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, parentCategoryId } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, message: "name is required" });
    }
    if (parentCategoryId === id) {
      return res.status(400).json({ success: false, message: "A category can't be its own parent" });
    }

    const result = await pool.query(
      `UPDATE "Category" SET "Name" = $1, "ParentCategoryID" = $2
       WHERE "CategoryID" = $3 AND "RegistrationID" = $4
       RETURNING *`,
      [name.trim(), parentCategoryId ?? null, id, req.user.RegistrationID]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }

    return res.json({ success: true, category: result.rows[0] });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error updating category" });
  }
};

// Soft delete — sets IsActive false. Blocked if any active sub-category
// or product still points at this row, so nothing silently ends up
// pointing at a category that no longer shows up anywhere (a deleted
// row just stops appearing in GET /categories, so a product still
// referencing it would otherwise render a blank/missing category label
// with no indication anything was deleted).
module.exports.deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;

    const [subResult, productResult] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS count FROM "Category"
         WHERE "ParentCategoryID" = $1 AND "RegistrationID" = $2 AND "IsActive" = true`,
        [id, req.user.RegistrationID]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS count FROM "Product"
         WHERE "CategoryID" = $1 AND "RegistrationID" = $2 AND "IsActive" = true`,
        [id, req.user.RegistrationID]
      ),
    ]);

    const subCount = subResult.rows[0].count;
    const productCount = productResult.rows[0].count;

    if (subCount > 0 || productCount > 0) {
      const parts = [];
      if (subCount > 0) parts.push(`${subCount} sub-categor${subCount === 1 ? "y" : "ies"}`);
      if (productCount > 0) parts.push(`${productCount} product${productCount === 1 ? "" : "s"}`);
      return res.status(409).json({
        success: false,
        message: `Can't delete — ${parts.join(" and ")} still use this category. Reassign them first.`,
      });
    }

    const result = await pool.query(
      `UPDATE "Category" SET "IsActive" = false
       WHERE "CategoryID" = $1 AND "RegistrationID" = $2
       RETURNING "CategoryID"`,
      [id, req.user.RegistrationID]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error deleting category" });
  }
};

// ---------------------------------------------------------------------
// Category image
//
// Ownership is verified against RegistrationID BEFORE anything is
// written to the bucket, so a crafted id cannot make this app store a
// file on another business's behalf.
// ---------------------------------------------------------------------
module.exports.uploadCategoryImage = async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No image file uploaded (expected field name 'image')." });
    }

    const existing = await pool.query(
      `SELECT "ImageURL" FROM "Category" WHERE "CategoryID" = $1 AND "RegistrationID" = $2`,
      [id, req.user.RegistrationID]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }

    const imageUrl = await uploadImage({
      file: req.file,
      prefix: "categories",
      registrationId: req.user.RegistrationID,
      ownerId: id,
    });

    await pool.query(
      `UPDATE "Category" SET "ImageURL" = $1 WHERE "CategoryID" = $2 AND "RegistrationID" = $3`,
      [imageUrl, id, req.user.RegistrationID]
    );

    // After the row points at the new image, never before — if this
    // throws, the worst case is an orphaned object, not a row pointing
    // at a file that no longer exists.
    await deleteImageByUrl(existing.rows[0].ImageURL);

    return res.json({ success: true, imageUrl });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Couldn't upload the image" });
  }
};

module.exports.removeCategoryImage = async (req, res) => {
  try {
    const { id } = req.params;
    // Read then update, deliberately NOT a RETURNING subquery: a
    // subquery in RETURNING re-reads the table under the statement's
    // own snapshot, so whether it yields the old or new value is
    // fragile. Two plain statements say exactly what they mean.
    const existing = await pool.query(
      `SELECT "ImageURL" FROM "Category" WHERE "CategoryID" = $1 AND "RegistrationID" = $2`,
      [id, req.user.RegistrationID]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }

    await pool.query(
      `UPDATE "Category" SET "ImageURL" = NULL WHERE "CategoryID" = $1 AND "RegistrationID" = $2`,
      [id, req.user.RegistrationID]
    );
    await deleteImageByUrl(existing.rows[0].ImageURL);
    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Couldn't remove the image" });
  }
};
