const axios = require("axios");
const { auth } = require("../DB/firebase");
const pool = require("../DB/postgres"); // PostgreSQL Pool

module.exports.login = async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: "Email and password are required."
            });
        }

        // Authenticate with Firebase
        const firebaseResponse = await axios.post(
            `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${process.env.FIREBASE_API_KEY}`,
            {
                email,
                password,
                returnSecureToken: true
            }
        );

        const { idToken, refreshToken } = firebaseResponse.data;

        // Verify token
        const decodedToken = await auth.verifyIdToken(idToken);

        // Fetch user from PostgreSQL
        const userResult = await pool.query(
            `SELECT *
       FROM "User"
       WHERE "UID" = $1
       LIMIT 1`,
            [decodedToken.uid]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "User not found."
            });
        }

        const user = userResult.rows[0];

        return res.json({
            status: 200,
            code: "0",
            success: true,
            token: idToken,
            refreshToken,
            expiresIn: firebaseResponse.data.expiresIn,
            user
        });

    } catch (error) {
        console.error(error.response?.data || error);

        return res.status(500).json({
            success: false,
            code: "1",
            message: "Invalid email or password."
        });
    }
};

module.exports.getStores = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    let storesRef = await pool.query(
      `SELECT *
       FROM "Store"
       WHERE "RegistrationID" = $1`,
      [req.user.RegistrationID]
    );

    // ACL rows for this user — StoreID = null means "every store under
    // the registration", a store-specific row means just that one. The
    // app resolves which role(s) apply once a store is picked (see
    // Utils/permissions.js on the mobile side).
    let aclRef = await pool.query(
      `SELECT * FROM "ACL" WHERE "UserID" = $1 AND "Status" = 'active'`,
      [req.user.UID]
    );

    // This business's configured TransactionTypes (Sales Invoice,
    // Purchase Entry, etc. — see migration 012). The drawer uses this
    // to only show a menu item like "Sales Invoice" if that
    // TransactionType actually exists/is active for this business,
    // rather than hardcoding the list on the client.
    let transactionTypeRef = await pool.query(
      `SELECT * FROM "TransactionType" WHERE "RegistrationID" = $1 AND "IsActive" = true`,
      [req.user.RegistrationID]
    );

    return res.json({
      success: true,
      stores: storesRef.rows,
      acl: aclRef.rows,
      transactionTypes: transactionTypeRef.rows,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error",
    });
  }
};