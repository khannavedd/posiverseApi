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
// Callers await this before responding (see Controllers/Purchase.js)
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

function purchaseSnapshot(purchase) {
  return {
    PurchaseID: purchase.PurchaseID,
    StoreID: purchase.StoreID,
    VendorID: purchase.VendorID,
    TransactionTypeID: purchase.TransactionTypeID,
    TransactionNo: purchase.TransactionNo,
    TransactionDate: purchase.TransactionDate,
    DueAmount: purchase.DueAmount,
  };
}

// Publishes a Purchase create/update as a single event — afterData
// carries the whole purchase header plus every line item, and
// InventoryID is the Purchase's own ID. Consumers (posiverse-engine)
// loop over afterData.items themselves to apply each line's InStock
// adjustment, the same way the reference
// onCreateInventoryUpdateInStockQty.js loops over inventory.LineItems,
// and diff beforeData vs. afterData for anything that needs the delta
// (e.g. Vendor.DueAmount) instead of Controllers/Purchase.js computing
// and applying that itself.
//
// beforePurchase/beforeItems are omitted for a create (nothing existed
// before) and required for an update — see Controllers/Purchase.js's
// updatePurchase, which fetches the pre-edit purchase + items before
// overwriting them specifically so this function has something to put
// in beforeData.
async function publishPurchaseEvent({ eventType, purchase, items, beforePurchase, beforeItems }) {
  await publishEvent({
    aggregateType: "Inventory",
    eventType,
    beforeData: beforePurchase
      ? { purchase: purchaseSnapshot(beforePurchase), items: beforeItems || [] }
      : null,
    afterData: { purchase: purchaseSnapshot(purchase), items },
    inventoryId: purchase.PurchaseID,
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
  };
}

// Same shape/pattern as publishPurchaseEvent, published to the separate
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

module.exports = { publishEvent, publishPurchaseEvent, publishSaleEvent };
