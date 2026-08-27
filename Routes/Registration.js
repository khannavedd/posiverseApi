const { register } = require("../Controllers/Registration");
const { registerLimiter } = require("../Middleware/rateLimit");

const router = require("express").Router();

// Public — no auth middleware, since there's no account yet.
router.post("/register", registerLimiter, register);

module.exports = router;
