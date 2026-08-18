const { login, getStores } = require("../Controllers/Auth");
const auth = require("../Middleware/auth");

const router = require("express").Router();
router.post("/login", login);
router.get("/stores", auth, getStores)


module.exports = router;       