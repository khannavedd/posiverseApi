const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const app = express();
require("dotenv").config();

const errorHandler = (err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send("Something broke!");
};

const pool = require("./DB/postgres");

async function test() {
    try {
        const result = await pool.query("SELECT NOW()");
        console.log(result.rows);
    } catch (err) {
        console.error(err);
    }
}

test();
 const AuthRoutes = require("./Routes/Auth");
 const ProductRoutes = require("./Routes/Product");
 const SaleRoutes = require("./Routes/Sale");
 const RegistrationRoutes = require("./Routes/Registration");
 const CategoryRoutes = require("./Routes/Category");
 const BrandRoutes = require("./Routes/Brand");
 const TaxRoutes = require("./Routes/Tax");
 const VendorRoutes = require("./Routes/Vendor");
 const CustomerRoutes = require("./Routes/Customer");
 const InventoryRoutes = require("./Routes/Inventory");
const DashboardRoutes = require("./Routes/Dashboard");
 const TransactionTypeRoutes = require("./Routes/TransactionType");
 const PaymentTypeRoutes = require("./Routes/PaymentType");
 const PrintTemplateRoutes = require("./Routes/PrintTemplate");

const PORT = process.env.PORT || 8080;

// Cloud Run sits the container behind exactly one Google-managed proxy
// hop, which sets X-Forwarded-For to the real client IP — trusting
// that one hop is what lets express-rate-limit (see Middleware/
// rateLimit.js) key by actual client IP instead of Cloud Run's own
// internal address. `1` = trust exactly one hop, not "trust anything"
// (see https://expressjs.com/en/guide/behind-proxies.html). Harmless
// locally too — `req.ip` just falls back to the direct socket address
// when there's no proxy in front of it.
app.set("trust proxy", 1);

const maxPayloadSize = "100mb";
app.use(bodyParser.json({ limit: maxPayloadSize }));
app.use(bodyParser.urlencoded({ limit: maxPayloadSize, extended: true }));

// Origin allowlist, not a wildcard. The mobile app itself isn't
// affected either way — CORS is a browser-only mechanism and React
// Native's networking stack doesn't send/enforce it — this only
// matters for browser-based callers (the separate onboarding website,
// and any future web admin panel). CORS_ORIGINS is a comma-separated
// list read from env so new origins can be added without a code
// change/redeploy of this file. Nothing is in there yet because the
// onboarding website isn't deployed anywhere real yet (its own
// config.js still points at localhost) — until CORS_ORIGINS is set,
// this falls back to allowing any origin (unchanged from before) so
// nothing breaks today, but logs a one-time warning so this doesn't
// silently stay wide open once real domains exist. Set CORS_ORIGINS
// (e.g. "https://onboarding.posiverse.app,https://admin.posiverse.app")
// in the environment as soon as those are deployed.
//
// credentials: true was dropped — this API has no cookie/session-based
// auth (every protected route reads a Bearer token from the
// Authorization header, attached explicitly by client code, never an
// ambient browser credential), so there's nothing for that flag to
// protect here, and pairing it with a wildcard origin is meaningless
// to browsers anyway (they reject that combination outright).
const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map(o => o.trim())
  .filter(Boolean);

if (allowedOrigins.length === 0) {
  console.warn(
    "CORS_ORIGINS is not set — allowing all origins. Set CORS_ORIGINS once the onboarding website / admin panel have real domains."
  );
}

app.use(
  cors({
    origin: allowedOrigins.length === 0 ? true : allowedOrigins,
    methods: ["GET", "POST", "PUT", "DELETE"],
  })
);

 app.use("/user", AuthRoutes);
 app.use("/products", ProductRoutes);
 app.use("/sales", SaleRoutes);
 app.use("/categories", CategoryRoutes);
 app.use("/brands", BrandRoutes);
 app.use("/taxes", TaxRoutes);
 app.use("/vendors", VendorRoutes);
 app.use("/customers", CustomerRoutes);
 app.use("/inventory", InventoryRoutes);
app.use("/dashboard", DashboardRoutes);
 app.use("/transaction-types", TransactionTypeRoutes);
 app.use("/payment-types", PaymentTypeRoutes);
 app.use("/print-templates", PrintTemplateRoutes);
 // POST /register — the onboarding website lives in its own separate
 // project and calls this over plain HTTP (CORS is wide open above),
 // not served from here.
 app.use("/", RegistrationRoutes);

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});