const express = require('express');
const { db } = require('../db');
const { flash, requireRole } = require('../middleware/auth');
const { nextCode } = require('../utils/codegen');
const { scopeWhere } = require('../middleware/scope');
const router = express.Router();

router.get('/', (req, res) => {
  const dealerId = req.query.dealer_id ? parseInt(req.query.dealer_id) : null;
  // Returns are tied to dealers, so scope through the dealer's
  // salesperson_id. Joins d already alias as `d`.
  const scope = scopeWhere(req, 'd.salesperson_id');
  let sql = `SELECT r.*, d.name AS dealer_name, i.invoice_no FROM returns r JOIN dealers d ON d.id=r.dealer_id LEFT JOIN invoices i ON i.id=r.invoice_id`;
  const where = [];
  const params = [];
  if (dealerId) { where.push('r.dealer_id = ?'); params.push(dealerId); }
  if (scope.where !== '1=1') { where.push(scope.where); params.push(...scope.params); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY r.id DESC LIMIT 200';
  const items = db.prepare(sql).all(...params);
  const dealerName = dealerId ? (db.prepare('SELECT name FROM dealers WHERE id=?').get(dealerId)?.name || null) : null;
  res.render('returns/index', { title: 'Returns', items, dealerId, dealerName });
});

router.get('/new', (req, res) => {
  const dealers = db.prepare('SELECT id, code, name FROM dealers WHERE active=1 ORDER BY name').all();
  // Bundle metadata so the form can show "20 bdl (80 pcs)" when the user
  // returns a bundle SKU and so the POST handler can compute total pcs to
  // restock from "bundles entered × pcs_per_bundle".
  const products = db.prepare(`
    SELECT p.*, COALESCE(p.is_bundle_sku, 0) AS is_bundle_sku,
      COALESCE((SELECT SUM(qty) FROM product_bundle_components WHERE bundle_product_id=p.id),0) AS pcs_per_bundle
    FROM products p WHERE active=1 ORDER BY name`).all();
  // Pre-load every dealer's (non-cancelled) invoices so the form can filter
  // the dropdown by selected dealer in pure client-side JS — avoids an extra
  // AJAX round-trip when the user picks a dealer.
  const invoicesByDealer = {};
  const allInv = db.prepare(`
    SELECT id, invoice_no, dealer_id, invoice_date, total, paid_amount, status
    FROM invoices WHERE status != 'cancelled' ORDER BY id DESC LIMIT 1000`).all();
  allInv.forEach(i => {
    if (!invoicesByDealer[i.dealer_id]) invoicesByDealer[i.dealer_id] = [];
    invoicesByDealer[i.dealer_id].push(i);
  });
  res.render('returns/form', {
    title: 'New Return', dealers, products, invoicesByDealer,
    ret: null, items: [], preDealerId: req.query.dealer_id || '', preInvoiceId: req.query.invoice_id || '',
  });
});

// Compute the same intra-/inter-state CGST/SGST/IGST split that invoices
// use, so the credit note reverses exactly the tax that the invoice
// collected (Indian GST compliance: credit notes must include the GST
// portion to reduce both the dealer's payable and our output-tax
// liability).
function computeGstSplit(dealer_id, items) {
  const dealer = db.prepare('SELECT state FROM dealers WHERE id=?').get(dealer_id);
  const companyState = (process.env.COMPANY_STATE || '').toLowerCase();
  const isInterState = companyState && dealer && dealer.state && dealer.state.toLowerCase() !== companyState;
  let subtotal = 0, gst = 0;
  items.forEach(i => { subtotal += i.amount; gst += i.amount * (i.gst_rate || 0) / 100; });
  let cgst = 0, sgst = 0, igst = 0;
  if (isInterState) igst = gst; else { cgst = gst / 2; sgst = gst / 2; }
  const total = subtotal + gst;
  return { subtotal, gst, cgst, sgst, igst, total };
}

router.post('/', (req, res) => {
  const { dealer_id, invoice_id, return_date, reason } = req.body;
  const items = parseItems(req.body);
  if (items.length === 0) { flash(req,'danger','Add at least one item'); return res.redirect('/returns/new'); }
  const tax = computeGstSplit(dealer_id, items);
  const return_no = nextCode('returns','return_no','RET');
  const trx = db.transaction(() => {
    const r = db.prepare(`INSERT INTO returns (return_no,invoice_id,dealer_id,return_date,reason,subtotal,gst_amount,cgst,sgst,igst,total_amount,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(return_no, invoice_id||null, dealer_id, return_date, reason||null,
           tax.subtotal, tax.gst, tax.cgst, tax.sgst, tax.igst, tax.total,
           req.session.user.id);
    // quantity = actual pcs (used by the restock side); is_bundle/bundles
    // /pcs_per_bundle are kept for the printed credit note display ("X bdl").
    // gst_rate stored per line so the credit-note table can show the GST%
    // column just like the invoice.
    const ins = db.prepare(`INSERT INTO return_items (return_id,product_id,quantity,rate,gst_rate,amount,restock,is_bundle,pcs_per_bundle,bundles) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    items.forEach(i => ins.run(r.lastInsertRowid, i.product_id, i.quantity, i.rate, i.gst_rate || 0, i.amount, i.restock ? 1 : 0, i.is_bundle ? 1 : 0, i.pcs_per_bundle || 0, i.bundles || 0));
    return r.lastInsertRowid;
  });
  const id = trx();
  req.audit('create', 'return', id, `${return_no} · ₹${tax.total.toFixed(2)} (incl. ₹${tax.gst.toFixed(2)} GST) · ${items.length} line${items.length===1?'':'s'}`);
  flash(req,'success','Return ' + return_no + ' created.');
  res.redirect('/returns/' + id);
});

router.get('/:id', (req, res) => {
  const r = db.prepare(`
    SELECT r.*, d.name AS dealer_name, d.code AS dealer_code, d.address AS dealer_address,
           d.city AS dealer_city, d.state AS dealer_state, d.phone AS dealer_phone, d.gstin AS dealer_gstin,
           i.invoice_no, u.name AS created_by_name
    FROM returns r
    JOIN dealers d ON d.id=r.dealer_id
    LEFT JOIN invoices i ON i.id=r.invoice_id
    LEFT JOIN users u ON u.id=r.created_by
    WHERE r.id=?`).get(req.params.id);
  if (!r) return res.redirect('/returns');
  const items = db.prepare(`SELECT ri.*, p.code, p.name FROM return_items ri JOIN products p ON p.id=ri.product_id WHERE ri.return_id=?`).all(req.params.id);
  res.render('returns/show', { title: 'Return ' + r.return_no, r, items });
});

router.get('/:id/edit', (req, res) => {
  const ret = db.prepare('SELECT * FROM returns WHERE id=?').get(req.params.id);
  if (!ret) return res.redirect('/returns');
  if (ret.status !== 'pending') { flash(req,'danger','Only pending returns can be edited'); return res.redirect('/returns/' + ret.id); }
  const dealers = db.prepare('SELECT id, code, name FROM dealers WHERE active=1 ORDER BY name').all();
  const products = db.prepare(`
    SELECT p.*, COALESCE(p.is_bundle_sku, 0) AS is_bundle_sku,
      COALESCE((SELECT SUM(qty) FROM product_bundle_components WHERE bundle_product_id=p.id),0) AS pcs_per_bundle
    FROM products p WHERE active=1 ORDER BY name`).all();
  const invoicesByDealer = {};
  const allInv = db.prepare(`
    SELECT id, invoice_no, dealer_id, invoice_date, total, paid_amount, status
    FROM invoices WHERE status != 'cancelled' ORDER BY id DESC LIMIT 1000`).all();
  allInv.forEach(i => {
    if (!invoicesByDealer[i.dealer_id]) invoicesByDealer[i.dealer_id] = [];
    invoicesByDealer[i.dealer_id].push(i);
  });
  const items = db.prepare('SELECT * FROM return_items WHERE return_id=?').all(req.params.id);
  res.render('returns/form', {
    title: 'Edit Return ' + ret.return_no, dealers, products, invoicesByDealer,
    ret, items, preDealerId: ret.dealer_id, preInvoiceId: ret.invoice_id || '',
  });
});

router.post('/:id', (req, res) => {
  const ret = db.prepare('SELECT * FROM returns WHERE id=?').get(req.params.id);
  if (!ret) return res.redirect('/returns');
  if (ret.status !== 'pending') { flash(req,'danger','Only pending returns can be edited'); return res.redirect('/returns/' + ret.id); }
  const { dealer_id, invoice_id, return_date, reason } = req.body;
  const items = parseItems(req.body);
  if (items.length === 0) { flash(req,'danger','Add at least one item'); return res.redirect('/returns/' + ret.id + '/edit'); }
  const tax = computeGstSplit(dealer_id, items);
  const trx = db.transaction(() => {
    db.prepare(`UPDATE returns SET dealer_id=?, invoice_id=?, return_date=?, reason=?, subtotal=?, gst_amount=?, cgst=?, sgst=?, igst=?, total_amount=? WHERE id=?`)
      .run(dealer_id, invoice_id||null, return_date, reason||null,
           tax.subtotal, tax.gst, tax.cgst, tax.sgst, tax.igst, tax.total, ret.id);
    db.prepare('DELETE FROM return_items WHERE return_id=?').run(ret.id);
    const ins = db.prepare(`INSERT INTO return_items (return_id,product_id,quantity,rate,gst_rate,amount,restock,is_bundle,pcs_per_bundle,bundles) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    items.forEach(i => ins.run(ret.id, i.product_id, i.quantity, i.rate, i.gst_rate || 0, i.amount, i.restock ? 1 : 0, i.is_bundle ? 1 : 0, i.pcs_per_bundle || 0, i.bundles || 0));
  });
  trx();
  req.audit('update', 'return', ret.id, `${ret.return_no} · ₹${tax.total.toFixed(2)} (incl. ₹${tax.gst.toFixed(2)} GST)`);
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
  const gsts = [].concat(body.gst_rate || []);
  const restocks = [].concat(body.restock || []);
  const units = [].concat(body.unit || []);
  for (let i = 0; i < ids.length; i++) {
    const pid = parseInt(ids[i]);
    const enteredQ = parseInt(qtys[i] || 0);
    const r = parseFloat(rates[i] || 0);
    if (!pid || !enteredQ) continue;
    // If unit='bdl', the user typed bundle count — look up pcs_per_bundle on
    // the product master and expand to pieces. Rate is stored per-piece so
    // the amount math stays consistent with how invoices price bundles.
    const isBundle = units[i] === 'bdl';
    let pcs_per_bundle = 0;
    if (isBundle) {
      const ppb = db.prepare(`SELECT COALESCE((SELECT SUM(qty) FROM product_bundle_components WHERE bundle_product_id=?),0) AS ppb`).get(pid).ppb;
      pcs_per_bundle = ppb || 0;
    }
    const totalPcs = isBundle && pcs_per_bundle > 0 ? enteredQ * pcs_per_bundle : enteredQ;
    // GST rate — form value wins, otherwise fall back to product master so
    // an older form-post that didn't include gst_rate still gets the right
    // tax applied. Returns must reverse exactly the tax the invoice
    // charged to keep the dealer ledger straight.
    let gstRate = parseFloat(gsts[i]);
    if (!isFinite(gstRate) || gstRate < 0) gstRate = NaN;
    if (isNaN(gstRate)) {
      const p = db.prepare('SELECT gst_rate FROM products WHERE id=?').get(pid);
      gstRate = p ? (p.gst_rate || 0) : 0;
    }
    out.push({
      product_id: pid,
      quantity: totalPcs,                                  // restocking unit = pieces
      rate: r,                                             // per piece
      gst_rate: gstRate,
      amount: totalPcs * r,
      restock: restocks[i] === '1',
      is_bundle: isBundle && pcs_per_bundle > 0,
      pcs_per_bundle,
      bundles: isBundle && pcs_per_bundle > 0 ? enteredQ : 0,
    });
  }
  return out;
}

module.exports = router;
