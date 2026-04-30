const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { nextCode } = require('../utils/codegen');
const { notifyInvoice } = require('../utils/notify');
const router = express.Router();

function maybeAutoSendInvoiceSMS(id) {
  const r = db.prepare(`SELECT value FROM app_settings WHERE key='SMS_AUTO_SEND_INVOICE'`).get();
  if (r && r.value === 'false') return;          // explicit opt-out
  setImmediate(() => { notifyInvoice(id).catch(e => console.error('[autoSendInvoiceSMS]', e.message)); });
}

router.get('/', (req, res) => {
  const status = req.query.status || 'all';
  const dealerId = req.query.dealer_id;
  let sql = `SELECT i.*, d.name AS dealer_name, u.name AS sp_name FROM invoices i JOIN dealers d ON d.id=i.dealer_id LEFT JOIN users u ON u.id=i.salesperson_id`;
  const params = [];
  const where = [];
  if (status !== 'all') { where.push('i.status=?'); params.push(status); }
  if (dealerId) { where.push('i.dealer_id=?'); params.push(dealerId); }
  if (req.session.user.role === 'salesperson') { where.push('i.salesperson_id=?'); params.push(req.session.user.id); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY i.id DESC LIMIT 200';
  const invoices = db.prepare(sql).all(...params);
  let dealerName = null;
  if (dealerId) {
    const d = db.prepare('SELECT name FROM dealers WHERE id=?').get(dealerId);
    dealerName = d ? d.name : null;
  }
  res.render('invoices/index', { title: 'Invoices', invoices, status, dealerId, dealerName });
});

router.get('/new', (req, res) => {
  const dealers = db.prepare('SELECT * FROM dealers WHERE active=1 ORDER BY name').all();
  const products = db.prepare(`
    SELECT p.*, COALESCE(rs.quantity,0) AS stock_qty,
      COALESCE((SELECT SUM(qty) FROM product_bundle_components WHERE bundle_product_id=p.id),0) AS pcs_per_bundle,
      CASE WHEN p.is_bundle_sku = 1 THEN
        (SELECT MIN(CAST(COALESCE(rs2.quantity,0) AS REAL) / NULLIF(bc.qty, 0))
         FROM product_bundle_components bc
         LEFT JOIN ready_stock rs2 ON rs2.product_id = bc.member_product_id
         WHERE bc.bundle_product_id = p.id)
      ELSE NULL END AS bundles_available
    FROM products p
    LEFT JOIN ready_stock rs ON rs.product_id=p.id
    WHERE p.active=1 ORDER BY p.name
  `).all();
  res.render('invoices/form', { title: 'New Invoice', dealers, products, preselect: req.query.dealer_id });
});

router.post('/', (req, res) => {
  const { dealer_id, invoice_date, notes } = req.body;
  const discountReq = Math.max(0, parseFloat(req.body.discount_amount || 0));
  const items = parseItems(req.body);
  if (items.length === 0) { flash(req,'danger','Add at least one item'); return res.redirect('/invoices/new'); }
  const sp = db.prepare('SELECT salesperson_id FROM dealers WHERE id=?').get(dealer_id);
  const dealer = db.prepare('SELECT state FROM dealers WHERE id=?').get(dealer_id);
  const companyState = (process.env.COMPANY_STATE || '').toLowerCase();
  const isInterState = companyState && dealer && dealer.state && dealer.state.toLowerCase() !== companyState;
  let subtotal = 0;
  items.forEach(i => { subtotal += i.amount; });
  const discount = Math.min(discountReq, subtotal);
  const factor = subtotal > 0 ? (subtotal - discount) / subtotal : 1;
  let gst = 0;
  items.forEach(i => { gst += (i.amount * factor) * i.gst_rate / 100; });
  let cgst=0,sgst=0,igst=0;
  if (isInterState) igst = gst; else { cgst = gst/2; sgst = gst/2; }
  const total = subtotal - discount + gst;
  const invoice_no = nextCode('invoices','invoice_no','INV');
  const trx = db.transaction(() => {
    const r = db.prepare(`INSERT INTO invoices (invoice_no,dealer_id,salesperson_id,invoice_date,subtotal,discount_amount,cgst,sgst,igst,total,notes,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(invoice_no, dealer_id, sp ? sp.salesperson_id : null, invoice_date, subtotal, discount, cgst, sgst, igst, total, notes||null, req.session.user.id);
    const ins = db.prepare(`INSERT INTO invoice_items (invoice_id,product_id,quantity,rate,gst_rate,amount) VALUES (?,?,?,?,?,?)`);
    const { decrementStock } = require('./salesOrders');
    items.forEach(i => {
      ins.run(r.lastInsertRowid, i.product_id, i.quantity, i.rate, i.gst_rate, i.amount);
      decrementStock(i, r.lastInsertRowid, req.session.user.id);
    });
    return r.lastInsertRowid;
  });
  const id = trx();
  req.audit('create', 'invoice', id, `${invoice_no} · dealer #${dealer_id} · ₹${total}${discount?' (disc ₹'+discount.toFixed(2)+')':''} (${items.length} item${items.length>1?'s':''})`);
  flash(req,'success','Invoice ' + invoice_no + ' created.');
  maybeAutoSendInvoiceSMS(id);
  res.redirect('/invoices/' + id);
});

router.get('/:id', (req, res) => {
  const i = db.prepare(`SELECT i.*, d.name AS dealer_name, d.gstin AS dealer_gstin, d.address AS dealer_address, d.city AS dealer_city, d.state AS dealer_state, d.pincode AS dealer_pincode, d.phone AS dealer_phone, u.name AS sp_name FROM invoices i JOIN dealers d ON d.id=i.dealer_id LEFT JOIN users u ON u.id=i.salesperson_id WHERE i.id=?`).get(req.params.id);
  if (!i) return res.redirect('/invoices');
  const items = db.prepare(`SELECT it.*, p.code, p.name, p.hsn_code FROM invoice_items it JOIN products p ON p.id=it.product_id WHERE it.invoice_id=?`).all(req.params.id);
  const payments = db.prepare(`SELECT p.*, pm.name AS mode FROM payments p LEFT JOIN payment_modes pm ON pm.id=p.payment_mode_id WHERE p.invoice_id=? ORDER BY p.id DESC`).all(req.params.id);
  res.render('invoices/show', { title: 'Invoice ' + i.invoice_no, i, items, payments });
});

router.get('/:id/print', (req, res) => {
  const i = db.prepare(`SELECT i.*, d.name AS dealer_name, d.gstin AS dealer_gstin, d.address AS dealer_address, d.city AS dealer_city, d.state AS dealer_state, d.pincode AS dealer_pincode, d.phone AS dealer_phone FROM invoices i JOIN dealers d ON d.id=i.dealer_id WHERE i.id=?`).get(req.params.id);
  if (!i) return res.redirect('/invoices');
  const items = db.prepare(`SELECT it.*, p.code, p.name, p.hsn_code FROM invoice_items it JOIN products p ON p.id=it.product_id WHERE it.invoice_id=?`).all(req.params.id);
  res.render('invoices/print', { title: i.invoice_no, i, items, layout: false });
});

router.post('/:id/cancel', (req, res) => {
  db.prepare("UPDATE invoices SET status='cancelled' WHERE id=?").run(req.params.id);
  req.audit('cancel', 'invoice', req.params.id);
  flash(req,'success','Cancelled.'); res.redirect('/invoices/' + req.params.id);
});

// Limited edit: only invoice_date and notes. Line items / amounts are immutable
// for tax/audit reasons — to change line items, cancel and recreate the invoice.
router.get('/:id/edit', (req, res) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
  if (!inv) return res.redirect('/invoices');
  if (inv.status === 'cancelled' || inv.status === 'paid') {
    flash(req, 'danger', 'Cannot edit a ' + inv.status + ' invoice');
    return res.redirect('/invoices/' + inv.id);
  }
  res.render('invoices/edit', { title: 'Edit Invoice ' + inv.invoice_no, inv });
});

router.post('/:id', (req, res) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
  if (!inv) return res.redirect('/invoices');
  if (inv.status === 'cancelled' || inv.status === 'paid') {
    flash(req, 'danger', 'Cannot edit a ' + inv.status + ' invoice');
    return res.redirect('/invoices/' + inv.id);
  }
  const { invoice_date, notes } = req.body;
  const discountReq = Math.max(0, parseFloat(req.body.discount_amount || 0));
  // Block lowering discount below already-paid amount (would push status to overpaid).
  const items = db.prepare('SELECT it.*, it.amount, it.gst_rate FROM invoice_items it WHERE it.invoice_id=?').all(inv.id);
  let subtotal = 0;
  items.forEach(i => { subtotal += i.amount; });
  const discount = Math.min(discountReq, subtotal);
  const factor = subtotal > 0 ? (subtotal - discount) / subtotal : 1;
  let gst = 0;
  items.forEach(i => { gst += (i.amount * factor) * i.gst_rate / 100; });
  // Re-split CGST/SGST vs IGST using the dealer's state at the time of edit
  const dealer = db.prepare('SELECT state FROM dealers WHERE id=?').get(inv.dealer_id);
  const companyState = (process.env.COMPANY_STATE || '').toLowerCase();
  const isInterState = companyState && dealer && dealer.state && dealer.state.toLowerCase() !== companyState;
  let cgst=0,sgst=0,igst=0;
  if (isInterState) igst = gst; else { cgst = gst/2; sgst = gst/2; }
  const total = subtotal - discount + gst;
  if (total < (inv.paid_amount || 0)) {
    flash(req, 'danger', 'Discount too high — total would fall below already-paid ₹' + (inv.paid_amount||0).toFixed(2));
    return res.redirect('/invoices/' + inv.id + '/edit');
  }
  // Update status if total changed enough that paid_amount now satisfies it
  let newStatus = inv.status;
  if (newStatus !== 'cancelled') {
    if ((inv.paid_amount || 0) + 0.01 >= total) newStatus = 'paid';
    else if ((inv.paid_amount || 0) > 0) newStatus = 'partial';
    else newStatus = 'unpaid';
  }
  db.prepare('UPDATE invoices SET invoice_date=?, notes=?, discount_amount=?, cgst=?, sgst=?, igst=?, total=?, status=? WHERE id=?')
    .run(invoice_date, notes||null, discount, cgst, sgst, igst, total, newStatus, inv.id);
  req.audit('update', 'invoice', inv.id, inv.invoice_no + ' · disc ₹' + discount.toFixed(2) + ' · total ₹' + total.toFixed(2));
  flash(req,'success','Updated.');
  res.redirect('/invoices/' + inv.id);
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
    const bundleInfo = db.prepare('SELECT is_bundle_sku FROM products WHERE id=?').get(pid);
    let amount;
    if (bundleInfo && bundleInfo.is_bundle_sku) {
      const ppb = db.prepare('SELECT COALESCE(SUM(qty),0) AS n FROM product_bundle_components WHERE bundle_product_id=?').get(pid).n;
      amount = q * ppb * r;        // bundles × pieces/bundle × per-piece rate
    } else {
      amount = q * r;
    }
    out.push({ product_id: pid, quantity: q, rate: r, gst_rate: g, amount });
  }
  return out;
}

module.exports = router;
