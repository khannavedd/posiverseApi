const { createSale } = require("../Controllers/Sale");
const auth = require("../Middleware/auth");

const router = require("express").Router();

router.post("/", auth, createSale);

module.exports = router;
