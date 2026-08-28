const { getCustomers, createCustomer, updateCustomer, deleteCustomer } = require("../Controllers/Customer");
// recordCustomerPayment/getCustomerPayments live in Sale's controller,
// not Customer's — a recorded payment is an actual Sale row (see
// Controllers/Sale.js's recordCustomerPayment for why). Still exposed
// under /customers/:id/payments, since that's the right REST resource
// from the caller's point of view regardless of backend storage.
const { recordCustomerPayment, getCustomerPayments } = require("../Controllers/Sale");
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
