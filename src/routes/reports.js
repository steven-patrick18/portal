const express = require('express');
const { db } = require('../db');
const { requireFeature } = require('../middleware/permissions');
const router = express.Router();

// Finance reports (collection / outstanding / aged AR / payment-modes)
// expose money-flow data — gate them on the granular `reports_finance` key
// so the owner can hide them from sub-roles without locking down all reports.
router.use(['/collection', '/outstanding', '/aged-outstanding', '/payment-modes'], requireFeature('reports_finance'));
// Production-side reports
router.use(['/production', '/production-efficiency', '/material-consumption', '/stock'], requireFeature('reports_production'));
// Sales analytics
router.use(['/sales', '/dealer-sales', '/product-sales', '/salesperson-detail', '/salesperson', '/geo-sales', '/product-performance'], requireFeature('reports_sales'));

router.get('/', (req, res) => {
  res.render('reports/index', { title: 'Reports' });
});

// Daily Production
router.get('/production', (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0,10);
  const rows = db.prepare(`
    SELECT pse.stage, p.code AS product_code, p.name AS product_name,
           SUM(pse.qty_in) AS qty_in, SUM(pse.qty_out) AS qty_out, SUM(pse.qty_rejected) AS qty_rej, SUM(pse.total_cost) AS total_cost
    FROM production_stage_entries pse
    JOIN production_batches b ON b.id = pse.batch_id
    JOIN products p ON p.id = b.product_id
    WHERE pse.entry_date = ?
    GROUP BY pse.stage, p.id
    ORDER BY p.name, pse.stage
  `).all(date);
  res.render('reports/production', { title: 'Daily Production Report', rows, date });
});

// Daily Sales / Salesperson
router.get('/sales', (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);
  const daily = db.prepare(`
    SELECT invoice_date AS d, COUNT(*) AS n, SUM(total) AS total
    FROM invoices WHERE invoice_date BETWEEN ? AND ? AND status != 'cancelled'
    GROUP BY invoice_date ORDER BY invoice_date DESC
  `).all(from, to);
  const sp = db.prepare(`
    SELECT u.name, COUNT(i.id) AS invoices, COALESCE(SUM(i.total),0) AS total, COALESCE(SUM(i.paid_amount),0) AS paid
    FROM users u LEFT JOIN invoices i ON i.salesperson_id = u.id AND i.invoice_date BETWEEN ? AND ? AND i.status != 'cancelled'
    WHERE u.role IN ('salesperson','admin','owner')
    GROUP BY u.id ORDER BY total DESC
  `).all(from, to);
  res.render('reports/sales', { title: 'Sales Report', daily, sp, from, to });
});

// Daily Collection
router.get('/collection', (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);
  // Optional single-day drilldown (?day=YYYY-MM-DD) — when set, the
  // "By Salesperson" panel narrows to just that date instead of the full range.
  const day = (req.query.day || '').match(/^\d{4}-\d{2}-\d{2}$/) ? req.query.day : '';
  const daily = db.prepare(`
    SELECT payment_date AS d, COUNT(*) AS n, SUM(amount) AS total
    FROM payments WHERE payment_date BETWEEN ? AND ? AND status='verified'
    GROUP BY payment_date ORDER BY payment_date DESC
  `).all(from, to);
  let bySp;
  if (day) {
    bySp = db.prepare(`
      SELECT u.name, COUNT(p.id) AS pmts, COALESCE(SUM(p.amount),0) AS total
      FROM users u LEFT JOIN payments p ON p.salesperson_id=u.id AND p.payment_date = ? AND p.status='verified'
      WHERE u.role IN ('salesperson','admin','owner')
      GROUP BY u.id ORDER BY total DESC
    `).all(day);
  } else {
    bySp = db.prepare(`
      SELECT u.name, COUNT(p.id) AS pmts, COALESCE(SUM(p.amount),0) AS total
      FROM users u LEFT JOIN payments p ON p.salesperson_id=u.id AND p.payment_date BETWEEN ? AND ? AND p.status='verified'
      WHERE u.role IN ('salesperson','admin','owner')
      GROUP BY u.id ORDER BY total DESC
    `).all(from, to);
  }
  res.render('reports/collection', { title: 'Collection Report', daily, bySp, from, to, day });
});

