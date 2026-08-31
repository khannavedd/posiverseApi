const pubsub = require("./pubsub");

// Single centralized place every module publishes to Pub/Sub through —
// no outbox table, no background sweep, no HTTP self-call. A write
// commits to Postgres, then calls this directly, in the same request.
//
// One message per aggregate write (e.g. one per Purchase), not one per
// line item — matching how Posible's own Firestore-trigger-based
// pipeline does it (onWrite fires once per document; the consumer
// loops over LineItems itself). InventoryID here is the aggregate's
// own ID (e.g. PurchaseID), not a per-product composite key.
//
// Tradeoff this implies (previously avoided by the transactional
// outbox pattern that lived in Controllers/Outbox.js): if the process
// crashes or Pub/Sub is unreachable in the moment between COMMIT and
// this call resolving, that event is lost — nothing retries it later.
// Callers await this before responding (see Controllers/Inventory.js)
// specifically so Cloud Run keeps the instance's CPU active until the
// publish finishes; a fire-and-forget call after res.json() is not
// safe on Cloud Run; the instance can freeze immediately after the
// response is sent, with no guarantee a background call completes.
const TOPIC_BY_AGGREGATE = {
  Inventory: process.env.PUBSUB_TOPIC_INVENTORY,
  // Sale gets its own topic/subscriber pair rather than reusing
  // Inventory's — explicit decision, so Purchase's and Sale's InStock
  // consumers stay fully independent (separate deploy, separate
  // failure domain) instead of one consumer branching on eventType.
  Sales: process.env.PUBSUB_TOPIC_SALES,
};

async function publishEvent({ aggregateType, eventType, beforeData, afterData, inventoryId }) {
  const topicName = TOPIC_BY_AGGREGATE[aggregateType];
  if (!topicName) {
    throw new Error(`No Pub/Sub topic configured for AggregateType "${aggregateType}"`);
  }

  const messageData = { eventType, beforeData, afterData, InventoryID: inventoryId };
  const dataBuffer = Buffer.from(JSON.stringify(messageData));

  try {
    await pubsub.topic(topicName).publish(dataBuffer);
    console.log(`✅ ${eventType} message published to Pub/Sub topic "${topicName}" for InventoryID ${inventoryId}`);
  } catch (error) {
    console.error(`❌ Error publishing ${eventType} message to Pub/Sub topic "${topicName}" for InventoryID ${inventoryId}:`, error);
    throw error;
  }
}

function inventorySnapshot(doc) {
  return {
    InventoryID: doc.InventoryID,
    StoreID: doc.StoreID,
    VendorID: doc.VendorID,
    TransactionTypeID: doc.TransactionTypeID,
    TransactionNo: doc.TransactionNo,
    TransactionDate: doc.TransactionDate,
    DueAmount: doc.DueAmount,
  };
}

// Publishes an inventory document create/update as a single event —
// afterData carries the whole header plus every line item, and
// inventoryId is the document's own ID. Consumers (posiverse-engine)
// loop over afterData.items themselves to apply each line's InStock
// adjustment, and diff beforeData vs. afterData for anything that needs
// the delta (e.g. Vendor.DueAmount) rather than the controller
// computing and applying that itself.
//
// beforeDoc/beforeItems are omitted for a create (nothing existed
// before) and required for an update — see Controllers/Inventory.js's
// updateInventory, which fetches the pre-edit document + items before
// overwriting them specifically so this function has something to put
// in beforeData.
//
// WIRE FORMAT CHANGED (DEC-026): the payload key is now `inventory`
// (was `purchase`) and eventType is InventoryCreated/InventoryUpdated
// (was PurchaseCreated/PurchaseUpdated), following the table rename.
// posiverse-engine accepts BOTH spellings, so the two services can be
// deployed in either order without a message in flight being dropped.
// Deploy the engine first regardless — it is the tolerant side.
async function publishInventoryEvent({ eventType, doc, items, beforeDoc, beforeItems }) {
  await publishEvent({
    aggregateType: "Inventory",
    eventType,
    beforeData: beforeDoc
      ? { inventory: inventorySnapshot(beforeDoc), items: beforeItems || [] }
      : null,
    afterData: { inventory: inventorySnapshot(doc), items },
    inventoryId: doc.InventoryID,
  });
}

function saleSnapshot(sale) {
  return {
    SaleID: sale.SaleID,
    StoreID: sale.StoreID,
    CustomerID: sale.CustomerID,
    TransactionTypeID: sale.TransactionTypeID,
    InvoiceNumber: sale.InvoiceNumber,
    SaleDate: sale.SaleDate,
    DueAmount: sale.DueAmount,
    // TotalAmount/Status added for posiverse-engine's customerDue
    // consumer — a "Receive Payment" Sale (see Controllers/Sale.js's
    // recordCustomerPayment) has no DueAmount to speak of; the
    // consumer needs TotalAmount (what was actually received) and
    // Status (so a cancelled payment correctly stops counting, the
    // same way a cancelled regular sale's DueAmount is zeroed) to
    // apply it to Customer.OutstandingBalance.
    TotalAmount: sale.TotalAmount,
    Status: sale.Status,
    // customerDue needs this to tell a SALE_RETURN settled as "credit
    // to account" (balance goes down) from one settled as a cash refund
    // (money already handed back at the till — the balance must NOT
    // also move, or the customer is credited twice). See DEC-021.
    PaymentMethod: sale.PaymentMethod,
  };
}

// Same shape/pattern as publishInventoryEvent, published to the separate
// "Sales" topic instead — see TOPIC_BY_AGGREGATE above.
async function publishSaleEvent({ eventType, sale, items, beforeSale, beforeItems }) {
  await publishEvent({
    aggregateType: "Sales",
    eventType,
    beforeData: beforeSale
      ? { sale: saleSnapshot(beforeSale), items: beforeItems || [] }
      : null,
    afterData: { sale: saleSnapshot(sale), items },
    inventoryId: sale.SaleID,
  });
}

module.exports = { publishEvent, publishInventoryEvent, publishSaleEvent };
