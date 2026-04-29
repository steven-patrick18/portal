const express = require('express');
const { db } = require('../db');
const router = express.Router();

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
