const {
  getTransactionTypes,
  createTransactionType,
  updateTransactionType,
  deleteTransactionType,
  getBlueprints,
} = require("../Controllers/TransactionType");
const auth = require("../Middleware/auth");
const requirePermission = require("../Middleware/requirePermission");

const router = require("express").Router();

// Before "/" so it can never be shadowed by a future "/:id" route.
// The catalogue of kinds a business can create a type from — see
// Utils/transactionTypeBlueprints.js. Gated on the same view
// permission as the list itself.
router.get("/blueprints", auth, requirePermission("transactiontype.view"), getBlueprints);

router.get("/", auth, requirePermission("transactiontype.view"), getTransactionTypes);
router.post("/", auth, requirePermission("transactiontype.create"), createTransactionType);
router.put("/:id", auth, requirePermission("transactiontype.edit"), updateTransactionType);
router.delete("/:id", auth, requirePermission("transactiontype.delete"), deleteTransactionType);

module.exports = router;
