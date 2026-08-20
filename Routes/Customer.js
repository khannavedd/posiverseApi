const { getCustomers, createCustomer, updateCustomer, deleteCustomer } = require("../Controllers/Customer");
const auth = require("../Middleware/auth");
const requirePermission = require("../Middleware/requirePermission");

const router = require("express").Router();

router.get("/", auth, requirePermission("customer.view"), getCustomers);
router.post("/", auth, requirePermission("customer.create"), createCustomer);
router.put("/:id", auth, requirePermission("customer.edit"), updateCustomer);
router.delete("/:id", auth, requirePermission("customer.delete"), deleteCustomer);

module.exports = router;
