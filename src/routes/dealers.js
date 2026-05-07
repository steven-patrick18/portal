const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { nextCode } = require('../utils/codegen');
const router = express.Router();

router.get('/', (req, res) => {
  const q = (req.query.q||'').trim();
  // Salesperson role is forced to "my dealers" — they cannot see others.
  const isLimited = req.session.user.role === 'salesperson';
  const filter = isLimited ? 'mine' : (req.query.filter || 'all');
  // "paid" sums verified payments from the payments table, not the
  // invoices.paid_amount cache — see explanation in the show route.
  let sql = `
    SELECT d.*, u.name AS sp_name,
      COALESCE((SELECT SUM(total)  FROM invoices WHERE dealer_id=d.id AND status!='cancelled'),0) AS billed,
      COALESCE((SELECT SUM(amount) FROM payments WHERE dealer_id=d.id AND status='verified'),0) AS paid
    FROM dealers d LEFT JOIN users u ON u.id=d.salesperson_id`;
  const params = [];
  const where = [];
  if (q) { where.push('(d.code LIKE ? OR d.name LIKE ? OR d.phone LIKE ?)'); params.push(`%${q}%`,`%${q}%`,`%${q}%`); }
  if (filter === 'mine') { where.push('d.salesperson_id=?'); params.push(req.session.user.id); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY d.id DESC';
  const items = db.prepare(sql).all(...params);
  items.forEach(d => d.outstanding = (d.opening_balance||0) + d.billed - d.paid);
  res.render('dealers/index', { title: 'Dealers / Customers', items, q, filter, isLimited });
});

// Bulk-assign dealers to a salesperson (admin only)
router.get('/assign', (req, res) => {
  if (req.session.user.role === 'salesperson' || req.session.user.role === 'production' || req.session.user.role === 'store') {
    return res.status(403).render('error', { title: 'Forbidden', message: 'Admin access required.', code: 403 });
  }
  const filter = req.query.sp || 'all'; // 'all' | 'unassigned' | <userId>
  let sql = `SELECT d.id, d.code, d.name, d.city, d.state, d.phone, d.salesperson_id, u.name AS sp_name, COALESCE((SELECT SUM(total - paid_amount) FROM invoices WHERE dealer_id=d.id AND status IN ('unpaid','partial')),0) AS outstanding
             FROM dealers d LEFT JOIN users u ON u.id=d.salesperson_id WHERE d.active=1`;
  const params = [];
  if (filter === 'unassigned') sql += ' AND d.salesperson_id IS NULL';
  else if (filter !== 'all')   { sql += ' AND d.salesperson_id = ?'; params.push(filter); }
  sql += ' ORDER BY u.name NULLS LAST, d.name';
  const dealers = db.prepare(sql).all(...params);
  const salespersons = db.prepare("SELECT id, name FROM users WHERE active=1 AND role IN ('salesperson','admin','owner') ORDER BY role, name").all();
  // Group dealer counts by salesperson
  const counts = db.prepare(`
    SELECT salesperson_id, COUNT(*) AS n
    FROM dealers WHERE active=1 GROUP BY salesperson_id
  `).all();
  const countMap = {};
  let unassignedCount = 0;
  counts.forEach(c => { if (c.salesperson_id === null) unassignedCount = c.n; else countMap[c.salesperson_id] = c.n; });
  res.render('dealers/assign', { title: 'Assign Dealers to Salespersons', dealers, salespersons, filter, countMap, unassignedCount });
});

router.post('/assign', (req, res) => {
  if (req.session.user.role === 'salesperson' || req.session.user.role === 'production' || req.session.user.role === 'store') {
    return res.status(403).render('error', { title: 'Forbidden', message: 'Admin access required.', code: 403 });
  }
  const ids = [].concat(req.body.dealer_ids || []).map(x => parseInt(x)).filter(Boolean);
  const newSp = req.body.salesperson_id ? parseInt(req.body.salesperson_id) : null;
  if (ids.length === 0) { flash(req, 'danger', 'Pick at least one dealer'); return res.redirect('/dealers/assign'); }
  const upd = db.prepare("UPDATE dealers SET salesperson_id = ?, updated_at = datetime('now') WHERE id = ?");
  ids.forEach(id => upd.run(newSp, id));
  const spName = newSp ? db.prepare('SELECT name FROM users WHERE id=?').get(newSp)?.name : null;
  req.audit('bulk_assign', 'dealer', null, `${ids.length} dealer(s) ${newSp ? '→ ' + spName : 'unassigned'} (ids: ${ids.join(',')})`);
  flash(req, 'success', `${ids.length} dealer${ids.length>1?'s':''} ${newSp ? 'assigned to ' + spName : 'unassigned'}.`);
  res.redirect('/dealers/assign');
});

router.get('/new', (req, res) => {
  const sp = db.prepare("SELECT id,name FROM users WHERE active=1 AND role IN ('salesperson','admin','owner') ORDER BY name").all();
  res.render('dealers/form', { title: 'New Dealer', d: null, sp });
});

router.post('/', (req, res) => {
  const { name, contact_person, phone, email, address, city, state, pincode, gstin, credit_limit, opening_balance, salesperson_id } = req.body;
  const code = req.body.code || nextCode('dealers','code','DLR');
  const ownerSp = req.session.user.role === 'salesperson' ? req.session.user.id : (salesperson_id || null);
  const r = db.prepare(`INSERT INTO dealers (code,name,contact_person,phone,email,address,city,state,pincode,gstin,credit_limit,opening_balance,salesperson_id)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(code, name, contact_person||null, phone||null, email||null, address||null, city||null, state||null, pincode||null, gstin||null,
         parseFloat(credit_limit||0), parseFloat(opening_balance||0), ownerSp);
  req.audit('create', 'dealer', r.lastInsertRowid, `${code} ${name} (${city || '-'}) credit ₹${credit_limit || 0}`);
  flash(req,'success','Dealer added.'); res.redirect('/dealers');
});

// Helper: salesperson can only access their own dealers
function dealerScopeBlocked(req, dealer) {
  if (!dealer) return true;
  if (req.session.user.role === 'salesperson' && dealer.salesperson_id !== req.session.user.id) {
    return true;
  }
  return false;
}

router.get('/:id', (req, res) => {
  const d = db.prepare('SELECT d.*, u.name AS sp_name FROM dealers d LEFT JOIN users u ON u.id=d.salesperson_id WHERE d.id=?').get(req.params.id);
  if (!d) return res.redirect('/dealers');
  if (dealerScopeBlocked(req, d)) {
    flash(req, 'danger', 'This dealer is not assigned to you.');
    return res.redirect('/dealers');
  }
  const invoices = db.prepare('SELECT * FROM invoices WHERE dealer_id=? ORDER BY id DESC LIMIT 50').all(req.params.id);
  const payments = db.prepare(`SELECT p.*, pm.name AS mode FROM payments p LEFT JOIN payment_modes pm ON pm.id=p.payment_mode_id WHERE p.dealer_id=? ORDER BY p.id DESC LIMIT 50`).all(req.params.id);
  const billed = db.prepare(`SELECT COALESCE(SUM(total),0) AS v FROM invoices WHERE dealer_id=? AND status!='cancelled'`).get(req.params.id).v;
  // "Paid" sums verified payments from the payments table — NOT the
  // invoices.paid_amount cache. Standalone "Receive Payment" entries
  // that aren't tied to a specific invoice (invoice_id NULL) were
  // previously dropped from the running balance, which made the
  // outstanding figure ignore real money received.
  const paid = db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM payments WHERE dealer_id=? AND status='verified'`).get(req.params.id).v;
  const outstanding = (d.opening_balance||0) + billed - paid;
  res.render('dealers/show', { title: d.name, d, invoices, payments, billed, paid, outstanding });
});

router.get('/:id/edit', (req, res) => {
  const d = db.prepare('SELECT * FROM dealers WHERE id=?').get(req.params.id);
  if (!d) return res.redirect('/dealers');
  if (dealerScopeBlocked(req, d)) {
    flash(req, 'danger', 'This dealer is not assigned to you.');
    return res.redirect('/dealers');
  }
  const sp = db.prepare("SELECT id,name FROM users WHERE active=1 AND role IN ('salesperson','admin','owner') ORDER BY name").all();
  res.render('dealers/form', { title: 'Edit Dealer', d, sp });
});

router.post('/:id', (req, res) => {
  const existing = db.prepare('SELECT salesperson_id FROM dealers WHERE id=?').get(req.params.id);
  if (!existing) return res.redirect('/dealers');
  if (dealerScopeBlocked(req, existing)) {
    flash(req, 'danger', 'This dealer is not assigned to you.');
    return res.redirect('/dealers');
  }
  const { name, contact_person, phone, email, address, city, state, pincode, gstin, credit_limit, opening_balance, salesperson_id, active } = req.body;
  // Salesperson cannot reassign a dealer to someone else
  const newSpId = req.session.user.role === 'salesperson' ? existing.salesperson_id : (salesperson_id || null);
  db.prepare(`UPDATE dealers SET name=?, contact_person=?, phone=?, email=?, address=?, city=?, state=?, pincode=?, gstin=?, credit_limit=?, opening_balance=?, salesperson_id=?, active=?, updated_at=datetime('now') WHERE id=?`)
    .run(name, contact_person||null, phone||null, email||null, address||null, city||null, state||null, pincode||null, gstin||null,
         parseFloat(credit_limit||0), parseFloat(opening_balance||0), newSpId, active?1:0, req.params.id);
  req.audit('update', 'dealer', req.params.id, `${name} · credit ₹${credit_limit} · ${active ? 'active' : 'disabled'}`);
  flash(req,'success','Updated.'); res.redirect('/dealers/' + req.params.id);
});

module.exports = router;
