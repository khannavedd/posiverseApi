const crypto = require("crypto");
const pool = require("../DB/postgres");
const { auth } = require("../DB/firebase");

// "Registration" and "Store" pre-date this codebase and have two NOT
// NULL bigint columns (BusinessTypeID, PlanID) with no corresponding
// lookup table in the DB, and nothing in the API has ever written to
// them beyond this placeholder. These stay placeholders until
// BusinessType/Plan tables exist for real.
//
// User.RoleID (a similar placeholder) has been dropped entirely — see
// migration 008_drop_user_roleid.sql. Access control has only ever
// come from ACL, keyed by User.UID (the Firebase UID), and that's the
// only place a role/permission is recorded now.
const BUSINESS_TYPES = {
  1: "Retail",
  2: "Hotel",
};
const DEFAULT_PLAN_ID = 1;

// Mirrors ALL_PERMISSIONS in Posiverse_APP/Utils/permissions.js on the
// mobile side — kept in sync by hand since these are two separate
// codebases. Owner gets every permission that exists. Written into
// ACL.Permissions (see below) instead of leaving it null, so the row
// itself states exactly what this user can do rather than relying only
// on the role name.
//
// No sales.delete / inventory.delete — once posted, a sale or an
// inventory document carries a sequential number from DocumentSeries;
// deleting it would leave a gap in that sequence. Undo one with
// sales.return / inventory.return instead.
const OWNER_PERMISSIONS = [
  "dashboard.view",

  "catalog.view",
  "catalog.create",
  "catalog.edit",
  "catalog.delete",

  // One family for everything in the inventory module — migration 040
  // folded the old purchase.view/create/edit/return into these
  // (DEC-026). Purchase Entry is one kind of inventory document, not a
  // separate area with its own permissions; stock adjustments and
  // transfers use the same four.
  "inventory.view",
  "inventory.create",
  "inventory.edit",
  "inventory.return",
  "inventory.adjust",
  "inventory.transfer",

  "sales.view",
  "sales.create",
  "sales.edit",
  "sales.return",
  "sales.payment",

  "customer.view",
  "customer.create",
  "customer.edit",
  "customer.delete",

  "vendor.view",
  "vendor.create",
  "vendor.edit",
  "vendor.delete",

  "cashregister.open",
  "cashregister.close",
  "cashregister.view",

  "reports.view",
  "reports.export",

  "store.view",
  "store.create",
  "store.edit",

  "users.manage",
  "roles.manage",

  "settings.view",
  "settings.edit",

  "transactiontype.view",
  "transactiontype.create",
  "transactiontype.edit",
  "transactiontype.delete",

  "paymenttype.view",
  "paymenttype.create",
  "paymenttype.edit",
  "paymenttype.delete",

  "printtemplate.view",
  "printtemplate.edit",

  "printer.view",
  "printer.edit",
];

