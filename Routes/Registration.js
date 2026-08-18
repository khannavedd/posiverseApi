const { register } = require("../Controllers/Registration");

const router = require("express").Router();

// Public — no auth middleware, since there's no account yet.
router.post("/register", register);

module.exports = router;