// Outstanding
router.get('/outstanding', (req, res) => {
  // "paid" sums verified payments — see src/routes/dealers.js for why.
  const rows = db.prepare(`
    SELECT d.id, d.code, d.name, d.phone, d.city, d.credit_limit, d.opening_balance, u.name AS sp_name,
      COALESCE((SELECT SUM(total)  FROM invoices WHERE dealer_id=d.id AND status!='cancelled'),0) AS billed,
      COALESCE((SELECT SUM(amount) FROM payments WHERE dealer_id=d.id AND status='verified'),0) AS paid
    FROM dealers d LEFT JOIN users u ON u.id=d.salesperson_id
    WHERE d.active = 1
  `).all();
  rows.forEach(r => r.outstanding = (r.opening_balance||0) + r.billed - r.paid);
  rows.sort((a,b) => b.outstanding - a.outstanding);
  const totalOut = rows.reduce((s,r) => s + r.outstanding, 0);
  res.render('reports/outstanding', { title: 'Outstanding Report', rows, totalOut });
});

// Stock
router.get('/stock', (req, res) => {
  const rows = db.prepare(`
    SELECT p.code, p.name, p.size, p.color, p.unit, p.reorder_level, p.cost_price, p.sale_price,
           COALESCE(rs.quantity,0) AS qty
    FROM products p LEFT JOIN ready_stock rs ON rs.product_id=p.id
    WHERE p.active=1 ORDER BY p.name
  `).all();
  const totalQty = rows.reduce((s,r) => s + r.qty, 0);
  const totalValue = rows.reduce((s,r) => s + (r.qty * r.cost_price), 0);
  res.render('reports/stock', { title: 'Stock Report', rows, totalQty, totalValue });
});

// Dealer-wise sales drilldown
router.get('/dealer-sales', (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);
  const rows = db.prepare(`
    SELECT d.id, d.code, d.name, d.city, d.state, u.name AS sp_name,
           COUNT(i.id) AS invoices,
           COALESCE(SUM(i.total),0) AS billed,
           COALESCE(SUM(i.paid_amount),0) AS paid,
           COALESCE(SUM(i.total - i.paid_amount),0) AS balance
    FROM dealers d
    LEFT JOIN invoices i ON i.dealer_id = d.id AND i.invoice_date BETWEEN ? AND ? AND i.status != 'cancelled'
    LEFT JOIN users u ON u.id = d.salesperson_id
    WHERE d.active = 1
    GROUP BY d.id
    HAVING invoices > 0
    ORDER BY billed DESC
  `).all(from, to);
  const totalBilled = rows.reduce((s,r) => s + r.billed, 0);
  const totalPaid = rows.reduce((s,r) => s + r.paid, 0);
  res.render('reports/dealerSales', { title: 'Dealer-wise Sales', rows, from, to, totalBilled, totalPaid });
});

// Product-wise sales drilldown
router.get('/product-sales', (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);
  const rows = db.prepare(`
    SELECT p.id, p.code, p.name, p.size, p.color, p.category_id, c.name AS category_name,
           COALESCE(SUM(ii.quantity),0) AS qty_sold,
           COALESCE(SUM(ii.amount),0) AS revenue,
           COALESCE(rs.quantity, 0) AS stock_now
    FROM products p
    LEFT JOIN invoice_items ii ON ii.product_id = p.id
    LEFT JOIN invoices i ON i.id = ii.invoice_id AND i.invoice_date BETWEEN ? AND ? AND i.status != 'cancelled'
    LEFT JOIN ready_stock rs ON rs.product_id = p.id
    LEFT JOIN product_categories c ON c.id = p.category_id
    WHERE p.active = 1
    GROUP BY p.id
    HAVING qty_sold > 0
    ORDER BY revenue DESC
  `).all(from, to);
  const totalQty = rows.reduce((s,r) => s + r.qty_sold, 0);
  const totalRev = rows.reduce((s,r) => s + r.revenue, 0);
  res.render('reports/productSales', { title: 'Product-wise Sales', rows, from, to, totalQty, totalRev });
});

