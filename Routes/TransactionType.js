const {
  getTransactionTypes,
  createTransactionType,
  updateTransactionType,
  deleteTransactionType,
} = require("../Controllers/TransactionType");
const auth = require("../Middleware/auth");
const requirePermission = require("../Middleware/requirePermission");

const router = require("express").Router();

router.get("/", auth, requirePermission("transactiontype.view"), getTransactionTypes);
router.post("/", auth, requirePermission("transactiontype.create"), createTransactionType);
router.put("/:id", auth, requirePermission("transactiontype.edit"), updateTransactionType);
router.delete("/:id", auth, requirePermission("transactiontype.delete"), deleteTransactionType);

module.exports = router;