// Registration/User/Store use bigint "ActionOn" columns rather than
// Postgres timestamptz — treated as epoch milliseconds (Date.now()),
// the natural choice for a Node backend since nothing existing
// constrains the unit (grep found zero prior reads/writes of these
// columns anywhere in the API).
module.exports.register = async (req, res) => {
  const {
    businessName,
    businessTypeId,
    email,
    password,
    phoneNo,
    countryCode,
    ownerName,
    address1,
    address2,
    city,
    state,
    country,
    pincode,
  } = req.body;

  if (!businessName || !businessTypeId || !email || !password || !ownerName) {
    return res.status(400).json({
      success: false,
      message: "businessName, businessTypeId, email, password, and ownerName are required.",
    });
  }

  const businessTypeIdNum = Number(businessTypeId);
  if (!BUSINESS_TYPES[businessTypeIdNum]) {
    return res.status(400).json({
      success: false,
      message: `businessTypeId must be one of: ${Object.entries(BUSINESS_TYPES)
        .map(([id, name]) => `${id} (${name})`)
        .join(", ")}`,
    });
  }

  let firebaseUser;
  try {
    firebaseUser = await auth.createUser({
      email,
      password,
      displayName: ownerName,
    });
  } catch (error) {
    const message =
      error.code === "auth/email-already-exists"
        ? "An account with this email already exists."
        : error.code === "auth/invalid-password"
        ? "Password must be at least 6 characters."
        : "Couldn't create the account.";
    return res.status(400).json({ success: false, message });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const registrationId = crypto.randomUUID();
    const now = Date.now();

    await client.query(
      `INSERT INTO "Registration"
        ("RegistrationID", "BusinessName", "BusinessTypeID", "PlanID", "Email", "PhoneNo", "CountryCode",
         "SubscriptionStartOn", "SubscriptionEndOn", "IsDeleted", "ActionBy", "ActionOn")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, false, NULL, $9)`,
      [
        registrationId,
        businessName,
        businessTypeIdNum,
        DEFAULT_PLAN_ID,
        email,
        phoneNo ?? null,
        countryCode ?? null,
        now,
        now,
      ]
    );

    const userId = crypto.randomUUID();
    await client.query(
      `INSERT INTO "User"
        ("UserID", "RegistrationID", "UID", "Name", "Email", "PhoneNo", "IsDeleted", "LastLoginOn", "ActionBy", "ActionOn")
       VALUES ($1, $2, $3, $4, $5, $6, false, $7, NULL, $8)`,
      [userId, registrationId, firebaseUser.uid, ownerName, email, phoneNo ?? null, now, now]
    );

    // The first store is created automatically, named after the
    // business — no separate store form. Everything the registration
    // form already collected gets carried over rather than left null:
    // Email and PhoneNo match the Registration row exactly (same
    // business, same contact details until someone edits the store
    // later), and the address fields use whatever was entered below.
    const storeId = crypto.randomUUID();
    await client.query(
      `INSERT INTO "Store"
        ("StoreID", "RegistrationID", "StoreName", "StoreCode", "Email", "PhoneNo", "Address1", "Address2",
         "City", "State", "Country", "Pincode", "IsDeleted", "ActionBy", "ActionOn")
       VALUES ($1, $2, $3, '01', $4, $5, $6, $7, $8, $9, $10, $11, false, NULL, $12)`,
      [
        storeId,
        registrationId,
        businessName,
        email,
        phoneNo ?? null,
        address1 ?? null,
        address2 ?? null,
        city ?? null,
        state ?? null,
        country ?? null,
        pincode ?? null,
        now,
      ]
    );

    // Every new business starts with these three TransactionTypes —
    // Sales Invoice, Purchase Entry and Stock Update — same
    // per-RegistrationID shape
    // as migration 012's seed (Code is the stable internal key, Name is
    // the editable label). ON CONFLICT is just cheap insurance; this
    // RegistrationID is always brand new here, so it can never actually
    // fire.
    //
    // Purchase Entry's Module is 'inventory', not 'purchase' — see
    // migration 038 (DEC-024). A purchase is how stock arrives, so it
    // lives under Inventory; there are only two modules now, and a
    // CHECK constraint enforces it.
    await client.query(
      `INSERT INTO "TransactionType"
        ("TransactionTypeID", "RegistrationID", "Module", "Kind", "Code", "Name", "Direction", "VendorMandatory")
       VALUES
        ($1, $2, 'sales', 'sale', 'SALE', 'Sales Invoice', 'out', false),
        ($3, $2, 'inventory', 'purchase', 'PURCHASE', 'Purchase Entry', 'in', true),
        ($4, $2, 'inventory', 'stock_update', 'STOCK_UPDATE', 'Stock Update', 'out', false)
       ON CONFLICT ("RegistrationID", "Code") DO NOTHING`,
      [crypto.randomUUID(), registrationId, crypto.randomUUID(), crypto.randomUUID()]
    );

    // "Receive Payment" — its own row, own explicit flags, since it
    // needs different defaults than SALE/PURCHASE above (no stock
    // impact, no tax, not itself a sale). Existing businesses get this
    // same row via migration 032/033's backfill.
    //
    // Direction is 'adjustment' only because the column is NOT NULL and
    // the CHECK from migration 038 allows exactly three values. It is
    // never read for this type: UpdateStock is false, and both engine
    // consumers test UpdateStock before they look at Direction. The
    // Module Configuration form hides the Direction picker when stock
    // is off for the same reason.
    await client.query(
      `INSERT INTO "TransactionType"
        ("TransactionTypeID", "RegistrationID", "Module", "Kind", "Code", "Name", "Direction",
         "CalculateTax", "CustomerMandatory", "DiscountAllowed", "PaymentModeRequired",
         "SalesImpact", "UpdateStock")
       VALUES ($1, $2, 'sales', 'receive_payment', 'RECEIVE_PAYMENT', 'Receive Payment', 'adjustment',
         false, true, false, true, false, false)
       ON CONFLICT ("RegistrationID", "Code") DO NOTHING`,
      [crypto.randomUUID(), registrationId]
    );

    // Every store gets a default cash register/counter so
    // DocumentSeries (invoice numbering) always has a real
    // CashRegisterID to key off of, even before multi-register support
    // is exposed anywhere in the UI.
    await client.query(
      `INSERT INTO "CashRegister" ("CashRegisterID", "StoreID", "Code", "Name", "IsActive")
       VALUES ($1, $2, '01', 'Default CashRegister', true)`,
      [crypto.randomUUID(), storeId]
    );

    // Same 7 defaults migration 026 seeded for pre-existing businesses
    // (see Controllers/PaymentType.js) — missed here originally, so a
    // business registering between migration 026 and this fix got zero
    // PaymentType rows (harmless: usePosSale.js falls back to a
    // hardcoded list when the fetch comes back empty, but every new
    // business should still get real, editable rows like everyone
    // else).
    await client.query(
      `INSERT INTO "PaymentType"
        ("PaymentTypeID", "RegistrationID", "Name", "SequenceNo", "ShowInSales", "IsSystemDefined")
       VALUES
        ($1, $2, 'Cash', 1, true, true),
        ($3, $2, 'GPay', 2, true, true),
        ($4, $2, 'Card', 3, true, true),
        ($5, $2, 'UPI', 4, true, true),
        ($6, $2, 'Wallet', 5, true, true),
        ($7, $2, 'Loyalty', 6, true, true),
        ($8, $2, 'Cash From Counter', 7, true, true)
       ON CONFLICT ("RegistrationID", "Name") DO NOTHING`,
      [crypto.randomUUID(), registrationId, crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
    );

    // Same defaults migration 028 seeded for pre-existing businesses —
    // see Controllers/PrintTemplate.js.
    await client.query(
      `INSERT INTO "PrintTemplate"
        ("PrintTemplateID", "RegistrationID", "DocumentType", "HeaderNote", "FooterMessage", "ShowSignatureLine")
       VALUES
        ($1, $2, 'sale', 'Tax Invoice', 'THANK YOU FOR YOUR BUSINESS', true),
        ($3, $2, 'purchase', 'Purchase Order', '', true)
       ON CONFLICT ("RegistrationID", "DocumentType") DO NOTHING`,
      [crypto.randomUUID(), registrationId, crypto.randomUUID()]
    );

    // The row that actually matters for access control — see the
    // module comment above. StoreID = NULL means "every store under
    // this registration," same convention as the seeded ACL rows.
    // Permissions is set explicitly rather than left null, so the row
    // is self-describing — the mobile app checks this array first and
    // only falls back to the role-name matrix if it's empty.
    await client.query(
      `INSERT INTO "ACL" ("ACLID", "UserID", "StoreID", "Role", "Permissions", "GrantedAt", "Status")
       VALUES ($1, $2, NULL, 'owner', $3, now(), 'active')`,
      [crypto.randomUUID(), firebaseUser.uid, JSON.stringify(OWNER_PERMISSIONS)]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Registration complete.",
      registrationId,
      storeId,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);

    // Don't leave an orphaned Firebase account behind — otherwise a
    // retry with the same email fails with "already exists" even
    // though nothing was actually saved.
    try {
      await auth.deleteUser(firebaseUser.uid);
    } catch (cleanupError) {
      console.error("Failed to roll back Firebase user after DB error:", cleanupError);
    }

    return res.status(500).json({
      success: false,
      message: "Registration failed. Please try again.",
    });
  } finally {
    client.release();
  }
};
