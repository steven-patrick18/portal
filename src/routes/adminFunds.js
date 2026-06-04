const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { getUserLevel } = require('../middleware/permissions');
const router = express.Router();

function isOwner(req) { return req.session.user.role === 'owner'; }

// Live balance = opening + sum of topups - sum of mfg_expenses debited.
// Never cached so it can never drift if a topup/expense is edited.
function balanceQuery() {
  return `
    SELECT f.id, f.user_id, u.name AS user_name, u.email, u.role,
           f.opening_balance, f.active, f.notes, f.created_at,
           f.opening_balance
           + COALESCE((SELECT SUM(amount) FROM admin_fund_topups WHERE fund_id = f.id), 0)
           - COALESCE((SELECT SUM(amount) FROM mfg_expenses WHERE funded_by_user_id = f.user_id), 0) AS balance,
           COALESCE((SELECT SUM(amount) FROM admin_fund_topups WHERE fund_id = f.id), 0) AS topups_total,
           COALESCE((SELECT SUM(amount) FROM mfg_expenses WHERE funded_by_user_id = f.user_id), 0) AS expenses_total
    FROM admin_funds f JOIN users u ON u.id = f.user_id
  `;
}

// ─── List all admin funds ──────────────────────────────────
router.get('/', (req, res) => {
  // Owner sees everyone; an admin with their own fund sees only their row.
  const isLimited = !isOwner(req);
  let sql = balanceQuery();
  const params = [];
  if (isLimited) { sql += ' WHERE f.user_id = ?'; params.push(req.session.user.id); }
  sql += ' ORDER BY f.active DESC, u.name';
  const funds = db.prepare(sql).all(...params);
  const totals = {
    funds: funds.length,
    opening: funds.reduce((s, f) => s + (f.opening_balance || 0), 0),
    topups:  funds.reduce((s, f) => s + (f.topups_total || 0), 0),
    expenses: funds.reduce((s, f) => s + (f.expenses_total || 0), 0),
    balance: funds.reduce((s, f) => s + (f.balance || 0), 0),
  };
  res.render('adminFunds/index', { title: 'Admin Funds', funds, totals, isLimited, canManage: isOwner(req) });
});

// ─── New fund (owner only) ─────────────────────────────────
router.get('/new', (req, res) => {
  if (!isOwner(req)) { flash(req, 'danger', 'Owner only.'); return res.redirect('/admin-funds'); }
  // Eligible users = admin / owner who don't already have a fund row.
  const candidates = db.prepare(`
    SELECT id, name, email, role FROM users
    WHERE active = 1 AND role IN ('admin','owner')
      AND id NOT IN (SELECT user_id FROM admin_funds)
    ORDER BY name
  `).all();
  res.render('adminFunds/form', { title: 'New Admin Fund', candidates, fund: null });
});

router.post('/', (req, res) => {
  if (!isOwner(req)) { flash(req, 'danger', 'Owner only.'); return res.redirect('/admin-funds'); }
  const { user_id, opening_balance, notes } = req.body;
  if (!user_id) { flash(req, 'danger', 'Pick an admin.'); return res.redirect('/admin-funds/new'); }
  try {
    db.prepare(`INSERT INTO admin_funds (user_id, opening_balance, notes, created_by) VALUES (?,?,?,?)`)
      .run(parseInt(user_id), parseFloat(opening_balance || 0), notes || null, req.session.user.id);
    const u = db.prepare('SELECT name FROM users WHERE id=?').get(user_id)?.name;
    req.audit('create', 'admin_fund', null, `${u} · opening ₹${opening_balance || 0}`);
    flash(req, 'success', `Fund opened for ${u}.`);
  } catch (e) {
    flash(req, 'danger', /UNIQUE/.test(e.message) ? 'That user already has a fund.' : e.message);
  }
  res.redirect('/admin-funds');
});

// ─── One fund detail (owner sees all; admin sees own) ──────
router.get('/:id', (req, res) => {
  const fund = db.prepare(balanceQuery() + ' WHERE f.id = ?').get(req.params.id);
  if (!fund) { flash(req, 'danger', 'Fund not found.'); return res.redirect('/admin-funds'); }
  if (!isOwner(req) && fund.user_id !== req.session.user.id) {
    flash(req, 'danger', 'You can only view your own fund.');
    return res.redirect('/admin-funds');
  }
  const topups = db.prepare(`
    SELECT t.*, u.name AS by_name FROM admin_fund_topups t
    LEFT JOIN users u ON u.id = t.created_by
    WHERE t.fund_id = ? ORDER BY t.id DESC
  `).all(fund.id);
  const expenses = db.prepare(`
    SELECT e.id, e.expense_date, e.amount, e.description, e.paid_to, e.reference_no, c.name AS category
    FROM mfg_expenses e LEFT JOIN expense_categories c ON c.id = e.category_id
    WHERE e.funded_by_user_id = ?
    ORDER BY e.expense_date DESC, e.id DESC LIMIT 100
  `).all(fund.user_id);
  res.render('adminFunds/show', { title: 'Fund · ' + fund.user_name, fund, topups, expenses, canManage: isOwner(req) });
});

// ─── Record a top-up (owner only) ──────────────────────────
router.post('/:id/topup', (req, res) => {
  if (!isOwner(req)) { flash(req, 'danger', 'Owner only.'); return res.redirect('/admin-funds/' + req.params.id); }
  const fund = db.prepare('SELECT id, user_id FROM admin_funds WHERE id = ?').get(req.params.id);
  if (!fund) { flash(req, 'danger', 'Fund not found.'); return res.redirect('/admin-funds'); }
  const amount = parseFloat(req.body.amount || 0);
  if (!(amount > 0)) { flash(req, 'danger', 'Amount must be > 0.'); return res.redirect('/admin-funds/' + fund.id); }
  db.prepare(`INSERT INTO admin_fund_topups (fund_id, amount, txn_date, mode, reference_no, notes, created_by) VALUES (?,?,?,?,?,?,?)`)
    .run(fund.id, amount, req.body.txn_date || new Date().toISOString().slice(0,10), req.body.mode || null, req.body.reference_no || null, req.body.notes || null, req.session.user.id);
  req.audit('topup', 'admin_fund', fund.id, `+₹${amount}`);
  flash(req, 'success', `Top-up of ₹${amount.toFixed(2)} recorded.`);
  res.redirect('/admin-funds/' + fund.id);
});

router.post('/:id/topup/:tid/delete', (req, res) => {
  if (!isOwner(req)) { flash(req, 'danger', 'Owner only.'); return res.redirect('/admin-funds/' + req.params.id); }
  db.prepare('DELETE FROM admin_fund_topups WHERE id = ? AND fund_id = ?').run(req.params.tid, req.params.id);
  req.audit('topup_delete', 'admin_fund', req.params.id, `#${req.params.tid}`);
  flash(req, 'success', 'Top-up removed.');
  res.redirect('/admin-funds/' + req.params.id);
});

// ─── Toggle active (owner only) ────────────────────────────
router.post('/:id/toggle', (req, res) => {
  if (!isOwner(req)) { flash(req, 'danger', 'Owner only.'); return res.redirect('/admin-funds'); }
  db.prepare('UPDATE admin_funds SET active = 1 - active WHERE id = ?').run(req.params.id);
  req.audit('toggle', 'admin_fund', req.params.id);
  flash(req, 'success', 'Fund status toggled.');
  res.redirect('/admin-funds/' + req.params.id);
});

module.exports = router;
