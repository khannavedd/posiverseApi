const { createPurchase, updatePurchase, getPurchases, getPurchase } = require("../Controllers/Purchase");
const auth = require("../Middleware/auth");
const requirePermission = require("../Middleware/requirePermission");

const router = require("express").Router();

router.get("/", auth, requirePermission("purchase.view"), getPurchases);
router.post("/", auth, requirePermission("purchase.create"), createPurchase);
router.get("/:id", auth, requirePermission("purchase.view"), getPurchase);
router.put("/:id", auth, requirePermission("purchase.edit"), updatePurchase);

module.exports = router;
