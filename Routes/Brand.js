const { getBrands, createBrand, updateBrand, deleteBrand } = require("../Controllers/Brand");
const auth = require("../Middleware/auth");
const requirePermission = require("../Middleware/requirePermission");

const router = require("express").Router();

router.get("/", auth, requirePermission("catalog.view"), getBrands);
router.post("/", auth, requirePermission("catalog.create"), createBrand);
router.put("/:id", auth, requirePermission("catalog.edit"), updateBrand);
router.delete("/:id", auth, requirePermission("catalog.delete"), deleteBrand);

module.exports = router;
