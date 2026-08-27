const { login, getStores } = require("../Controllers/Auth");
const auth = require("../Middleware/auth");
const { loginLimiter } = require("../Middleware/rateLimit");

const router = require("express").Router();
router.post("/login", loginLimiter, login);
router.get("/stores", auth, getStores)


module.exports = router;       