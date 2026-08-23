const multer = require("multer");
const {
  getPrintTemplate,
  updatePrintTemplate,
  uploadPrintTemplateLogo,
  removePrintTemplateLogo,
} = require("../Controllers/PrintTemplate");
const auth = require("../Middleware/auth");
const requirePermission = require("../Middleware/requirePermission");

const router = require("express").Router();

// Memory storage, not disk — the file only ever needs to exist as a
// buffer long enough to hand to GCS (see Controllers/PrintTemplate.js's
// uploadPrintTemplateLogo), never written to this container's own
// filesystem. 5MB cap and image-only filter both reject before the
// full body is even buffered.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed."));
    }
    cb(null, true);
  },
});

// index.js's global errorHandler is a generic 500 ("Something broke!")
// — good enough for real server errors, but multer's own errors (file
// too big, wrong field name, fileFilter's rejection above) are user
// mistakes that deserve a real 400 message instead of a scary 500.
function handleUpload(req, res, next) {
  upload.single("logo")(req, res, err => {
    if (err) {
      const message = err.code === "LIMIT_FILE_SIZE" ? "Image must be 5MB or smaller." : err.message || "Upload failed.";
      return res.status(400).json({ success: false, message });
    }
    next();
  });
}

router.get("/:documentType", auth, requirePermission("printtemplate.view"), getPrintTemplate);
router.put("/:documentType", auth, requirePermission("printtemplate.edit"), updatePrintTemplate);
router.post("/:documentType/logo", auth, requirePermission("printtemplate.edit"), handleUpload, uploadPrintTemplateLogo);
router.delete("/:documentType/logo", auth, requirePermission("printtemplate.edit"), removePrintTemplateLogo);

module.exports = router;