// Payment mode breakdown
router.get('/payment-modes', (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);
  const rows = db.prepare(`
    SELECT pm.name AS mode, COUNT(p.id) AS txns, COALESCE(SUM(p.amount),0) AS total
    FROM payment_modes pm
    LEFT JOIN payments p ON p.payment_mode_id = pm.id AND p.payment_date BETWEEN ? AND ? AND p.status='verified'
    GROUP BY pm.id
    ORDER BY total DESC
  `).all(from, to);
  const grand = rows.reduce((s,r) => s + r.total, 0);
  res.render('reports/paymentModes', { title: 'Payment Mode Breakdown', rows, from, to, grand });
});

// Aged outstanding (0-30, 31-60, 61-90, 90+)
router.get('/aged-outstanding', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT d.id, d.code, d.name, d.phone, d.salesperson_id, u.name AS sp_name,
           i.id AS invoice_id, i.invoice_no, i.invoice_date, i.total, i.paid_amount,
           (i.total - i.paid_amount) AS balance,
           CAST(julianday(?) - julianday(i.invoice_date) AS INTEGER) AS days
    FROM invoices i
    JOIN dealers d ON d.id = i.dealer_id
    LEFT JOIN users u ON u.id = d.salesperson_id
    WHERE i.status IN ('unpaid','partial')
    ORDER BY days DESC
  `).all(today);
  const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  rows.forEach(r => {
    if (r.days <= 30) buckets['0-30'] += r.balance;
    else if (r.days <= 60) buckets['31-60'] += r.balance;
    else if (r.days <= 90) buckets['61-90'] += r.balance;
    else buckets['90+'] += r.balance;
  });
  const total = rows.reduce((s,r) => s + r.balance, 0);
  res.render('reports/agedOutstanding', { title: 'Aged Outstanding', rows, buckets, total });
});

// Production efficiency by stage
router.get('/production-efficiency', (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);
  const rows = db.prepare(`
    SELECT pse.stage, COUNT(*) AS entries,
           SUM(pse.qty_in) AS total_in,
           SUM(pse.qty_out) AS total_out,
           SUM(pse.qty_rejected) AS total_rejected,
           SUM(pse.total_cost) AS total_cost,
           CASE WHEN SUM(pse.qty_in) > 0 THEN ROUND(100.0 * SUM(pse.qty_out) / SUM(pse.qty_in), 1) ELSE 0 END AS yield_pct
    FROM production_stage_entries pse
    WHERE pse.entry_date BETWEEN ? AND ?
    GROUP BY pse.stage
    ORDER BY total_out DESC
  `).all(from, to);
  res.render('reports/productionEfficiency', { title: 'Production Efficiency', rows, from, to });
});

// Raw material consumption
router.get('/material-consumption', (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);
  const rows = db.prepare(`
    SELECT rm.id, rm.code, rm.name, rm.unit, rm.current_stock, rm.cost_per_unit,
           COALESCE(SUM(CASE WHEN t.txn_type='purchase' THEN t.quantity ELSE 0 END), 0) AS purchased,
           COALESCE(SUM(CASE WHEN t.txn_type='issue'    THEN t.quantity ELSE 0 END), 0) AS issued,
           COALESCE(SUM(CASE WHEN t.txn_type='purchase' THEN t.total_amount ELSE 0 END), 0) AS purchase_value,
           COALESCE(SUM(CASE WHEN t.txn_type='issue'    THEN t.total_amount ELSE 0 END), 0) AS issued_value
    FROM raw_materials rm
    LEFT JOIN raw_material_txns t ON t.raw_material_id = rm.id AND t.created_at BETWEEN ? AND datetime(?, '+1 day')
    WHERE rm.active = 1
    GROUP BY rm.id
    ORDER BY issued DESC, purchased DESC
  `).all(from, to);
  res.render('reports/materialConsumption', { title: 'Raw Material Consumption', rows, from, to });
});

// Salesperson detailed performance
router.get('/salesperson-detail', (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);
  // A dealer's transactions and outstanding belong to whichever salesperson is
  // currently assigned to that dealer. So:
  //   - In-period metrics (sales / collected / verified / pending) = SUM over
  //     this user's assigned dealers, filtered by the date range.
  //   - Outstanding is an ALL-TIME snapshot (no date filter) because that's
  //     what's actually owed today: opening_balance + every non-cancelled
  //     invoice ever - every verified payment ever, summed over the assigned
  //     dealers. Matches the formula used on the dealer list / dashboard KPI.
  const rows = db.prepare(`
    SELECT u.id, u.name,
      (SELECT COUNT(*) FROM dealers d
         WHERE d.salesperson_id = u.id AND d.active = 1) AS dealers_assigned,
      -- In-period invoice metrics for the assigned dealers
      (SELECT COUNT(*) FROM invoices i
         JOIN dealers d ON d.id = i.dealer_id
         WHERE d.salesperson_id = u.id AND d.active = 1
           AND i.invoice_date BETWEEN ? AND ?
           AND i.status != 'cancelled') AS invoices_count,
      COALESCE((SELECT SUM(i.total) FROM invoices i
         JOIN dealers d ON d.id = i.dealer_id
         WHERE d.salesperson_id = u.id AND d.active = 1
           AND i.invoice_date BETWEEN ? AND ?
           AND i.status != 'cancelled'), 0) AS sales_total,
      -- In-period payment metrics for the assigned dealers
      (SELECT COUNT(*) FROM payments p
         JOIN dealers d ON d.id = p.dealer_id
         WHERE d.salesperson_id = u.id AND d.active = 1
           AND p.payment_date BETWEEN ? AND ?) AS payments_count,
      COALESCE((SELECT SUM(p.amount) FROM payments p
         JOIN dealers d ON d.id = p.dealer_id
         WHERE d.salesperson_id = u.id AND d.active = 1
           AND p.payment_date BETWEEN ? AND ?
           AND p.status = 'verified'), 0) AS verified_amount,
      COALESCE((SELECT SUM(p.amount) FROM payments p
         JOIN dealers d ON d.id = p.dealer_id
         WHERE d.salesperson_id = u.id AND d.active = 1
           AND p.payment_date BETWEEN ? AND ?
           AND p.status = 'pending'), 0) AS pending_amount,
      COALESCE((SELECT SUM(p.amount) FROM payments p
         JOIN dealers d ON d.id = p.dealer_id
         WHERE d.salesperson_id = u.id AND d.active = 1
           AND p.payment_date BETWEEN ? AND ?
           AND p.status IN ('verified','pending')), 0) AS collected,
      -- Outstanding (all-time snapshot, NOT filtered by date):
      --   opening_balance + lifetime billed - lifetime verified payments
      -- summed across this user's currently-assigned dealers.
      (
        COALESCE((SELECT SUM(d.opening_balance) FROM dealers d
           WHERE d.salesperson_id = u.id AND d.active = 1), 0)
        + COALESCE((SELECT SUM(i.total) FROM invoices i
           JOIN dealers d ON d.id = i.dealer_id
           WHERE d.salesperson_id = u.id AND d.active = 1
             AND i.status != 'cancelled'), 0)
        - COALESCE((SELECT SUM(p.amount) FROM payments p
           JOIN dealers d ON d.id = p.dealer_id
           WHERE d.salesperson_id = u.id AND d.active = 1
             AND p.status = 'verified'), 0)
      ) AS outstanding,
      -- All-time verified payments on the assigned dealers — denominator
      -- for the collection % so the bar represents "how much of the lifetime
      -- receivable position has been collected" instead of in-period ratio.
      COALESCE((SELECT SUM(p.amount) FROM payments p
         JOIN dealers d ON d.id = p.dealer_id
         WHERE d.salesperson_id = u.id AND d.active = 1
           AND p.status = 'verified'), 0) AS lifetime_verified
    FROM users u
    WHERE u.role IN ('salesperson','admin','owner') AND u.active = 1
    ORDER BY sales_total DESC
  `).all(
    from, to,    // invoices_count
    from, to,    // sales_total
    from, to,    // payments_count
    from, to,    // verified_amount
    from, to,    // pending_amount
    from, to     // collected
    // outstanding subqueries use no date params (all-time)
  );
  res.render('reports/salespersonDetail', { title: 'Salesperson Performance Detail', rows, from, to });
});

// Deep detail for ONE salesperson — every assigned dealer, lifetime + period
// metrics, recent invoices / payments / visits / factory log. Linked from
// the Salesperson Performance Detail table by clicking a name.
router.get('/salesperson/:id', (req, res) => {
  const u = db.prepare(`SELECT id, name, email, phone, role, active, created_at FROM users WHERE id = ?`).get(req.params.id);
  if (!u) return res.redirect('/reports/salesperson-detail');
  const from = req.query.from || new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);

  // All assigned dealers with their per-dealer breakdown.
  const dealers = db.prepare(`
    SELECT d.id, d.code, d.name, d.city, d.state, d.phone, d.opening_balance,
      COALESCE((SELECT SUM(i.total) FROM invoices i WHERE i.dealer_id = d.id AND i.status != 'cancelled'), 0) AS billed_lifetime,
      COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.dealer_id = d.id AND p.status = 'verified'), 0) AS paid_lifetime,
      COALESCE((SELECT SUM(i.total) FROM invoices i WHERE i.dealer_id = d.id AND i.status != 'cancelled' AND i.invoice_date BETWEEN ? AND ?), 0) AS billed_period,
      COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.dealer_id = d.id AND p.status = 'verified' AND p.payment_date BETWEEN ? AND ?), 0) AS paid_period,
      d.last_visit_at
    FROM dealers d
    WHERE d.salesperson_id = ? AND d.active = 1
    ORDER BY (COALESCE(d.opening_balance, 0)
              + COALESCE((SELECT SUM(i.total) FROM invoices i WHERE i.dealer_id = d.id AND i.status != 'cancelled'), 0)
              - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.dealer_id = d.id AND p.status = 'verified'), 0)) DESC,
             d.name
  `).all(from, to, from, to, u.id);
  dealers.forEach(d => {
    d.outstanding = (d.opening_balance || 0) + d.billed_lifetime - d.paid_lifetime;
  });

  // Aggregates (used for the KPI cards) — match the list-page formulas.
  const totals = {
    dealers: dealers.length,
    dealers_with_outstanding: dealers.filter(d => d.outstanding > 0).length,
    opening_balance: dealers.reduce((s, d) => s + (d.opening_balance || 0), 0),
    billed_lifetime: dealers.reduce((s, d) => s + d.billed_lifetime, 0),
    paid_lifetime:   dealers.reduce((s, d) => s + d.paid_lifetime, 0),
    sales_period:    dealers.reduce((s, d) => s + d.billed_period, 0),
    paid_period:     dealers.reduce((s, d) => s + d.paid_period, 0),
  };
  totals.outstanding_total = totals.opening_balance + totals.billed_lifetime - totals.paid_lifetime;
  totals.collection_pct = (totals.paid_lifetime + totals.outstanding_total) > 0
    ? Math.round((totals.paid_lifetime * 100) / (totals.paid_lifetime + totals.outstanding_total))
    : 0;

  // Recent invoices on the salesperson's assigned dealers (any creator).
  const invoices = db.prepare(`
    SELECT i.id, i.invoice_no, i.invoice_date, i.total, i.paid_amount, i.status,
           d.code AS dealer_code, d.name AS dealer_name
    FROM invoices i JOIN dealers d ON d.id = i.dealer_id
    WHERE d.salesperson_id = ? AND d.active = 1
    ORDER BY i.invoice_date DESC, i.id DESC LIMIT 20
  `).all(u.id);

  // Recent payments on the salesperson's assigned dealers.
  const payments = db.prepare(`
    SELECT p.id, p.payment_no, p.payment_date, p.amount, p.status,
           d.code AS dealer_code, d.name AS dealer_name,
           pm.name AS mode
    FROM payments p JOIN dealers d ON d.id = p.dealer_id
    LEFT JOIN payment_modes pm ON pm.id = p.payment_mode_id
    WHERE d.salesperson_id = ? AND d.active = 1
    ORDER BY p.payment_date DESC, p.id DESC LIMIT 20
  `).all(u.id);

  // Field visits by this user (their own, scoped by user not dealer assignment).
  const visits = db.prepare(`
    SELECT v.id, v.visit_no, v.visit_type, v.created_at, v.photo_path, v.lat, v.lng,
           d.code AS dealer_code, d.name AS dealer_name, v.prospect_shop, v.prospect_name
    FROM dealer_visits v LEFT JOIN dealers d ON d.id = v.dealer_id
    WHERE v.salesperson_id = ?
    ORDER BY v.id DESC LIMIT 15
  `).all(u.id);

  // Today's factory in/out (if any), so the page can show attendance state.
  const todayStr = new Date().toISOString().slice(0,10);
  const factoryToday = {
    in:  db.prepare("SELECT created_at, photo_path FROM factory_logs WHERE salesperson_id=? AND log_date=? AND log_type='in'").get(u.id, todayStr),
    out: db.prepare("SELECT created_at, photo_path FROM factory_logs WHERE salesperson_id=? AND log_date=? AND log_type='out'").get(u.id, todayStr),
  };

  res.render('reports/salespersonOne', {
    title: 'Salesperson: ' + u.name,
    u, from, to, dealers, totals, invoices, payments, visits, factoryToday,
  });
});

// City/State geographic sales heatmap
router.get('/geo-sales', (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);
  const rows = db.prepare(`
    SELECT COALESCE(d.state, 'Unknown') AS state, COALESCE(d.city, 'Unknown') AS city,
           COUNT(DISTINCT d.id) AS dealer_count,
           COUNT(DISTINCT i.id) AS invoice_count,
           COALESCE(SUM(i.total), 0) AS revenue
    FROM dealers d
    LEFT JOIN invoices i ON i.dealer_id = d.id AND i.invoice_date BETWEEN ? AND ? AND i.status != 'cancelled'
    WHERE d.active = 1
    GROUP BY d.state, d.city
    HAVING revenue > 0
    ORDER BY revenue DESC
  `).all(from, to);
  res.render('reports/geoSales', { title: 'Geographic Sales', rows, from, to });
});

// Product performance — slow / fast moving
router.get('/product-performance', (req, res) => {
  const days = parseInt(req.query.days || 30);
  const since = new Date(Date.now() - days*86400000).toISOString().slice(0,10);
  const rows = db.prepare(`
    SELECT p.id, p.code, p.name,
      COALESCE(SUM(ii.quantity), 0) AS sold,
      COALESCE(rs.quantity, 0) AS stock,
      COALESCE(SUM(ii.amount), 0) AS revenue
    FROM products p
    LEFT JOIN invoice_items ii ON ii.product_id = p.id
    LEFT JOIN invoices i ON i.id = ii.invoice_id AND i.invoice_date >= ? AND i.status != 'cancelled'
    LEFT JOIN ready_stock rs ON rs.product_id = p.id
    WHERE p.active = 1
    GROUP BY p.id
    ORDER BY sold DESC
  `).all(since);
  const top = rows.slice(0, 20);
  const slow = [...rows].filter(r => r.sold === 0).slice(0, 20);
  res.render('reports/productPerformance', { title: 'Product Performance', top, slow, days });
});

module.exports = router;
