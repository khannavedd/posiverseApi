const { createSale, getSales, getSale } = require("../Controllers/Sale");
const auth = require("../Middleware/auth");
const requirePermission = require("../Middleware/requirePermission");

const router = require("express").Router();

router.get("/", auth, requirePermission("sales.view"), getSales);
router.get("/:id", auth, requirePermission("sales.view"), getSale);
router.post("/", auth, requirePermission("sales.create"), createSale);

module.exports = router;
