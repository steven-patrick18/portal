const express = require('express');
const { db } = require('../db');
const { todayLocal } = require('../utils/format');
const { getScopeUserIds } = require('../middleware/scope');
const router = express.Router();

router.get('/', (req, res) => {
  const today = todayLocal();
  const monthStart = today.slice(0, 7) + '-01';

  // Team scope: null = full visibility (owner/admin/accountant) → whole-company
  // figures. Otherwise an array of user ids (salesperson = self, area_manager =
  // self + direct reports) → every money/dealer/invoice figure below is limited
  // to that person's own work, so a salesperson sees only their numbers.
  const ids = getScopeUserIds(req);
  const scoped = Array.isArray(ids);
  const ph = scoped ? ids.map(() => '?').join(',') : '';
  const sp = scoped ? ids : [];                       // params to spread
  // Sales/collections/invoices/pending are scoped by the record's own
  // salesperson_id ("what I did"); dealers + outstanding by the dealer's
  // salesperson_id ("my customers").
  const byInv = scoped ? ` AND salesperson_id IN (${ph})` : '';
  const byPay = scoped ? ` AND salesperson_id IN (${ph})` : '';

  const todaySales = db.prepare(
    `SELECT COALESCE(SUM(total),0) AS v FROM invoices WHERE invoice_date = ? AND status != 'cancelled'${byInv}`
  ).get(today, ...sp).v;
  const monthSales = db.prepare(
    `SELECT COALESCE(SUM(total),0) AS v FROM invoices WHERE invoice_date >= ? AND status != 'cancelled'${byInv}`
  ).get(monthStart, ...sp).v;
  const todayCollections = db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS v FROM payments WHERE payment_date = ? AND status = 'verified'${byPay}`
  ).get(today, ...sp).v;
  // Outstanding = opening + billed - collected. Match the dealer-list money
  // basis (verified payments, not the paid_amount cache). When scoped, limit to
  // this person's dealers (and the invoices/payments tied to those dealers).
  const totalOutstanding = scoped
    ? db.prepare(`
        SELECT COALESCE((SELECT SUM(opening_balance) FROM dealers WHERE salesperson_id IN (${ph})),0)
             + COALESCE((SELECT SUM(total)  FROM invoices WHERE status!='cancelled' AND dealer_id IN (SELECT id FROM dealers WHERE salesperson_id IN (${ph}))),0)
             - COALESCE((SELECT SUM(amount) FROM payments WHERE status='verified' AND dealer_id IN (SELECT id FROM dealers WHERE salesperson_id IN (${ph}))),0) AS v
      `).get(...ids, ...ids, ...ids).v
    : db.prepare(`
        SELECT COALESCE(SUM(opening_balance), 0)
             + COALESCE((SELECT SUM(total)  FROM invoices WHERE status != 'cancelled'), 0)
             - COALESCE((SELECT SUM(amount) FROM payments WHERE status = 'verified'), 0) AS v
        FROM dealers
      `).get().v;
  const dealersCount = db.prepare(
    `SELECT COUNT(*) AS n FROM dealers WHERE active=1${scoped ? ` AND salesperson_id IN (${ph})` : ''}`
  ).get(...sp).n;
  // Catalogue + stock + production are shared company resources, not
  // per-person data — they stay whole-company for every role.
  const productsCount = db.prepare(`SELECT COUNT(*) AS n FROM products WHERE active=1`).get().n;
  const lowStock = db.prepare(`
    SELECT p.name, p.code, COALESCE(rs.quantity,0) AS qty, p.reorder_level
    FROM products p LEFT JOIN ready_stock_total rs ON rs.product_id = p.id
    WHERE p.active = 1 AND p.reorder_level > 0 AND COALESCE(rs.quantity,0) <= p.reorder_level
    LIMIT 10
  `).all();
  const pendingPayments = db.prepare(
    `SELECT p.*, d.name AS dealer_name, u.name AS sp_name
     FROM payments p JOIN dealers d ON d.id=p.dealer_id LEFT JOIN users u ON u.id=p.salesperson_id
     WHERE p.status='pending'${scoped ? ` AND p.salesperson_id IN (${ph})` : ''} ORDER BY p.created_at DESC LIMIT 10`
  ).all(...sp);
  const recentInvoices = db.prepare(
    `SELECT i.*, d.name AS dealer_name FROM invoices i JOIN dealers d ON d.id=i.dealer_id
     ${scoped ? `WHERE i.salesperson_id IN (${ph})` : ''} ORDER BY i.created_at DESC LIMIT 8`
  ).all(...sp);
  const productionInProgress = db.prepare(`SELECT COUNT(*) AS n FROM production_batches WHERE status='in_progress'`).get().n;

  res.render('dashboard', {
    title: 'Dashboard',
    todaySales, monthSales, todayCollections, totalOutstanding,
    dealersCount, productsCount, lowStock, pendingPayments, recentInvoices, productionInProgress,
    scoped,
  });
});

module.exports = router;
