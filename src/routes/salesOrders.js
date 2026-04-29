const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { nextCode } = require('../utils/codegen');
const router = express.Router();

router.get('/', (req, res) => {
  let sql = `SELECT so.*, d.name AS dealer_name, u.name AS sp_name FROM sales_orders so JOIN dealers d ON d.id=so.dealer_id LEFT JOIN users u ON u.id=so.salesperson_id`;
  const params = [];
  if (req.session.user.role === 'salesperson') { sql += ' WHERE so.salesperson_id=?'; params.push(req.session.user.id); }
  sql += ' ORDER BY so.id DESC LIMIT 200';
  const orders = db.prepare(sql).all(...params);
  res.render('salesOrders/index', { title: 'Sales Orders', orders });
});

router.get('/new', (req, res) => {
  const dealers = db.prepare('SELECT * FROM dealers WHERE active=1 ORDER BY name').all();
  const products = db.prepare(`SELECT p.*, COALESCE(rs.quantity,0) AS stock_qty FROM products p LEFT JOIN ready_stock rs ON rs.product_id=p.id WHERE p.active=1 ORDER BY p.name`).all();
  res.render('salesOrders/form', { title: 'New Sales Order', dealers, products, preselect: req.query.dealer_id });
});

router.post('/', (req, res) => {
  const { dealer_id, order_date, notes } = req.body;
  const items = parseItems(req.body);
  if (items.length === 0) { flash(req,'danger','Add at least one item'); return res.redirect('/sales-orders/new'); }
  const order_no = nextCode('sales_orders','order_no','SO');
  const totals = computeTotals(items);
  const sp = db.prepare('SELECT salesperson_id FROM dealers WHERE id=?').get(dealer_id);
  const trx = db.transaction(() => {
    const r = db.prepare(`INSERT INTO sales_orders (order_no,dealer_id,salesperson_id,order_date,subtotal,gst_amount,total,notes,created_by) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(order_no, dealer_id, sp ? sp.salesperson_id : null, order_date, totals.subtotal, totals.gst, totals.total, notes||null, req.session.user.id);
    const ins = db.prepare(`INSERT INTO sales_order_items (sales_order_id,product_id,quantity,rate,gst_rate,amount) VALUES (?,?,?,?,?,?)`);
    items.forEach(i => ins.run(r.lastInsertRowid, i.product_id, i.quantity, i.rate, i.gst_rate, i.amount));
    return r.lastInsertRowid;
  });
  const id = trx();
  flash(req,'success','Order ' + order_no + ' created.');
  res.redirect('/sales-orders/' + id);
});

router.get('/:id', (req, res) => {
  const o = db.prepare(`SELECT so.*, d.name AS dealer_name, d.gstin AS dealer_gstin, d.address AS dealer_address, d.city AS dealer_city, u.name AS sp_name FROM sales_orders so JOIN dealers d ON d.id=so.dealer_id LEFT JOIN users u ON u.id=so.salesperson_id WHERE so.id=?`).get(req.params.id);
  if (!o) return res.redirect('/sales-orders');
  const items = db.prepare(`SELECT i.*, p.code, p.name FROM sales_order_items i JOIN products p ON p.id=i.product_id WHERE i.sales_order_id=?`).all(req.params.id);
  res.render('salesOrders/show', { title: 'Sales Order ' + o.order_no, o, items });
});

router.post('/:id/confirm', (req, res) => {
  db.prepare("UPDATE sales_orders SET status='confirmed' WHERE id=? AND status='pending'").run(req.params.id);
  flash(req,'success','Confirmed.'); res.redirect('/sales-orders/' + req.params.id);
});

router.post('/:id/cancel', (req, res) => {
  db.prepare("UPDATE sales_orders SET status='cancelled' WHERE id=?").run(req.params.id);
  flash(req,'success','Cancelled.'); res.redirect('/sales-orders/' + req.params.id);
});

router.post('/:id/invoice', (req, res) => {
  // Convert SO to Invoice
  const o = db.prepare('SELECT * FROM sales_orders WHERE id=?').get(req.params.id);
  if (!o || o.status === 'cancelled') { flash(req,'danger','Cannot invoice'); return res.redirect('/sales-orders/' + req.params.id); }
  const items = db.prepare('SELECT * FROM sales_order_items WHERE sales_order_id=?').all(req.params.id);
  const dealer = db.prepare('SELECT state FROM dealers WHERE id=?').get(o.dealer_id);
  const companyState = (process.env.COMPANY_STATE || '').toLowerCase();
  const isInterState = companyState && dealer && dealer.state && dealer.state.toLowerCase() !== companyState;
  let subtotal = 0, gst = 0;
  items.forEach(i => { subtotal += i.amount; gst += i.amount * i.gst_rate / 100; });
  let cgst=0,sgst=0,igst=0;
  if (isInterState) igst = gst; else { cgst = gst/2; sgst = gst/2; }
  const total = subtotal + gst;
  const invoice_no = nextCode('invoices','invoice_no','INV');
  const trx = db.transaction(() => {
    const r = db.prepare(`INSERT INTO invoices (invoice_no,sales_order_id,dealer_id,salesperson_id,invoice_date,subtotal,cgst,sgst,igst,total,created_by) VALUES (?,?,?,?,date('now'),?,?,?,?,?,?)`)
      .run(invoice_no, o.id, o.dealer_id, o.salesperson_id, subtotal, cgst, sgst, igst, total, req.session.user.id);
    const ins = db.prepare(`INSERT INTO invoice_items (invoice_id,product_id,quantity,rate,gst_rate,amount) VALUES (?,?,?,?,?,?)`);
    items.forEach(i => ins.run(r.lastInsertRowid, i.product_id, i.quantity, i.rate, i.gst_rate, i.amount));
    db.prepare("UPDATE sales_orders SET status='invoiced' WHERE id=?").run(o.id);
    // Decrement stock
    items.forEach(i => {
      db.prepare('UPDATE ready_stock SET quantity = quantity - ? WHERE product_id=?').run(i.quantity, i.product_id);
      db.prepare(`INSERT INTO stock_movements (product_id,movement_type,quantity,ref_table,ref_id,created_by) VALUES (?,?,?,?,?,?)`).run(i.product_id, 'sale_out', i.quantity, 'invoices', r.lastInsertRowid, req.session.user.id);
    });
    return r.lastInsertRowid;
  });
  const newId = trx();
  flash(req,'success','Invoice ' + invoice_no + ' generated.');
  res.redirect('/invoices/' + newId);
});

function parseItems(body) {
  const out = [];
  const ids = [].concat(body.product_id || []);
  const qtys = [].concat(body.quantity || []);
  const rates = [].concat(body.rate || []);
  const gsts = [].concat(body.gst_rate || []);
  for (let i = 0; i < ids.length; i++) {
    const pid = parseInt(ids[i]); const q = parseInt(qtys[i]||0); const r = parseFloat(rates[i]||0); const g = parseFloat(gsts[i]||0);
    if (!pid || !q || !r) continue;
    out.push({ product_id: pid, quantity: q, rate: r, gst_rate: g, amount: q*r });
  }
  return out;
}

function computeTotals(items) {
  let subtotal = 0, gst = 0;
  items.forEach(i => { subtotal += i.amount; gst += i.amount * i.gst_rate / 100; });
  return { subtotal, gst, total: subtotal + gst };
}

module.exports = router;
