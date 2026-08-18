const { getVendors, createVendor, updateVendor, deleteVendor } = require("../Controllers/Vendor");
const auth = require("../Middleware/auth");
const requirePermission = require("../Middleware/requirePermission");

const router = require("express").Router();

router.get("/", auth, requirePermission("vendor.view"), getVendors);
router.post("/", auth, requirePermission("vendor.create"), createVendor);
router.put("/:id", auth, requirePermission("vendor.edit"), updateVendor);
router.delete("/:id", auth, requirePermission("vendor.delete"), deleteVendor);

module.exports = router;
