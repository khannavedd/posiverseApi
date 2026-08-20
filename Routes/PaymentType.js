const {
  getPaymentTypes,
  createPaymentType,
  updatePaymentType,
  deletePaymentType,
} = require("../Controllers/PaymentType");
const auth = require("../Middleware/auth");
const requirePermission = require("../Middleware/requirePermission");

const router = require("express").Router();

router.get("/", auth, requirePermission("paymenttype.view"), getPaymentTypes);
router.post("/", auth, requirePermission("paymenttype.create"), createPaymentType);
router.put("/:id", auth, requirePermission("paymenttype.edit"), updatePaymentType);
router.delete("/:id", auth, requirePermission("paymenttype.delete"), deletePaymentType);

module.exports = router;
