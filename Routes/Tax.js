const { getTaxes, createTax, updateTax, deleteTax } = require("../Controllers/Tax");
const auth = require("../Middleware/auth");
const requirePermission = require("../Middleware/requirePermission");

const router = require("express").Router();

router.get("/", auth, requirePermission("catalog.view"), getTaxes);
router.post("/", auth, requirePermission("catalog.create"), createTax);
router.put("/:id", auth, requirePermission("catalog.edit"), updateTax);
router.delete("/:id", auth, requirePermission("catalog.delete"), deleteTax);

module.exports = router;
