const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const router = express.Router();

router.get('/', (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0,7);
  const items = db.prepare(`
    SELECT e.*, c.name AS category_name, u.name AS by_name
    FROM mfg_expenses e LEFT JOIN expense_categories c ON c.id=e.category_id
    LEFT JOIN users u ON u.id=e.created_by
    WHERE strftime('%Y-%m', e.expense_date) = ?
    ORDER BY e.expense_date DESC, e.id DESC
  `).all(month);
  const total = items.reduce((s,e) => s + e.amount, 0);
  const cats = db.prepare('SELECT * FROM expense_categories ORDER BY name').all();
  res.render('expenses/index', { title: 'Manufacturing Expenses', items, total, cats, month });
});

router.post('/', (req, res) => {
  const { expense_date, category_id, description, amount, paid_to, payment_mode, reference_no } = req.body;
  db.prepare(`INSERT INTO mfg_expenses (expense_date,category_id,description,amount,paid_to,payment_mode,reference_no,created_by) VALUES (?,?,?,?,?,?,?,?)`)
    .run(expense_date, category_id||null, description||null, parseFloat(amount), paid_to||null, payment_mode||null, reference_no||null, req.session.user.id);
  flash(req,'success','Expense recorded.'); res.redirect('/expenses');
});

router.post('/category', (req, res) => {
  try { db.prepare('INSERT INTO expense_categories (name) VALUES (?)').run(req.body.name); flash(req,'success','Added.'); }
  catch(e) { flash(req,'danger',e.message); }
  res.redirect('/expenses');
});

router.post('/:id/delete', (req, res) => {
  db.prepare('DELETE FROM mfg_expenses WHERE id=?').run(req.params.id);
  flash(req,'success','Deleted.'); res.redirect('/expenses');
});

module.exports = router;
