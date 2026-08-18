const pool = require("../DB/postgres");

// Must run after `auth` (Middleware/auth.js) — needs req.user.UID.
//
// Checks the caller's ACL rows for the given permission, scoped to
// storeId if the request has one (query param or body), or global
// (StoreID IS NULL) rows only otherwise. Every ACL row this codebase
// creates has its "Permissions" array populated at grant time (see
// Controllers/Registration.js) — there's no role-name fallback here
// like the mobile app's rowGrantsPermission has, because nothing here
// should ever create a role without also writing its permissions.
//
// Usage: router.post("/", auth, requirePermission("catalog.create"), createProduct)
module.exports = function requirePermission(permission) {
  return async (req, res, next) => {
    try {
      const storeId = req.query.storeId || req.body?.storeId || null;

      const result = await pool.query(
        `SELECT "Permissions" FROM "ACL"
         WHERE "UserID" = $1 AND "Status" = 'active' AND ("StoreID" = $2 OR "StoreID" IS NULL)`,
        [req.user.UID, storeId]
      );

      const hasPermission = result.rows.some(
        row => Array.isArray(row.Permissions) && row.Permissions.includes(permission)
      );

      if (!hasPermission) {
        return res.status(403).json({
          success: false,
          message: `You don't have permission to do this (${permission}).`,
        });
      }

      next();
    } catch (error) {
      console.error(error);
      return res.status(500).json({ success: false, message: "Permission check failed." });
    }
  };
};
