const express = require('express');
const { db } = require('../db');
const { flash, requireRole } = require('../middleware/auth');
const { nextCode } = require('../utils/codegen');
const router = express.Router();

router.get('/', (req, res) => {
  const items = db.prepare(`SELECT r.*, d.name AS dealer_name, i.invoice_no FROM returns r JOIN dealers d ON d.id=r.dealer_id LEFT JOIN invoices i ON i.id=r.invoice_id ORDER BY r.id DESC LIMIT 200`).all();
  res.render('returns/index', { title: 'Returns', items });
});

router.get('/new', (req, res) => {
  const dealers = db.prepare('SELECT * FROM dealers WHERE active=1 ORDER BY name').all();
  const products = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY name').all();
  res.render('returns/form', { title: 'New Return', dealers, products, ret: null, items: [] });
});

router.post('/', (req, res) => {
  const { dealer_id, invoice_id, return_date, reason } = req.body;
  const items = parseItems(req.body);
  if (items.length === 0) { flash(req,'danger','Add at least one item'); return res.redirect('/returns/new'); }
  const total = items.reduce((s,i) => s + i.amount, 0);
  const return_no = nextCode('returns','return_no','RET');
  const trx = db.transaction(() => {
    const r = db.prepare(`INSERT INTO returns (return_no,invoice_id,dealer_id,return_date,reason,total_amount,created_by) VALUES (?,?,?,?,?,?,?)`)
      .run(return_no, invoice_id||null, dealer_id, return_date, reason||null, total, req.session.user.id);
    const ins = db.prepare(`INSERT INTO return_items (return_id,product_id,quantity,rate,amount,restock) VALUES (?,?,?,?,?,?)`);
    items.forEach(i => ins.run(r.lastInsertRowid, i.product_id, i.quantity, i.rate, i.amount, i.restock ? 1 : 0));
    return r.lastInsertRowid;
  });
  const id = trx();
  flash(req,'success','Return ' + return_no + ' created.');
  res.redirect('/returns/' + id);
});

router.get('/:id', (req, res) => {
  const r = db.prepare(`SELECT r.*, d.name AS dealer_name, i.invoice_no FROM returns r JOIN dealers d ON d.id=r.dealer_id LEFT JOIN invoices i ON i.id=r.invoice_id WHERE r.id=?`).get(req.params.id);
  if (!r) return res.redirect('/returns');
  const items = db.prepare(`SELECT ri.*, p.code, p.name FROM return_items ri JOIN products p ON p.id=ri.product_id WHERE ri.return_id=?`).all(req.params.id);
  res.render('returns/show', { title: 'Return ' + r.return_no, r, items });
});

router.get('/:id/edit', (req, res) => {
  const ret = db.prepare('SELECT * FROM returns WHERE id=?').get(req.params.id);
  if (!ret) return res.redirect('/returns');
  if (ret.status !== 'pending') { flash(req,'danger','Only pending returns can be edited'); return res.redirect('/returns/' + ret.id); }
  const dealers = db.prepare('SELECT * FROM dealers WHERE active=1 ORDER BY name').all();
  const products = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY name').all();
  const items = db.prepare('SELECT * FROM return_items WHERE return_id=?').all(req.params.id);
  res.render('returns/form', { title: 'Edit Return ' + ret.return_no, dealers, products, ret, items });
});

router.post('/:id', (req, res) => {
  const ret = db.prepare('SELECT * FROM returns WHERE id=?').get(req.params.id);
  if (!ret) return res.redirect('/returns');
  if (ret.status !== 'pending') { flash(req,'danger','Only pending returns can be edited'); return res.redirect('/returns/' + ret.id); }
  const { dealer_id, invoice_id, return_date, reason } = req.body;
  const items = parseItems(req.body);
  if (items.length === 0) { flash(req,'danger','Add at least one item'); return res.redirect('/returns/' + ret.id + '/edit'); }
  const total = items.reduce((s,i) => s + i.amount, 0);
  const trx = db.transaction(() => {
    db.prepare(`UPDATE returns SET dealer_id=?, invoice_id=?, return_date=?, reason=?, total_amount=? WHERE id=?`)
      .run(dealer_id, invoice_id||null, return_date, reason||null, total, ret.id);
    db.prepare('DELETE FROM return_items WHERE return_id=?').run(ret.id);
    const ins = db.prepare(`INSERT INTO return_items (return_id,product_id,quantity,rate,amount,restock) VALUES (?,?,?,?,?,?)`);
    items.forEach(i => ins.run(ret.id, i.product_id, i.quantity, i.rate, i.amount, i.restock ? 1 : 0));
  });
  trx();
  flash(req,'success','Return ' + ret.return_no + ' updated.');
  res.redirect('/returns/' + ret.id);
});

router.post('/:id/approve', requireRole('admin','accountant'), (req, res) => {
  const r = db.prepare('SELECT * FROM returns WHERE id=?').get(req.params.id);
  if (!r || r.status !== 'pending') { flash(req,'danger','Cannot approve'); return res.redirect('/returns/' + req.params.id); }
  const items = db.prepare('SELECT * FROM return_items WHERE return_id=?').all(req.params.id);
  const trx = db.transaction(() => {
    db.prepare("UPDATE returns SET status='approved' WHERE id=?").run(req.params.id);
    items.forEach(i => {
      if (i.restock) {
        db.prepare(`INSERT INTO ready_stock (product_id, quantity) VALUES (?,?) ON CONFLICT(product_id) DO UPDATE SET quantity = quantity + excluded.quantity, updated_at=datetime('now')`).run(i.product_id, i.quantity);
        db.prepare(`INSERT INTO stock_movements (product_id,movement_type,quantity,ref_table,ref_id,created_by) VALUES (?,?,?,?,?,?)`).run(i.product_id, 'return_in', i.quantity, 'returns', req.params.id, req.session.user.id);
      }
    });
    db.prepare("UPDATE returns SET status='restocked' WHERE id=?").run(req.params.id);
  });
  trx();
  flash(req,'success','Approved & restocked.'); res.redirect('/returns/' + req.params.id);
});

router.post('/:id/reject', requireRole('admin','accountant'), (req, res) => {
  db.prepare("UPDATE returns SET status='rejected' WHERE id=?").run(req.params.id);
  flash(req,'success','Rejected.'); res.redirect('/returns/' + req.params.id);
});

function parseItems(body) {
  const out = [];
  const ids = [].concat(body.product_id || []);
  const qtys = [].concat(body.quantity || []);
  const rates = [].concat(body.rate || []);
  const restocks = [].concat(body.restock || []);
  for (let i = 0; i < ids.length; i++) {
    const pid = parseInt(ids[i]); const q = parseInt(qtys[i]||0); const r = parseFloat(rates[i]||0);
    if (!pid || !q) continue;
    out.push({ product_id: pid, quantity: q, rate: r, amount: q*r, restock: restocks[i] === '1' });
  }
  return out;
}

module.exports = router;
