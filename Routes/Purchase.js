const { createPurchase, updatePurchase, cancelPurchase, getPurchases, getPurchase } = require("../Controllers/Purchase");
const auth = require("../Middleware/auth");
const requirePermission = require("../Middleware/requirePermission");

const router = require("express").Router();

router.get("/", auth, requirePermission("purchase.view"), getPurchases);
router.post("/", auth, requirePermission("purchase.create"), createPurchase);
router.get("/:id", auth, requirePermission("purchase.view"), getPurchase);
router.put("/:id", auth, requirePermission("purchase.edit"), updatePurchase);
// purchase.return — same permission this app already seeds for undoing
// a posted purchase (see Controllers/Registration.js); cancelling one
// is that same concept, mirroring PUT /sales/:id/cancel.
router.put("/:id/cancel", auth, requirePermission("purchase.return"), cancelPurchase);

module.exports = router;
