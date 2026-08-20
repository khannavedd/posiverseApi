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
 const PurchaseRoutes = require("./Routes/Purchase");
 const TransactionTypeRoutes = require("./Routes/TransactionType");
 const PaymentTypeRoutes = require("./Routes/PaymentType");

const PORT = process.env.PORT || 8080;

const maxPayloadSize = "100mb";
app.use(bodyParser.json({ limit: maxPayloadSize }));
app.use(bodyParser.urlencoded({ limit: maxPayloadSize, extended: true }));

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
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
 app.use("/purchases", PurchaseRoutes);
 app.use("/transaction-types", TransactionTypeRoutes);
 app.use("/payment-types", PaymentTypeRoutes);
 // POST /register — the onboarding website lives in its own separate
 // project and calls this over plain HTTP (CORS is wide open above),
 // not served from here.
 app.use("/", RegistrationRoutes);

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});