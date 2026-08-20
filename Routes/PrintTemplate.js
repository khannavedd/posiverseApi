const { getPrintTemplate, updatePrintTemplate } = require("../Controllers/PrintTemplate");
const auth = require("../Middleware/auth");
const requirePermission = require("../Middleware/requirePermission");

const router = require("express").Router();

router.get("/:documentType", auth, requirePermission("printtemplate.view"), getPrintTemplate);
router.put("/:documentType", auth, requirePermission("printtemplate.edit"), updatePrintTemplate);

module.exports = router;
