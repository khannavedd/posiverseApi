const multer = require("multer");

// Same shape as Routes/PrintTemplate.js's uploader — memory storage so
// the file never touches this container's disk, 5MB cap, images only,
// and multer's own errors turned into real 400s instead of the global
// handler's generic 500.
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

function handleUpload(req, res, next) {
  upload.single("image")(req, res, err => {
    if (err) {
      const message =
        err.code === "LIMIT_FILE_SIZE" ? "Image must be 5MB or smaller." : err.message || "Upload failed.";
      return res.status(400).json({ success: false, message });
    }
    next();
  });
}

const {
  getCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  uploadCategoryImage,
  removeCategoryImage,
} = require("../Controllers/Category");
const auth = require("../Middleware/auth");
const requirePermission = require("../Middleware/requirePermission");

const router = require("express").Router();

router.get("/", auth, requirePermission("catalog.view"), getCategories);
router.post("/", auth, requirePermission("catalog.create"), createCategory);
router.put("/:id", auth, requirePermission("catalog.edit"), updateCategory);
router.delete("/:id", auth, requirePermission("catalog.delete"), deleteCategory);

// Image upload/remove. Gated on catalog.edit — adding a picture is
// editing the category, not creating one.
router.post("/:id/image", auth, requirePermission("catalog.edit"), handleUpload, uploadCategoryImage);
router.delete("/:id/image", auth, requirePermission("catalog.edit"), removeCategoryImage);

module.exports = router;
