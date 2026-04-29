const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { nextCode } = require('../utils/codegen');
const router = express.Router();

router.get('/', (req, res) => {
  const q = (req.query.q||'').trim();
  const filter = req.query.filter || 'all';
  let sql = `
    SELECT d.*, u.name AS sp_name,
      COALESCE((SELECT SUM(total) FROM invoices WHERE dealer_id=d.id AND status!='cancelled'),0) AS billed,
      COALESCE((SELECT SUM(paid_amount) FROM invoices WHERE dealer_id=d.id AND status!='cancelled'),0) AS paid
    FROM dealers d LEFT JOIN users u ON u.id=d.salesperson_id`;
  const params = [];
  const where = [];
  if (q) { where.push('(d.code LIKE ? OR d.name LIKE ? OR d.phone LIKE ?)'); params.push(`%${q}%`,`%${q}%`,`%${q}%`); }
  if (filter === 'mine' && req.session.user.role === 'salesperson') { where.push('d.salesperson_id=?'); params.push(req.session.user.id); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY d.id DESC';
  const items = db.prepare(sql).all(...params);
  items.forEach(d => d.outstanding = (d.opening_balance||0) + d.billed - d.paid);
  res.render('dealers/index', { title: 'Dealers / Customers', items, q, filter });
});

router.get('/new', (req, res) => {
  const sp = db.prepare("SELECT id,name FROM users WHERE active=1 AND role IN ('salesperson','admin','owner') ORDER BY name").all();
  res.render('dealers/form', { title: 'New Dealer', d: null, sp });
});

router.post('/', (req, res) => {
  const { name, contact_person, phone, email, address, city, state, pincode, gstin, credit_limit, opening_balance, salesperson_id } = req.body;
  const code = req.body.code || nextCode('dealers','code','DLR');
  db.prepare(`INSERT INTO dealers (code,name,contact_person,phone,email,address,city,state,pincode,gstin,credit_limit,opening_balance,salesperson_id)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(code, name, contact_person||null, phone||null, email||null, address||null, city||null, state||null, pincode||null, gstin||null,
         parseFloat(credit_limit||0), parseFloat(opening_balance||0), salesperson_id||null);
  flash(req,'success','Dealer added.'); res.redirect('/dealers');
});

router.get('/:id', (req, res) => {
  const d = db.prepare('SELECT d.*, u.name AS sp_name FROM dealers d LEFT JOIN users u ON u.id=d.salesperson_id WHERE d.id=?').get(req.params.id);
  if (!d) return res.redirect('/dealers');
  const invoices = db.prepare('SELECT * FROM invoices WHERE dealer_id=? ORDER BY id DESC LIMIT 50').all(req.params.id);
  const payments = db.prepare(`SELECT p.*, pm.name AS mode FROM payments p LEFT JOIN payment_modes pm ON pm.id=p.payment_mode_id WHERE p.dealer_id=? ORDER BY p.id DESC LIMIT 50`).all(req.params.id);
  const billed = db.prepare(`SELECT COALESCE(SUM(total),0) AS v FROM invoices WHERE dealer_id=? AND status!='cancelled'`).get(req.params.id).v;
  const paid = db.prepare(`SELECT COALESCE(SUM(paid_amount),0) AS v FROM invoices WHERE dealer_id=? AND status!='cancelled'`).get(req.params.id).v;
  const outstanding = (d.opening_balance||0) + billed - paid;
  res.render('dealers/show', { title: d.name, d, invoices, payments, billed, paid, outstanding });
});

router.get('/:id/edit', (req, res) => {
  const d = db.prepare('SELECT * FROM dealers WHERE id=?').get(req.params.id);
  const sp = db.prepare("SELECT id,name FROM users WHERE active=1 AND role IN ('salesperson','admin','owner') ORDER BY name").all();
  res.render('dealers/form', { title: 'Edit Dealer', d, sp });
});

router.post('/:id', (req, res) => {
  const { name, contact_person, phone, email, address, city, state, pincode, gstin, credit_limit, opening_balance, salesperson_id, active } = req.body;
  db.prepare(`UPDATE dealers SET name=?, contact_person=?, phone=?, email=?, address=?, city=?, state=?, pincode=?, gstin=?, credit_limit=?, opening_balance=?, salesperson_id=?, active=?, updated_at=datetime('now') WHERE id=?`)
    .run(name, contact_person||null, phone||null, email||null, address||null, city||null, state||null, pincode||null, gstin||null,
         parseFloat(credit_limit||0), parseFloat(opening_balance||0), salesperson_id||null, active?1:0, req.params.id);
  flash(req,'success','Updated.'); res.redirect('/dealers/' + req.params.id);
});

module.exports = router;
