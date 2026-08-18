const { getProducts, getProduct, createProduct, updateProduct, deleteProduct } = require("../Controllers/Product");
const auth = require("../Middleware/auth");
const requirePermission = require("../Middleware/requirePermission");

const router = require("express").Router();

router.get("/", auth, requirePermission("catalog.view"), getProducts);
router.get("/:id", auth, requirePermission("catalog.view"), getProduct);
router.post("/", auth, requirePermission("catalog.create"), createProduct);
router.put("/:id", auth, requirePermission("catalog.edit"), updateProduct);
router.delete("/:id", auth, requirePermission("catalog.delete"), deleteProduct);

module.exports = router;
