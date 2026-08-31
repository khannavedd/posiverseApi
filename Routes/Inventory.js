const {
  createInventory,
  updateInventory,
  cancelInventory,
  listInventory,
  getInventory,
} = require("../Controllers/Inventory");
const auth = require("../Middleware/auth");
const requirePermission = require("../Middleware/requirePermission");

const router = require("express").Router();

// Mounted at /inventory (see index.js). These endpoints handle INVENTORY
// DOCUMENTS — Purchase Entry today, stock adjustments and transfers once
// those get entry screens. Which kind a document is comes from its
// TransactionTypeID, not from a separate route, exactly as /sales serves
// sales, returns and receive-payment (DEC-025, DEC-026).
//
// Permissions are the single inventory.* family; the old purchase.*
// keys were folded into it by migration 040.
router.get("/", auth, requirePermission("inventory.view"), listInventory);
router.post("/", auth, requirePermission("inventory.create"), createInventory);
router.get("/:id", auth, requirePermission("inventory.view"), getInventory);
router.put("/:id", auth, requirePermission("inventory.edit"), updateInventory);
// inventory.return — undoing a posted document. Cancelling is that same
// concept, mirroring PUT /sales/:id/cancel.
router.put("/:id/cancel", auth, requirePermission("inventory.return"), cancelInventory);

module.exports = router;
