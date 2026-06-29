const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { nextCode } = require('../utils/codegen');
const { notifyInvoice } = require('../utils/notify');
const { scopeWhere } = require('../middleware/scope');
const stock = require('../utils/stock');
const router = express.Router();

function maybeAutoSendInvoiceSMS(id) {
  const r = db.prepare(`SELECT value FROM app_settings WHERE key='SMS_AUTO_SEND_INVOICE'`).get();
  if (r && r.value === 'false') return;
  setImmediate(() => { notifyInvoice(id).catch(e => console.error('[autoSendInvoiceSMS]', e.message)); });
}

router.get('/', (req, res) => {
  const from = req.query.from || null, to = req.query.to || null;
  // Team scope: salesperson sees own; area_manager sees team (own +
  // direct reports); owner/admin/accountant see all.
  const scope = scopeWhere(req, 'so.salesperson_id');
  const where = [], params = [];
  if (scope.where !== '1=1') { where.push(scope.where); params.push(...scope.params); }
  if (from) { where.push('so.order_date >= ?'); params.push(from); }
  if (to)   { where.push('so.order_date <= ?'); params.push(to); }
  let sql = `SELECT so.*, d.name AS dealer_name, u.name AS sp_name FROM sales_orders so JOIN dealers d ON d.id=so.dealer_id LEFT JOIN users u ON u.id=so.salesperson_id`;
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY so.id DESC LIMIT 500';
  const orders = db.prepare(sql).all(...params);
  // Over-limit invoices waiting for THIS user to approve (their reports, or all
  // if owner/admin) — surfaced as a banner so managers act on them.
  const u = req.session.user;
  const mineOnly = !['owner', 'admin'].includes(u.role);
  const approvals = db.prepare(`
    SELECT so.id, so.order_no, so.total, d.name AS dealer_name, rq.name AS requested_name
    FROM sales_orders so JOIN dealers d ON d.id=so.dealer_id LEFT JOIN users rq ON rq.id=so.requested_by
    WHERE so.approval_status='pending'${mineOnly ? ' AND so.approval_by=?' : ''}
    ORDER BY so.id DESC LIMIT 50`).all(...(mineOnly ? [u.id] : []));
  res.render('salesOrders/index', { title: 'Sales Orders', orders, from, to, approvals });
});

router.get('/new', (req, res) => {
  const dealers = require('../middleware/scope').scopedDealers(req);
  const products = db.prepare(`
    SELECT p.*, COALESCE(rs.quantity,0) AS stock_qty,
      COALESCE((SELECT SUM(qty) FROM product_bundle_components WHERE bundle_product_id=p.id),0) AS pcs_per_bundle,
      CASE WHEN p.is_bundle_sku = 1 THEN
        (SELECT MIN(CAST(COALESCE(rs2.quantity,0) AS REAL) / NULLIF(bc.qty, 0))
         FROM product_bundle_components bc
         LEFT JOIN ready_stock_total rs2 ON rs2.product_id = bc.member_product_id
         WHERE bc.bundle_product_id = p.id)
      ELSE NULL END AS bundles_available
    FROM products p
    LEFT JOIN ready_stock_total rs ON rs.product_id=p.id
    WHERE p.active=1 ORDER BY p.name
  `).all();
  res.render('salesOrders/form', { title: 'New Sales Order', dealers, products, preselect: req.query.dealer_id });
});

