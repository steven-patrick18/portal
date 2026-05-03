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
router.use(['/sales', '/dealer-sales', '/product-sales', '/salesperson-detail', '/geo-sales', '/product-performance'], requireFeature('reports_sales'));

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
  const daily = db.prepare(`
    SELECT payment_date AS d, COUNT(*) AS n, SUM(amount) AS total
    FROM payments WHERE payment_date BETWEEN ? AND ? AND status='verified'
    GROUP BY payment_date ORDER BY payment_date DESC
  `).all(from, to);
  const bySp = db.prepare(`
    SELECT u.name, COUNT(p.id) AS pmts, COALESCE(SUM(p.amount),0) AS total
    FROM users u LEFT JOIN payments p ON p.salesperson_id=u.id AND p.payment_date BETWEEN ? AND ? AND p.status='verified'
    WHERE u.role IN ('salesperson','admin','owner')
    GROUP BY u.id ORDER BY total DESC
  `).all(from, to);
  res.render('reports/collection', { title: 'Collection Report', daily, bySp, from, to });
});

// Outstanding
router.get('/outstanding', (req, res) => {
  const rows = db.prepare(`
    SELECT d.id, d.code, d.name, d.phone, d.city, d.credit_limit, d.opening_balance, u.name AS sp_name,
      COALESCE((SELECT SUM(total) FROM invoices WHERE dealer_id=d.id AND status!='cancelled'),0) AS billed,
      COALESCE((SELECT SUM(paid_amount) FROM invoices WHERE dealer_id=d.id AND status!='cancelled'),0) AS paid
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
  const rows = db.prepare(`
    SELECT u.id, u.name,
           COUNT(DISTINCT d.id) AS dealers_assigned,
           COUNT(DISTINCT i.id) AS invoices_count,
           COALESCE(SUM(i.total), 0) AS sales_total,
           COALESCE(SUM(i.paid_amount), 0) AS collected,
           COUNT(DISTINCT p.id) AS payments_count,
           COALESCE(SUM(CASE WHEN p.status='verified' THEN p.amount ELSE 0 END), 0) AS verified_amount,
           COALESCE(SUM(CASE WHEN p.status='pending'  THEN p.amount ELSE 0 END), 0) AS pending_amount,
           COALESCE(SUM(i.total - i.paid_amount), 0) AS outstanding
    FROM users u
    LEFT JOIN dealers d ON d.salesperson_id = u.id AND d.active = 1
    LEFT JOIN invoices i ON i.salesperson_id = u.id AND i.invoice_date BETWEEN ? AND ? AND i.status != 'cancelled'
    LEFT JOIN payments p ON p.salesperson_id = u.id AND p.payment_date BETWEEN ? AND ?
    WHERE u.role IN ('salesperson','admin','owner') AND u.active = 1
    GROUP BY u.id
    ORDER BY sales_total DESC
  `).all(from, to, from, to);
  res.render('reports/salespersonDetail', { title: 'Salesperson Performance Detail', rows, from, to });
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
