const express = require('express');
const { db } = require('../db');
const { todayLocal } = require('../utils/format');
const router = express.Router();

router.get('/', (req, res) => {
  const u = req.session.user;
  const today = todayLocal();
  const monthStart = today.slice(0,7) + '-01';
  const myDealers = db.prepare(`SELECT COUNT(*) AS n FROM dealers WHERE salesperson_id=? AND active=1`).get(u.id).n;
  const todaySales = db.prepare(`SELECT COALESCE(SUM(total),0) AS v FROM invoices WHERE salesperson_id=? AND invoice_date=? AND status!='cancelled'`).get(u.id, today).v;
  const monthSales = db.prepare(`SELECT COALESCE(SUM(total),0) AS v FROM invoices WHERE salesperson_id=? AND invoice_date>=? AND status!='cancelled'`).get(u.id, monthStart).v;
  const todayCol = db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM payments WHERE salesperson_id=? AND payment_date=? AND status!='rejected'`).get(u.id, today).v;
  const monthCol = db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM payments WHERE salesperson_id=? AND payment_date>=? AND status!='rejected'`).get(u.id, monthStart).v;
  const myOutstanding = db.prepare(`
    SELECT COALESCE(SUM(i.total - i.paid_amount),0) AS v FROM invoices i
    JOIN dealers d ON d.id=i.dealer_id
    WHERE d.salesperson_id=? AND i.status IN ('unpaid','partial')
  `).get(u.id).v;
  res.render('mobile/home', { title: 'My App', myDealers, todaySales, monthSales, todayCol, monthCol, myOutstanding });
});

router.get('/dealers', (req, res) => {
  const u = req.session.user;
  const q = (req.query.q || '').trim();
  // "paid" sums verified payments — see src/routes/dealers.js for why.
  let sql = `SELECT d.*,
    COALESCE((SELECT SUM(total)  FROM invoices WHERE dealer_id=d.id AND status!='cancelled'),0) AS billed,
    COALESCE((SELECT SUM(amount) FROM payments WHERE dealer_id=d.id AND status='verified'),0) AS paid
    FROM dealers d WHERE d.active=1`;
  const params = [];
  if (u.role === 'salesperson') { sql += ' AND d.salesperson_id=?'; params.push(u.id); }
  if (q) { sql += ' AND (d.name LIKE ? OR d.phone LIKE ? OR d.code LIKE ?)'; params.push(`%${q}%`,`%${q}%`,`%${q}%`); }
  sql += ' ORDER BY d.name LIMIT 200';
  const dealers = db.prepare(sql).all(...params);
  dealers.forEach(d => d.outstanding = (d.opening_balance||0) + d.billed - d.paid);
  res.render('mobile/dealers', { title: 'My Dealers', dealers, q });
});

router.get('/dealer/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM dealers WHERE id=?').get(req.params.id);
  if (!d) return res.redirect('/mobile/dealers');
  const invoices = db.prepare(`SELECT * FROM invoices WHERE dealer_id=? AND status IN ('unpaid','partial') ORDER BY id DESC`).all(req.params.id);
  const billed = db.prepare(`SELECT COALESCE(SUM(total),0) AS v FROM invoices WHERE dealer_id=? AND status!='cancelled'`).get(req.params.id).v;
  const paid = db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM payments WHERE dealer_id=? AND status='verified'`).get(req.params.id).v;
  const outstanding = (d.opening_balance||0) + billed - paid;
  res.render('mobile/dealer', { title: d.name, d, invoices, outstanding });
});

router.get('/payments', (req, res) => {
  const u = req.session.user;
  const items = db.prepare(`SELECT p.*, d.name AS dealer_name, pm.name AS mode, i.invoice_no FROM payments p JOIN dealers d ON d.id=p.dealer_id LEFT JOIN payment_modes pm ON pm.id=p.payment_mode_id LEFT JOIN invoices i ON i.id=p.invoice_id WHERE p.salesperson_id=? ORDER BY p.id DESC LIMIT 50`).all(u.id);
  res.render('mobile/payments', { title: 'My Payments', items });
});

module.exports = router;
