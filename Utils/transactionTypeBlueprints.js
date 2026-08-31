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
// SIX KINDS, and that is the whole list (DEC-030). Sales invoice, sales
// return, receive payment, purchase entry, purchase return, stock
// update. Stock transfer was removed rather than left hidden — an
// unreachable entry in a closed vocabulary is just clutter.
//
// ADDING A SEVENTH LATER is meant to be easy, and this is the recipe:
//   1. add a blueprint here with its kind, label and defaults
//   2. add the kind to the CHECK constraint (a migration)
//   3. map it to an entry screen in the app's Utils/transactionKinds.js
//   4. if it needs a form that doesn't exist, build that first
// `formAvailable: false` keeps a kind out of the picker while step 4 is
// outstanding — letting someone create a type that opens nothing is
// worse than not offering it.
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
      // Never read for this kind — updateStock is false and both engine
      // consumers test that first. It carries a value only because the
      // column is NOT NULL, and the form hides the picker (DEC-030).
      direction: "out",
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
    description: "Count the shelf and set stock to what\u2019s there.",
    formAvailable: true,
    defaults: {
      module: "inventory",
      // Never read for this kind either. A stock update SETS stock to
      // the counted quantity (DEC-029), and the engine keys that on
      // Kind, not on Direction (DEC-030).
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
