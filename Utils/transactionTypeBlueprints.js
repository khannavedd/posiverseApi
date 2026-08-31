// The catalogue a business picks from when adding a transaction type
// (DEC-027). Each blueprint is a KIND — what sort of document this is —
// plus sensible defaults for every flag.
//
// WHY KIND EXISTS AT ALL
// "Module" ('sales' | 'inventory') is too coarse to drive a form:
// Purchase Entry and Stock Update are both 'inventory' but need
// different fields and different required values. Kind is the thing the
// app switches on to choose a form, and the API switches on to know
// which rules apply.
//
// A business can create SEVERAL types of the same kind — "Damage
// write-off" and "Expiry write-off" are both stock_update, each with its
// own name and its own document numbering, reporting separately. That is
// the point of the whole design; without Kind there is no way to know
// what a type the owner invented actually means.
//
// `formAvailable: false` means the app has no entry screen for this kind
// yet. Those blueprints are NOT offered in the picker — letting someone
// create a type that opens nothing is worse than not offering it. Flip
// the flag when the screen exists; nothing else needs to change.
//
// These defaults are a STARTING POINT. The owner can rename the type and
// change any flag afterwards. The API re-validates whatever they end up
// with rather than trusting the blueprint was left intact.
const BLUEPRINTS = [
  {
    kind: "sale",
    label: "Sales invoice",
    description: "Sell to a customer at the till.",
    formAvailable: true,
    defaults: {
      module: "sales",
      direction: "out",
      calculateTax: true,
      discountAllowed: true,
      paymentModeRequired: true,
      customerMandatory: false,
      vendorMandatory: false,
      employeeMandatory: false,
      salesImpact: true,
      updateStock: true,
    },
  },
  {
    kind: "sale_return",
    label: "Sales return",
    description: "Take goods back, refund or credit the customer.",
    formAvailable: true,
    defaults: {
      module: "sales",
      direction: "in",
      calculateTax: true,
      discountAllowed: false,
      paymentModeRequired: true,
      customerMandatory: false,
      vendorMandatory: false,
      employeeMandatory: false,
      salesImpact: true,
      updateStock: true,
    },
  },
  {
    kind: "receive_payment",
    label: "Receive payment",
    description: "Collect against a customer's outstanding balance.",
    formAvailable: true,
    defaults: {
      module: "sales",
      // Direction is never read for this kind — updateStock is false and
      // both engine consumers test that first. It needs *a* value only
      // because the column is NOT NULL. See DEC-024.
      direction: "adjustment",
      calculateTax: false,
      discountAllowed: false,
      paymentModeRequired: true,
      customerMandatory: true,
      vendorMandatory: false,
      employeeMandatory: false,
      salesImpact: false,
      updateStock: false,
    },
  },
  {
    kind: "purchase",
    label: "Purchase entry",
    description: "Receive goods from a vendor.",
    formAvailable: true,
    defaults: {
      module: "inventory",
      direction: "in",
      calculateTax: true,
      discountAllowed: true,
      paymentModeRequired: true,
      customerMandatory: false,
      vendorMandatory: true,
      employeeMandatory: false,
      salesImpact: false,
      updateStock: true,
    },
  },
  {
    kind: "purchase_return",
    label: "Purchase return",
    description: "Send goods back to a vendor.",
    formAvailable: true,
    defaults: {
      module: "inventory",
      direction: "out",
      calculateTax: true,
      discountAllowed: false,
      paymentModeRequired: true,
      customerMandatory: false,
      vendorMandatory: true,
      employeeMandatory: false,
      salesImpact: false,
      updateStock: true,
    },
  },
  {
    kind: "stock_update",
    label: "Stock update",
    description: "Correct stock. Damage, theft, recount.",
    formAvailable: true,
    defaults: {
      module: "inventory",
      // 'out' rather than 'adjustment' deliberately: the engine skips
      // 'adjustment' entirely, so a stock update set to it would record
      // a document and move no stock. Removing stock is the common
      // manual correction; a business needing the other way creates a
      // second type set to 'in'.
      direction: "out",
      calculateTax: false,
      discountAllowed: false,
      paymentModeRequired: false,
      customerMandatory: false,
      vendorMandatory: false,
      employeeMandatory: false,
      salesImpact: false,
      updateStock: true,
    },
  },
  {
    kind: "stock_transfer",
    label: "Stock transfer",
    description: "Move stock from one store to another.",
    // No entry screen. A transfer needs a destination store, and a
    // decision about whether it is one document or a paired out/in.
    // Deliberately not offered until that is built.
    formAvailable: false,
    defaults: {
      module: "inventory",
      direction: "adjustment",
      calculateTax: false,
      discountAllowed: false,
      paymentModeRequired: false,
      customerMandatory: false,
      vendorMandatory: false,
      employeeMandatory: false,
      salesImpact: false,
      updateStock: true,
    },
  },
];

const KINDS = BLUEPRINTS.map(b => b.kind);

const byKind = Object.fromEntries(BLUEPRINTS.map(b => [b.kind, b]));

// What the picker shows. Kinds without a form are filtered out here
// rather than in the app, so there is one place that decides.
function availableBlueprints() {
  return BLUEPRINTS.filter(b => b.formAvailable).map(({ kind, label, description, defaults }) => ({
    kind,
    label,
    description,
    defaults,
  }));
}

module.exports = { BLUEPRINTS, KINDS, byKind, availableBlueprints };
