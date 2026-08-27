const {
  getCustomers,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  recordCustomerPayment,
  getCustomerPayments,
} = require("../Controllers/Customer");
const auth = require("../Middleware/auth");
const requirePermission = require("../Middleware/requirePermission");

const router = require("express").Router();

router.get("/", auth, requirePermission("customer.view"), getCustomers);
router.post("/", auth, requirePermission("customer.create"), createCustomer);
router.put("/:id", auth, requirePermission("customer.edit"), updateCustomer);
router.delete("/:id", auth, requirePermission("customer.delete"), deleteCustomer);
// "sales.payment" (not customer.*) — recording a payment is a Sales-
// module money action, same grouping sales.return already sets for
// undoing a sale, not a Customer-record-editing action.
router.get("/:id/payments", auth, requirePermission("sales.payment"), getCustomerPayments);
router.post("/:id/payments", auth, requirePermission("sales.payment"), recordCustomerPayment);

module.exports = router;
