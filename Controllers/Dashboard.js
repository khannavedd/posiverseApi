const pool = require("../DB/postgres");

// GET /dashboard — everything the home screen shows, in one request.
//
// WHY THIS EXISTS
// The app used to fetch EVERY sale in the business and total them in
// JavaScript on the phone. That works with fifty sales and gets slower
// every day a shop trades; by a few thousand it's downloading megabytes
// to display six numbers. All of this is SUM/COUNT/GROUP BY in Postgres
// now, returning a few hundred bytes.
//
// WHAT COUNTS AS REVENUE — the one thing worth getting right
// Only documents whose TransactionType.Kind is 'sale'. Deliberately NOT:
//   sale_return      — money going back out; counting it as revenue
//                      would inflate takings on the worst days
//   receive_payment  — collecting an old debt is not a new sale. The
//                      revenue was already booked when the sale happened
//                      (DEC-017 records these as Sale rows, which is
//                      exactly why filtering by Kind matters here)
// Cancelled documents are excluded everywhere.
//
// SCOPING: every figure is per-store, taken from the caller's own
// registration. storeId is validated against RegistrationID rather than
// trusted, so a crafted id can't read another business's takings.
const SALE_KIND_FILTER = `tt."Kind" = 'sale' AND s."Status" <> 'cancelled'`;