router.post('/', (req, res) => {
  const { dealer_id, order_date, notes } = req.body;
  const discount_amount = Math.max(0, parseFloat(req.body.discount_amount || 0));
  const items = parseItems(req.body);
  if (items.length === 0) { flash(req,'danger','Add at least one item'); return res.redirect('/sales-orders/new'); }
  const seen = new Set();
  for (const it of items) { if (seen.has(it.product_id)) { flash(req,'danger','Same product cannot be added in multiple rows'); return res.redirect('/sales-orders/new'); } seen.add(it.product_id); }
  const order_no = nextCode('sales_orders','order_no','SO');
  const totals = computeTotals(items, discount_amount);
  const sp = db.prepare('SELECT salesperson_id FROM dealers WHERE id=?').get(dealer_id);
  const trx = db.transaction(() => {
    const r = db.prepare(`INSERT INTO sales_orders (order_no,dealer_id,salesperson_id,order_date,subtotal,discount_amount,gst_amount,total,notes,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(order_no, dealer_id, sp ? sp.salesperson_id : null, order_date, totals.subtotal, totals.discount, totals.gst, totals.total, notes||null, req.session.user.id);
    const ins = db.prepare(`INSERT INTO sales_order_items (sales_order_id,product_id,quantity,rate,gst_rate,amount) VALUES (?,?,?,?,?,?)`);
    items.forEach(i => ins.run(r.lastInsertRowid, i.product_id, i.quantity, i.rate, i.gst_rate, i.amount));
    return r.lastInsertRowid;
  });
  const id = trx();
  req.audit('create', 'sales_order', id, `${order_no} · dealer #${dealer_id} · ₹${totals.total}${totals.discount?' (disc ₹'+totals.discount+')':''}`);
  flash(req,'success','Order ' + order_no + ' created.');
  res.redirect('/sales-orders/' + id);
});

router.get('/:id', (req, res) => {
  const o = db.prepare(`SELECT so.*, d.name AS dealer_name, d.gstin AS dealer_gstin, d.address AS dealer_address, d.city AS dealer_city, u.name AS sp_name FROM sales_orders so JOIN dealers d ON d.id=so.dealer_id LEFT JOIN users u ON u.id=so.salesperson_id WHERE so.id=?`).get(req.params.id);
  if (!o) return res.redirect('/sales-orders');
  const items = db.prepare(`SELECT i.*, p.code, p.name FROM sales_order_items i JOIN products p ON p.id=i.product_id WHERE i.sales_order_id=?`).all(req.params.id);
  // Live credit standing for the would-be invoice (until it's actually billed).
  let cs = null;
  if (o.status !== 'invoiced' && o.status !== 'cancelled' && items.length) {
    cs = require('../utils/credit').creditState(o.dealer_id, soInvoiceAmounts(o, items).total);
  }
  const approver = o.approval_by ? db.prepare('SELECT id, name FROM users WHERE id=?').get(o.approval_by) : null;
  const requester = o.requested_by ? db.prepare('SELECT id, name FROM users WHERE id=?').get(o.requested_by) : null;
  const canApprove = o.approval_status === 'pending' && (o.approval_by === req.session.user.id || ['owner', 'admin'].includes(req.session.user.role));
  res.render('salesOrders/show', { title: 'Sales Order ' + o.order_no, o, items, cs, approver, requester, canApprove });
});

// Printable proforma — same letterhead/look as the tax invoice so the dealer
// can be handed a clean order copy and pay against it before dispatch.
router.get('/:id/print', (req, res) => {
  const o = db.prepare(`SELECT so.*, d.name AS dealer_name, d.gstin AS dealer_gstin, d.address AS dealer_address,
      d.city AS dealer_city, d.state AS dealer_state, d.pincode AS dealer_pincode, d.phone AS dealer_phone,
      u.name AS sp_name
    FROM sales_orders so JOIN dealers d ON d.id=so.dealer_id LEFT JOIN users u ON u.id=so.salesperson_id WHERE so.id=?`).get(req.params.id);
  if (!o) return res.redirect('/sales-orders');
  const items = db.prepare(`SELECT i.*, p.code, p.name, p.hsn_code, p.is_bundle_sku FROM sales_order_items i JOIN products p ON p.id=i.product_id WHERE i.sales_order_id=?`).all(req.params.id);
  res.render('salesOrders/print', { title: o.order_no, o, items, layout: false });
});

router.get('/:id/edit', (req, res) => {
  const order = db.prepare('SELECT * FROM sales_orders WHERE id=?').get(req.params.id);
  if (!order) return res.redirect('/sales-orders');
  if (order.status !== 'pending') { flash(req,'danger','Only pending orders can be edited'); return res.redirect('/sales-orders/' + order.id); }
  const dealers = require('../middleware/scope').scopedDealers(req);
  const products = db.prepare(`
    SELECT p.*, COALESCE(rs.quantity,0) AS stock_qty,
      COALESCE((SELECT SUM(qty) FROM product_bundle_components WHERE bundle_product_id=p.id),0) AS pcs_per_bundle,
      CASE WHEN p.is_bundle_sku = 1 THEN
        (SELECT MIN(CAST(COALESCE(rs2.quantity,0) AS REAL) / NULLIF(bc.qty, 0))
         FROM product_bundle_components bc
         LEFT JOIN ready_stock_total rs2 ON rs2.product_id = bc.member_product_id
         WHERE bc.bundle_product_id = p.id)
      ELSE NULL END AS bundles_available
    FROM products p LEFT JOIN ready_stock_total rs ON rs.product_id=p.id
    WHERE p.active=1 ORDER BY p.name
  `).all();
  const items = db.prepare('SELECT * FROM sales_order_items WHERE sales_order_id=?').all(req.params.id);
  res.render('salesOrders/form', { title: 'Edit Sales Order ' + order.order_no, dealers, products, preselect: null, order, items });
});

router.post('/:id', (req, res) => {
  const order = db.prepare('SELECT * FROM sales_orders WHERE id=?').get(req.params.id);
  if (!order) return res.redirect('/sales-orders');
  if (order.status !== 'pending') { flash(req,'danger','Only pending orders can be edited'); return res.redirect('/sales-orders/' + order.id); }
  const { dealer_id, order_date, notes } = req.body;
  const discount_amount = Math.max(0, parseFloat(req.body.discount_amount || 0));
  const items = parseItems(req.body);
  if (items.length === 0) { flash(req,'danger','Add at least one item'); return res.redirect('/sales-orders/' + order.id + '/edit'); }
  const seen = new Set();
  for (const it of items) { if (seen.has(it.product_id)) { flash(req,'danger','Same product cannot be added in multiple rows'); return res.redirect('/sales-orders/' + order.id + '/edit'); } seen.add(it.product_id); }
  const totals = computeTotals(items, discount_amount);
  const sp = db.prepare('SELECT salesperson_id FROM dealers WHERE id=?').get(dealer_id);
  const trx = db.transaction(() => {
    db.prepare(`UPDATE sales_orders SET dealer_id=?, salesperson_id=?, order_date=?, subtotal=?, discount_amount=?, gst_amount=?, total=?, notes=? WHERE id=?`)
      .run(dealer_id, sp ? sp.salesperson_id : null, order_date, totals.subtotal, totals.discount, totals.gst, totals.total, notes||null, order.id);
    db.prepare('DELETE FROM sales_order_items WHERE sales_order_id=?').run(order.id);
    const ins = db.prepare(`INSERT INTO sales_order_items (sales_order_id,product_id,quantity,rate,gst_rate,amount) VALUES (?,?,?,?,?,?)`);
    items.forEach(i => ins.run(order.id, i.product_id, i.quantity, i.rate, i.gst_rate, i.amount));
  });
  trx();
  req.audit('update', 'sales_order', order.id, `${order.order_no} · dealer #${dealer_id} · ₹${totals.total}${totals.discount?' (disc ₹'+totals.discount+')':''}`);
  flash(req,'success','Order ' + order.order_no + ' updated.');
  res.redirect('/sales-orders/' + order.id);
});

router.post('/:id/confirm', (req, res) => {
  db.prepare("UPDATE sales_orders SET status='confirmed' WHERE id=? AND status='pending'").run(req.params.id);
  req.audit('confirm', 'sales_order', req.params.id);
  flash(req,'success','Confirmed.'); res.redirect('/sales-orders/' + req.params.id);
});

router.post('/:id/cancel', (req, res) => {
  db.prepare("UPDATE sales_orders SET status='cancelled' WHERE id=?").run(req.params.id);
  req.audit('cancel', 'sales_order', req.params.id);
  flash(req,'success','Cancelled.'); res.redirect('/sales-orders/' + req.params.id);
});

// Compute an SO's invoice money (subtotal/discount/gst/total) — shared so the
// preview on the page and the actual generation always agree.
function soInvoiceAmounts(o, items) {
  const dealer = db.prepare('SELECT state FROM dealers WHERE id=?').get(o.dealer_id);
  const companyState = (process.env.COMPANY_STATE || '').toLowerCase();
  const isInterState = companyState && dealer && dealer.state && dealer.state.toLowerCase() !== companyState;
  let subtotal = 0; items.forEach(i => { subtotal += i.amount; });
  const discount = Math.min(o.discount_amount || 0, subtotal);
  const factor = subtotal > 0 ? (subtotal - discount) / subtotal : 1;
  let gst = 0; items.forEach(i => { gst += (i.amount * factor) * i.gst_rate / 100; });
  let cgst = 0, sgst = 0, igst = 0;
  if (isInterState) igst = gst; else { cgst = gst / 2; sgst = gst / 2; }
  return { subtotal, discount, cgst, sgst, igst, total: subtotal - discount + gst };
}

// Actually generate the invoice from an SO (no credit checks here — callers
// gate first). Returns { newId, invoice_no }.
function generateInvoiceFromSO(o, userId) {
  const items = db.prepare('SELECT * FROM sales_order_items WHERE sales_order_id=?').all(o.id);
  const a = soInvoiceAmounts(o, items);
  const invoice_no = nextCode('invoices', 'invoice_no', 'INV');
  const newId = db.transaction(() => {
    const r = db.prepare(`INSERT INTO invoices (invoice_no,sales_order_id,dealer_id,salesperson_id,invoice_date,subtotal,discount_amount,cgst,sgst,igst,total,created_by) VALUES (?,?,?,?,date('now'),?,?,?,?,?,?,?)`)
      .run(invoice_no, o.id, o.dealer_id, o.salesperson_id, a.subtotal, a.discount, a.cgst, a.sgst, a.igst, a.total, userId);
    const ins = db.prepare(`INSERT INTO invoice_items (invoice_id,product_id,quantity,rate,gst_rate,amount) VALUES (?,?,?,?,?,?)`);
    items.forEach(i => { ins.run(r.lastInsertRowid, i.product_id, i.quantity, i.rate, i.gst_rate, i.amount); decrementStock(i, r.lastInsertRowid, userId); });
    db.prepare("UPDATE sales_orders SET status='invoiced' WHERE id=?").run(o.id);
    return r.lastInsertRowid;
  })();
  return { newId, invoice_no, total: a.total, discount: a.discount };
}

// Who approves an over-limit invoice for this user: their reporting manager
// (users.reports_to); if none, fall back to the owner / an admin.
function resolveApprover(userId) {
  const me = db.prepare('SELECT reports_to FROM users WHERE id=?').get(userId);
  if (me && me.reports_to) {
    const m = db.prepare('SELECT id, name, role FROM users WHERE id=? AND active=1').get(me.reports_to);
    if (m) return m;
  }
  return db.prepare("SELECT id, name, role FROM users WHERE active=1 AND role IN ('owner','admin') ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, id LIMIT 1").get() || null;
}

router.post('/:id/invoice', (req, res) => {
  const o = db.prepare('SELECT * FROM sales_orders WHERE id=?').get(req.params.id);
  if (!o || o.status === 'cancelled' || o.status === 'invoiced') { flash(req, 'danger', 'Cannot invoice this order.'); return res.redirect('/sales-orders/' + req.params.id); }
  const items = db.prepare('SELECT * FROM sales_order_items WHERE sales_order_id=?').all(o.id);
  if (!items.length) { flash(req, 'danger', 'Order has no items.'); return res.redirect('/sales-orders/' + o.id); }
  const { total } = soInvoiceAmounts(o, items);

  const { creditState } = require('../utils/credit');
  const cs = creditState(o.dealer_id, total);
  const isSalesperson = req.session.user.role === 'salesperson';

  // Rule: No credit limit → no invoice (anyone).
  if (cs.kind === 'no_limit') {
    flash(req, 'danger', cs.message + ' (Set it in the dealer page or Credit Score module.)');
    return res.redirect('/sales-orders/' + o.id);
  }
  // Rule: over the limit + salesperson + not already approved → send to the
  // reporting manager for approval instead of billing.
  if (cs.kind === 'exceeded' && isSalesperson && !o.credit_approved) {
    const approver = resolveApprover(req.session.user.id);
    db.prepare("UPDATE sales_orders SET approval_status='pending', approval_by=?, requested_by=?, approval_at=NULL, approval_note=NULL WHERE id=?")
      .run(approver ? approver.id : null, req.session.user.id, o.id);
    req.audit('credit_approval_request', 'sales_order', o.id, `over limit by ${require('../utils/credit').inr(cs.over)} → approval requested${approver ? ' from ' + approver.name : ''}`);
    flash(req, 'warning', `This dealer is over their credit limit (${cs.message}) Sent to ${approver ? approver.name : 'a manager'} for approval — the invoice will generate once approved.`);
    return res.redirect('/sales-orders/' + o.id);
  }
  // Otherwise OK to bill: within limit, already approved, or an over-limit
  // bill raised by owner/admin/accountant (management override, audited).
  const g = generateInvoiceFromSO(o, req.session.user.id);
  const over = cs.kind === 'exceeded' ? ` [OVER LIMIT by ${require('../utils/credit').inr(cs.over)}${o.credit_approved ? ', approved' : ', ' + req.session.user.role + ' override'}]` : '';
  req.audit('invoice', 'sales_order', o.id, `Generated invoice ${g.invoice_no} (₹${g.total}${g.discount ? ', disc ₹' + g.discount.toFixed(2) : ''})${over}`);
  flash(req, 'success', 'Invoice ' + g.invoice_no + ' generated.');
  maybeAutoSendInvoiceSMS(g.newId);
  res.redirect('/invoices/' + g.newId);
});

// Reporting manager approves an over-limit SO → invoice generates now.
router.post('/:id/approve', (req, res) => {
  const o = db.prepare('SELECT * FROM sales_orders WHERE id=?').get(req.params.id);
  if (!o || o.approval_status !== 'pending') { flash(req, 'danger', 'Nothing pending to approve.'); return res.redirect('/sales-orders/' + req.params.id); }
  const u = req.session.user;
  if (!(o.approval_by === u.id || u.role === 'owner' || u.role === 'admin')) { flash(req, 'danger', 'Only the reporting manager (or owner/admin) can approve this.'); return res.redirect('/sales-orders/' + o.id); }
  db.prepare("UPDATE sales_orders SET approval_status='approved', credit_approved=1, approval_by=?, approval_at=datetime('now'), approval_note=? WHERE id=?")
    .run(u.id, (req.body.note || '').trim() || null, o.id);
  const fresh = db.prepare('SELECT * FROM sales_orders WHERE id=?').get(o.id);
  const g = generateInvoiceFromSO(fresh, fresh.requested_by || u.id);
  req.audit('credit_approval_approve', 'sales_order', o.id, `approved over-limit billing → invoice ${g.invoice_no} (₹${g.total})`);
  flash(req, 'success', `Approved — invoice ${g.invoice_no} generated.`);
  maybeAutoSendInvoiceSMS(g.newId);
  res.redirect('/invoices/' + g.newId);
});

// Reporting manager rejects — no invoice; salesperson can revise & retry.
router.post('/:id/reject', (req, res) => {
  const o = db.prepare('SELECT * FROM sales_orders WHERE id=?').get(req.params.id);
  if (!o || o.approval_status !== 'pending') { flash(req, 'danger', 'Nothing pending to reject.'); return res.redirect('/sales-orders/' + req.params.id); }
  const u = req.session.user;
  if (!(o.approval_by === u.id || u.role === 'owner' || u.role === 'admin')) { flash(req, 'danger', 'Only the reporting manager (or owner/admin) can reject this.'); return res.redirect('/sales-orders/' + o.id); }
  db.prepare("UPDATE sales_orders SET approval_status='rejected', credit_approved=0, approval_by=?, approval_at=datetime('now'), approval_note=? WHERE id=?")
    .run(u.id, (req.body.note || '').trim() || null, o.id);
  req.audit('credit_approval_reject', 'sales_order', o.id, `rejected over-limit billing${req.body.note ? ': ' + req.body.note : ''}`);
  flash(req, 'info', 'Rejected — no invoice generated. The salesperson can clear outstanding or revise and ask again.');
  res.redirect('/sales-orders/' + o.id);
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
    // For bundle SKUs: pieces_per_bundle × bundles ordered × per-piece price
    const bundleInfo = db.prepare('SELECT is_bundle_sku FROM products WHERE id=?').get(pid);
    let totalPieces = q, amount;
    if (bundleInfo && bundleInfo.is_bundle_sku) {
      const ppb = db.prepare('SELECT COALESCE(SUM(qty),0) AS n FROM product_bundle_components WHERE bundle_product_id=?').get(pid).n;
      totalPieces = q * ppb;       // q is bundles ordered, totalPieces = pieces total
      amount = totalPieces * r;    // r is per-piece rate
    } else {
      amount = q * r;
    }
    out.push({ product_id: pid, quantity: q, rate: r, gst_rate: g, amount, is_bundle: !!(bundleInfo && bundleInfo.is_bundle_sku) });
  }
  return out;
}

function computeTotals(items, discountAmount = 0) {
  let subtotal = 0;
  items.forEach(i => { subtotal += i.amount; });
  const discount = Math.min(Math.max(0, discountAmount || 0), subtotal);
  const factor = subtotal > 0 ? (subtotal - discount) / subtotal : 1;
  let gst = 0;
  items.forEach(i => { gst += (i.amount * factor) * i.gst_rate / 100; });
  return { subtotal, discount, gst, total: subtotal - discount + gst };
}

// Decrement ready_stock for one invoice line item AND mark individual pieces as sold (FIFO).
// For bundle SKUs, decrement each component.
// Phase 4: locationId argument tells us WHICH warehouse to debit. Falls
// back to the default (head factory) for backwards compat.
function decrementStock(item, invoiceId, userId, locationId) {
  const locId = locationId || stock.defaultLocationId();
  const markSold = (productId, qty) => {
    const ids = db.prepare(`SELECT id FROM inventory_pieces WHERE product_id=? AND status='in_stock' ORDER BY id LIMIT ?`).all(productId, qty);
    const upd = db.prepare(`UPDATE inventory_pieces SET status='sold', invoice_id=?, sold_at=datetime('now') WHERE id=?`);
    ids.forEach(p => upd.run(invoiceId, p.id));
  };
  const product = db.prepare('SELECT is_bundle_sku FROM products WHERE id=?').get(item.product_id);
  if (product && product.is_bundle_sku) {
    const components = db.prepare('SELECT member_product_id, qty FROM product_bundle_components WHERE bundle_product_id=?').all(item.product_id);
    components.forEach(c => {
      const totalToRemove = c.qty * item.quantity;
      stock.removeQty(c.member_product_id, totalToRemove, locId);
      db.prepare(`INSERT INTO stock_movements (product_id,movement_type,quantity,ref_table,ref_id,notes,from_location_id,created_by) VALUES (?,?,?,?,?,?,?,?)`)
        .run(c.member_product_id, 'sale_out', totalToRemove, 'invoices', invoiceId, 'via bundle SKU #' + item.product_id, locId, userId);
      markSold(c.member_product_id, totalToRemove);
    });
  } else {
    stock.removeQty(item.product_id, item.quantity, locId);
    db.prepare(`INSERT INTO stock_movements (product_id,movement_type,quantity,ref_table,ref_id,from_location_id,created_by) VALUES (?,?,?,?,?,?,?)`)
      .run(item.product_id, 'sale_out', item.quantity, 'invoices', invoiceId, locId, userId);
    markSold(item.product_id, item.quantity);
  }
}

// Reverse decrementStock for a single invoice line. Used when an invoice
// is cancelled / revised, to free the units back into ready_stock and put
// the inventory_pieces that were sold against this invoice back to in_stock.
function restoreStock(item, invoiceId, userId, locationId) {
  const locId = locationId || stock.defaultLocationId();
  const markUnsold = (productId, qty) => {
    const ids = db.prepare(`SELECT id FROM inventory_pieces WHERE product_id=? AND status='sold' AND invoice_id=? ORDER BY id LIMIT ?`).all(productId, invoiceId, qty);
    const upd = db.prepare(`UPDATE inventory_pieces SET status='in_stock', invoice_id=NULL, sold_at=NULL WHERE id=?`);
    ids.forEach(p => upd.run(p.id));
  };
  const product = db.prepare('SELECT is_bundle_sku FROM products WHERE id=?').get(item.product_id);
  if (product && product.is_bundle_sku) {
    const components = db.prepare('SELECT member_product_id, qty FROM product_bundle_components WHERE bundle_product_id=?').all(item.product_id);
    components.forEach(c => {
      const total = c.qty * item.quantity;
      stock.addQty(c.member_product_id, total, locId);
      db.prepare(`INSERT INTO stock_movements (product_id,movement_type,quantity,ref_table,ref_id,notes,to_location_id,created_by) VALUES (?,?,?,?,?,?,?,?)`)
        .run(c.member_product_id, 'return_in', total, 'invoices', invoiceId, 'cancel/revise of bundle SKU #' + item.product_id, locId, userId);
      markUnsold(c.member_product_id, total);
    });
  } else {
    stock.addQty(item.product_id, item.quantity, locId);
    db.prepare(`INSERT INTO stock_movements (product_id,movement_type,quantity,ref_table,ref_id,notes,to_location_id,created_by) VALUES (?,?,?,?,?,?,?,?)`)
      .run(item.product_id, 'return_in', item.quantity, 'invoices', invoiceId, 'cancel/revise', locId, userId);
    markUnsold(item.product_id, item.quantity);
  }
}

module.exports = router;
module.exports.decrementStock = decrementStock;
module.exports.restoreStock = restoreStock;
module.exports.parseItems = parseItems;
