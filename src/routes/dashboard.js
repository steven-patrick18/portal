const express = require('express');
const { db } = require('../db');
const { todayLocal } = require('../utils/format');
const router = express.Router();

router.get('/', (req, res) => {
  const today = todayLocal();
  const monthStart = today.slice(0, 7) + '-01';

  const todaySales = db.prepare(`SELECT COALESCE(SUM(total),0) AS v FROM invoices WHERE invoice_date = ? AND status != 'cancelled'`).get(today).v;
  const monthSales = db.prepare(`SELECT COALESCE(SUM(total),0) AS v FROM invoices WHERE invoice_date >= ? AND status != 'cancelled'`).get(monthStart).v;
  const todayCollections = db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM payments WHERE payment_date = ? AND status = 'verified'`).get(today).v;
  // Match the dealer-list formula: opening_balance + verified payments,
  // not invoices.paid_amount cache (which can drift from real money received).
  const totalOutstanding = db.prepare(`
    SELECT COALESCE(SUM(opening_balance), 0)
         + COALESCE((SELECT SUM(total)  FROM invoices WHERE status != 'cancelled'), 0)
         - COALESCE((SELECT SUM(amount) FROM payments WHERE status = 'verified'), 0) AS v
    FROM dealers
  `).get().v;
  const dealersCount = db.prepare(`SELECT COUNT(*) AS n FROM dealers WHERE active=1`).get().n;
  const productsCount = db.prepare(`SELECT COUNT(*) AS n FROM products WHERE active=1`).get().n;
  const lowStock = db.prepare(`
    SELECT p.name, p.code, COALESCE(rs.quantity,0) AS qty, p.reorder_level
    FROM products p LEFT JOIN ready_stock rs ON rs.product_id = p.id
    WHERE p.active = 1 AND p.reorder_level > 0 AND COALESCE(rs.quantity,0) <= p.reorder_level
    LIMIT 10
  `).all();
  const pendingPayments = db.prepare(`
    SELECT p.*, d.name AS dealer_name, u.name AS sp_name
    FROM payments p JOIN dealers d ON d.id=p.dealer_id LEFT JOIN users u ON u.id=p.salesperson_id
    WHERE p.status='pending' ORDER BY p.created_at DESC LIMIT 10
  `).all();
  const recentInvoices = db.prepare(`
    SELECT i.*, d.name AS dealer_name FROM invoices i JOIN dealers d ON d.id=i.dealer_id
    ORDER BY i.created_at DESC LIMIT 8
  `).all();
  const productionInProgress = db.prepare(`SELECT COUNT(*) AS n FROM production_batches WHERE status='in_progress'`).get().n;

  res.render('dashboard', {
    title: 'Dashboard',
    todaySales, monthSales, todayCollections, totalOutstanding,
    dealersCount, productsCount, lowStock, pendingPayments, recentInvoices, productionInProgress,
  });
});

module.exports = router;