module.exports.getDashboard = async (req, res) => {
  try {
    const { storeId } = req.query;
    if (!storeId) {
      return res.status(400).json({ success: false, message: "storeId is required" });
    }

    const storeCheck = await pool.query(
      `SELECT "StoreID" FROM "Store" WHERE "StoreID" = $1 AND "RegistrationID" = $2`,
      [storeId, req.user.RegistrationID]
    );
    if (storeCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Store not found" });
    }

    // Periods are computed in Postgres from now(), not passed in by the
    // client — a phone with a wrong clock shouldn't be able to shift what
    // "today" means. All ranges are half-open [start, end) so a sale at
    // exactly midnight lands in exactly one bucket.
    //
    // Each period also carries the one before it, so the screen can say
    // "better or worse than usual" instead of showing a number with no
    // reference point.
    const money = await pool.query(
      `WITH sales AS (
         SELECT s."TotalAmount", s."SaleDate"
         FROM "Sale" s
         JOIN "TransactionType" tt ON tt."TransactionTypeID" = s."TransactionTypeID"
         WHERE s."StoreID" = $1 AND ${SALE_KIND_FILTER}
       )
       SELECT
         COALESCE(SUM("TotalAmount") FILTER (WHERE "SaleDate" >= date_trunc('day', now())), 0) AS today_total,
         COUNT(*) FILTER (WHERE "SaleDate" >= date_trunc('day', now())) AS today_count,
         COALESCE(SUM("TotalAmount") FILTER (WHERE "SaleDate" >= date_trunc('day', now()) - interval '1 day'
                                               AND "SaleDate" <  date_trunc('day', now())), 0) AS yesterday_total,

         COALESCE(SUM("TotalAmount") FILTER (WHERE "SaleDate" >= date_trunc('week', now())), 0) AS week_total,
         COUNT(*) FILTER (WHERE "SaleDate" >= date_trunc('week', now())) AS week_count,
         COALESCE(SUM("TotalAmount") FILTER (WHERE "SaleDate" >= date_trunc('week', now()) - interval '1 week'
                                               AND "SaleDate" <  date_trunc('week', now())), 0) AS prev_week_total,

         COALESCE(SUM("TotalAmount") FILTER (WHERE "SaleDate" >= date_trunc('month', now())), 0) AS month_total,
         COUNT(*) FILTER (WHERE "SaleDate" >= date_trunc('month', now())) AS month_count,
         COALESCE(SUM("TotalAmount") FILTER (WHERE "SaleDate" >= date_trunc('month', now()) - interval '1 month'
                                               AND "SaleDate" <  date_trunc('month', now())), 0) AS prev_month_total
       FROM sales`,
      [storeId]
    );

    // Receivables and payables are running balances maintained by
    // posiverse-engine (customerDue.js / vendorDue.js), so this is a
    // straight read rather than a re-derivation. Counting only non-zero
    // balances — "12 customers owe you" is more useful than the number
    // of customers on file.
    //
    // Customer is scoped by RegistrationID; Vendor likewise. Neither is
    // per-store: a customer's balance follows them across a business's
    // stores.
    const balances = await pool.query(
      `SELECT
         (SELECT COALESCE(SUM("OutstandingBalance"), 0) FROM "Customer"
           WHERE "RegistrationID" = $1 AND "IsActive" AND "OutstandingBalance" > 0) AS receivable_total,
         (SELECT COUNT(*)::int FROM "Customer"
           WHERE "RegistrationID" = $1 AND "IsActive" AND "OutstandingBalance" > 0) AS receivable_count,
         (SELECT COALESCE(SUM("DueAmount"), 0) FROM "Vendor"
           WHERE "RegistrationID" = $1 AND "IsActive" AND "DueAmount" > 0) AS payable_total,
         (SELECT COUNT(*)::int FROM "Vendor"
           WHERE "RegistrationID" = $1 AND "IsActive" AND "DueAmount" > 0) AS payable_count`,
      [req.user.RegistrationID]
    );

    // Stock needing attention. There is no reorder level anywhere in the
    // schema, so "low stock" cannot be computed — only "none left" and
    // "gone negative" can. Negative is surfaced separately because it
    // means something went wrong (the oversell race in DEC-020, or a
    // stock count entered against the wrong product), not merely that
    // the shelf is empty.
    const stock = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE i."InStockQty" = 0)::int AS out_of_stock,
         COUNT(*) FILTER (WHERE i."InStockQty" < 0)::int AS negative_stock
       FROM "InStock" i
       JOIN "Product" p ON p."ProductID" = i."ProductID"
       WHERE i."StoreID" = $1 AND p."IsActive"`,
      [storeId]
    );

    // Top products this month, by revenue rather than quantity — five
    // units of rice matters more than five sachets of shampoo, and the
    // shopkeeper's question is "what's making me money".
    const topProducts = await pool.query(
      `SELECT p."ProductID", p."Name",
              SUM(si."Quantity")::numeric AS qty,
              SUM(si."LineTotal")::numeric AS revenue
       FROM "SaleItem" si
       JOIN "Sale" s ON s."SaleID" = si."SaleID"
       JOIN "TransactionType" tt ON tt."TransactionTypeID" = s."TransactionTypeID"
       JOIN "Product" p ON p."ProductID" = si."ProductID"
       WHERE s."StoreID" = $1 AND ${SALE_KIND_FILTER}
         AND s."SaleDate" >= date_trunc('month', now())
       GROUP BY p."ProductID", p."Name"
       ORDER BY revenue DESC
       LIMIT 5`,
      [storeId]
    );

    // Seven-day trend. generate_series supplies every day so a day with
    // no sales comes back as zero rather than being missing — otherwise
    // the chart silently compresses quiet days out of existence and the
    // shape lies.
    const trend = await pool.query(
      `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
              COALESCE(SUM(s."TotalAmount"), 0) AS total
       FROM generate_series(date_trunc('day', now()) - interval '6 days',
                            date_trunc('day', now()), interval '1 day') AS d(day)
       LEFT JOIN "Sale" s
         ON s."SaleDate" >= d.day AND s."SaleDate" < d.day + interval '1 day'
        AND s."StoreID" = $1
        AND s."Status" <> 'cancelled'
        AND s."TransactionTypeID" IN (
              SELECT "TransactionTypeID" FROM "TransactionType"
              WHERE "RegistrationID" = $2 AND "Kind" = 'sale')
       GROUP BY d.day
       ORDER BY d.day`,
      [storeId, req.user.RegistrationID]
    );

    // Recent sales. Served from HERE rather than from GET /sales, which
    // was the obvious shortcut and is wrong: that endpoint returns every
    // document in the sales module, so a receive-payment would appear in
    // the list as a row with an invoice number and an amount, sitting
    // directly beneath a takings figure that deliberately excludes it.
    // Same SALE_KIND_FILTER as the money query, so the list and the
    // number can't disagree.
    const recent = await pool.query(
      `SELECT s."SaleID", s."InvoiceNumber", s."SaleDate", s."TotalAmount",
              c."Name" AS "CustomerName"
       FROM "Sale" s
       JOIN "TransactionType" tt ON tt."TransactionTypeID" = s."TransactionTypeID"
       LEFT JOIN "Customer" c ON c."CustomerID" = s."CustomerID"
       WHERE s."StoreID" = $1 AND ${SALE_KIND_FILTER}
       ORDER BY s."SaleDate" DESC
       LIMIT 5`,
      [storeId]
    );

    const m = money.rows[0];
    const b = balances.rows[0];

    return res.json({
      success: true,
      dashboard: {
        money: {
          today: { total: Number(m.today_total), count: Number(m.today_count), previous: Number(m.yesterday_total) },
          week: { total: Number(m.week_total), count: Number(m.week_count), previous: Number(m.prev_week_total) },
          month: { total: Number(m.month_total), count: Number(m.month_count), previous: Number(m.prev_month_total) },
        },
        balances: {
          receivable: { total: Number(b.receivable_total), count: b.receivable_count },
          payable: { total: Number(b.payable_total), count: b.payable_count },
        },
        stock: {
          outOfStock: stock.rows[0].out_of_stock,
          negative: stock.rows[0].negative_stock,
          // Explicit rather than absent, so the screen can say why it
          // isn't showing a low-stock figure instead of leaving a gap.
          lowStockSupported: false,
        },
        topProducts: topProducts.rows.map(r => ({
          productId: r.ProductID,
          name: r.Name,
          qty: Number(r.qty),
          revenue: Number(r.revenue),
        })),
        trend: trend.rows.map(r => ({ day: r.day, total: Number(r.total) })),
        // Enough to render a row and navigate; SaleView refetches the
        // full document by id, so sending s.* here would be dead weight.
        recentSales: recent.rows.map(r => ({
          SaleID: r.SaleID,
          InvoiceNumber: r.InvoiceNumber,
          SaleDate: r.SaleDate,
          TotalAmount: Number(r.TotalAmount),
          CustomerName: r.CustomerName,
        })),
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error loading the dashboard" });
  }
};
