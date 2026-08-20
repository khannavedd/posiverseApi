const { createSale, updateSale, cancelSale, getSales, getSale } = require("../Controllers/Sale");
const auth = require("../Middleware/auth");
const requirePermission = require("../Middleware/requirePermission");

const router = require("express").Router();

router.get("/", auth, requirePermission("sales.view"), getSales);
router.get("/:id", auth, requirePermission("sales.view"), getSale);
router.post("/", auth, requirePermission("sales.create"), createSale);
router.put("/:id", auth, requirePermission("sales.edit"), updateSale);
// "sales.return" — this business already seeds it (Controllers/Registration.js)
// for returns/voids; cancelling a posted sale is that same concept.
router.put("/:id/cancel", auth, requirePermission("sales.return"), cancelSale);

module.exports = router;
