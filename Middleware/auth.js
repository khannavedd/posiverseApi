// Middleware/auth.js

const { auth } = require("../DB/firebase");
const pool = require("../DB/postgres");

module.exports = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split("Bearer ")[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Token is required",
      });
    }

    // Verify Firebase token
    const decoded = await auth.verifyIdToken(token);

    // Fetch user from PostgreSQL
    const result = await pool.query(
      `SELECT *
       FROM "User"
       WHERE "UID" = $1
       LIMIT 1`,
      [decoded.uid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Attach the database user to the request
    req.user = result.rows[0];

    next();
  } catch (err) {
    console.error(err);

    return res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
  }
};