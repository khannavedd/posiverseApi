const { getCategories, createCategory, updateCategory, deleteCategory } = require("../Controllers/Category");
const auth = require("../Middleware/auth");
const requirePermission = require("../Middleware/requirePermission");

const router = require("express").Router();

router.get("/", auth, requirePermission("catalog.view"), getCategories);
router.post("/", auth, requirePermission("catalog.create"), createCategory);
router.put("/:id", auth, requirePermission("catalog.edit"), updateCategory);
router.delete("/:id", auth, requirePermission("catalog.delete"), deleteCategory);

module.exports = router;
