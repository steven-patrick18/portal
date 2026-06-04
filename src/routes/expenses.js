const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const router = express.Router();

router.get('/', (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0,7);
  const items = db.prepare(`
    SELECT e.*, c.name AS category_name, u.name AS by_name,
           fu.name AS funded_by_name
    FROM mfg_expenses e LEFT JOIN expense_categories c ON c.id=e.category_id
    LEFT JOIN users u ON u.id=e.created_by
    LEFT JOIN users fu ON fu.id=e.funded_by_user_id
    WHERE strftime('%Y-%m', e.expense_date) = ?
    ORDER BY e.expense_date DESC, e.id DESC
  `).all(month);
  const total = items.reduce((s,e) => s + e.amount, 0);
  const cats = db.prepare('SELECT * FROM expense_categories ORDER BY name').all();
  // Active fund-holders for the "Funded by" dropdown.
  const fundHolders = db.prepare(`
    SELECT f.id, f.user_id, u.name, u.role,
           f.opening_balance
           + COALESCE((SELECT SUM(amount) FROM admin_fund_topups WHERE fund_id=f.id), 0)
           - COALESCE((SELECT SUM(amount) FROM mfg_expenses WHERE funded_by_user_id=f.user_id), 0) AS balance
    FROM admin_funds f JOIN users u ON u.id = f.user_id
    WHERE f.active = 1 AND u.active = 1
    ORDER BY u.name
  `).all();
  res.render('expenses/index', { title: 'Manufacturing Expenses', items, total, cats, month, fundHolders });
});

router.post('/', (req, res) => {
  const { expense_date, category_id, description, amount, paid_to, payment_mode, reference_no, funded_by_user_id } = req.body;
  // funded_by_user_id is optional. When set, the expense debits that admin's
  // fund balance on the next page load.
  const fundedBy = funded_by_user_id ? parseInt(funded_by_user_id) : null;
  db.prepare(`INSERT INTO mfg_expenses (expense_date,category_id,description,amount,paid_to,payment_mode,reference_no,funded_by_user_id,created_by) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(expense_date, category_id||null, description||null, parseFloat(amount), paid_to||null, payment_mode||null, reference_no||null, fundedBy, req.session.user.id);
  flash(req,'success','Expense recorded.'); res.redirect('/expenses');
});

router.post('/category', (req, res) => {
  try { db.prepare('INSERT INTO expense_categories (name) VALUES (?)').run(req.body.name); flash(req,'success','Added.'); }
  catch(e) { flash(req,'danger',e.message); }
  res.redirect('/expenses');
});

router.get('/:id/edit', (req, res) => {
  const e = db.prepare('SELECT * FROM mfg_expenses WHERE id=?').get(req.params.id);
  if (!e) return res.redirect('/expenses');
  const cats = db.prepare('SELECT * FROM expense_categories ORDER BY name').all();
  const fundHolders = db.prepare(`
    SELECT f.id, f.user_id, u.name, u.role
    FROM admin_funds f JOIN users u ON u.id = f.user_id
    WHERE f.active = 1 AND u.active = 1
    ORDER BY u.name
  `).all();
  res.render('expenses/edit', { title: 'Edit Expense', e, cats, fundHolders });
});

router.post('/:id', (req, res) => {
  const { expense_date, category_id, description, amount, paid_to, payment_mode, reference_no, funded_by_user_id } = req.body;
  const fundedBy = funded_by_user_id ? parseInt(funded_by_user_id) : null;
  db.prepare(`UPDATE mfg_expenses SET expense_date=?, category_id=?, description=?, amount=?, paid_to=?, payment_mode=?, reference_no=?, funded_by_user_id=? WHERE id=?`)
    .run(expense_date, category_id||null, description||null, parseFloat(amount), paid_to||null, payment_mode||null, reference_no||null, fundedBy, req.params.id);
  flash(req,'success','Updated.'); res.redirect('/expenses');
});

router.post('/:id/delete', (req, res) => {
  db.prepare('DELETE FROM mfg_expenses WHERE id=?').run(req.params.id);
  flash(req,'success','Deleted.'); res.redirect('/expenses');
});

module.exports = router;
