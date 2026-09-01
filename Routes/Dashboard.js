const { getDashboard } = require("../Controllers/Dashboard");
const auth = require("../Middleware/auth");
const requirePermission = require("../Middleware/requirePermission");

const router = require("express").Router();

// One read-only aggregate for the home screen. Gated on dashboard.view,
// the permission the drawer already uses for this screen — so a role
// that can't see the dashboard can't pull its figures via the API either.
router.get("/", auth, requirePermission("dashboard.view"), getDashboard);

module.exports = router;
