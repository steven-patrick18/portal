const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { nextCode } = require('../utils/codegen');
const { todayLocal } = require('../utils/format');

const router = express.Router();

// ============================================================
// DASHBOARD
// ============================================================
router.get('/', (req, res) => {
  // Low stock items — materials at or below reorder level
  const lowStock = db.prepare(`
    SELECT rm.id, rm.code, rm.name, rm.unit, rm.current_stock, rm.reorder_level, rm.cost_per_unit,
      (SELECT vp.rate FROM vendor_prices vp WHERE vp.raw_material_id = rm.id ORDER BY vp.effective_from DESC, vp.id DESC LIMIT 1) AS latest_rate,
      (SELECT s.name FROM vendor_prices vp JOIN suppliers s ON s.id = vp.supplier_id WHERE vp.raw_material_id = rm.id ORDER BY vp.effective_from DESC, vp.id DESC LIMIT 1) AS latest_supplier,
      (SELECT MIN(rate) FROM vendor_prices WHERE raw_material_id = rm.id) AS best_rate,
      (SELECT supplier_id FROM vendor_prices WHERE raw_material_id = rm.id ORDER BY rate ASC, effective_from DESC LIMIT 1) AS best_supplier_id
    FROM raw_materials rm
    WHERE rm.active = 1 AND rm.reorder_level > 0 AND rm.current_stock <= rm.reorder_level
    ORDER BY (rm.reorder_level - rm.current_stock) DESC
  `).all();

  // Recent rate changes (last 30 days) — current vs prior rate per supplier+material pair
  const recentChanges = db.prepare(`
    SELECT vp.id, vp.rate AS new_rate, vp.effective_from, rm.code, rm.name, rm.unit,
           s.name AS supplier_name, vp.notes,
           (SELECT vp2.rate FROM vendor_prices vp2
              WHERE vp2.supplier_id = vp.supplier_id
                AND vp2.raw_material_id = vp.raw_material_id
                AND vp2.id < vp.id
              ORDER BY vp2.id DESC LIMIT 1) AS old_rate
    FROM vendor_prices vp
    JOIN raw_materials rm ON rm.id = vp.raw_material_id
    JOIN suppliers s ON s.id = vp.supplier_id
    WHERE vp.created_at >= datetime('now', '-30 day')
    ORDER BY vp.id DESC
    LIMIT 30
  `).all();
  recentChanges.forEach(c => {
    if (c.old_rate !== null) {
      c.delta = c.new_rate - c.old_rate;
      c.delta_pct = c.old_rate > 0 ? (c.delta * 100 / c.old_rate) : 0;
    }
  });

  // Open POs
  const openPOs = db.prepare(`
    SELECT po.*, s.name AS supplier_name,
      (SELECT COUNT(*) FROM purchase_order_items WHERE po_id = po.id) AS items
    FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
    WHERE po.status IN ('draft','sent','partial')
    ORDER BY po.id DESC
    LIMIT 20
  `).all();

  // Spend this month (for KPIs)
  const monthStart = todayLocal().slice(0, 7) + '-01';
  const monthSpend = db.prepare(`SELECT COALESCE(SUM(total),0) AS v FROM purchase_orders WHERE po_date >= ? AND status != 'cancelled'`).get(monthStart).v;
  const monthReceived = db.prepare(`SELECT COALESCE(SUM(total_amount),0) AS v FROM raw_material_txns WHERE txn_type='purchase' AND created_at >= datetime(?, '+0 day')`).get(monthStart).v;

  res.render('purchasing/dashboard', {
    title: 'Purchasing Dashboard',
    lowStock, recentChanges, openPOs, monthSpend, monthReceived,
  });
});

// ============================================================
// PRICE COMPARISON
// ============================================================
router.get('/compare', (req, res) => {
  const q = (req.query.q || '').trim();
  let sql = `
    SELECT rm.id, rm.code, rm.name, rm.unit, rm.current_stock, rm.reorder_level, rm.cost_per_unit,
      (SELECT COUNT(DISTINCT supplier_id) FROM vendor_prices WHERE raw_material_id = rm.id) AS vendor_count,
      (SELECT MIN(rate) FROM vendor_prices WHERE raw_material_id = rm.id) AS best_rate,
      (SELECT MAX(rate) FROM vendor_prices WHERE raw_material_id = rm.id) AS worst_rate,
      (SELECT s.name FROM vendor_prices vp JOIN suppliers s ON s.id = vp.supplier_id WHERE vp.raw_material_id = rm.id ORDER BY vp.rate ASC, vp.effective_from DESC LIMIT 1) AS best_supplier,
      (SELECT vp.rate FROM vendor_prices vp WHERE vp.raw_material_id = rm.id ORDER BY vp.effective_from DESC, vp.id DESC LIMIT 1) AS latest_rate,
      (SELECT vp.effective_from FROM vendor_prices vp WHERE vp.raw_material_id = rm.id ORDER BY vp.effective_from DESC, vp.id DESC LIMIT 1) AS latest_date
    FROM raw_materials rm WHERE rm.active = 1`;
  const params = [];
  if (q) { sql += ' AND (rm.code LIKE ? OR rm.name LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY rm.name';
  const items = db.prepare(sql).all(...params);
  res.render('purchasing/compare', { title: 'Vendor Price Comparison', items, q });
});

router.get('/compare/:materialId', (req, res) => {
  const m = db.prepare('SELECT * FROM raw_materials WHERE id=?').get(req.params.materialId);
  if (!m) return res.redirect('/purchasing/compare');
  // All vendor prices for this material — latest per supplier first
  const vendorPrices = db.prepare(`
    SELECT vp.*, s.name AS supplier_name, s.phone AS supplier_phone, s.contact_person,
      (SELECT MIN(rate) FROM vendor_prices WHERE raw_material_id = vp.raw_material_id) AS overall_best
    FROM vendor_prices vp
    JOIN suppliers s ON s.id = vp.supplier_id
    WHERE vp.raw_material_id = ?
      AND vp.id = (SELECT MAX(id) FROM vendor_prices WHERE supplier_id = vp.supplier_id AND raw_material_id = vp.raw_material_id)
    ORDER BY vp.rate ASC, vp.effective_from DESC
  `).all(req.params.materialId);
  // Full history for trend
  const history = db.prepare(`
    SELECT vp.id, vp.rate, vp.effective_from, vp.notes, s.name AS supplier_name
    FROM vendor_prices vp JOIN suppliers s ON s.id = vp.supplier_id
    WHERE vp.raw_material_id = ?
    ORDER BY vp.id DESC
    LIMIT 100
  `).all(req.params.materialId);
  // Add per-supplier prior-rate delta to history rows
  history.forEach((h, idx) => {
    const prior = history.slice(idx + 1).find(x => x.supplier_name === h.supplier_name);
    if (prior) {
      h.delta = h.rate - prior.rate;
      h.delta_pct = prior.rate > 0 ? (h.delta * 100 / prior.rate) : 0;
    }
  });
  const suppliers = db.prepare('SELECT id, name FROM suppliers WHERE active=1 ORDER BY name').all();
  res.render('purchasing/compareDetail', { title: m.name + ' · Vendor Prices', m, vendorPrices, history, suppliers });
});

router.post('/prices', (req, res) => {
  const { supplier_id, raw_material_id, rate, moq, lead_time_days, effective_from, notes } = req.body;
  db.prepare(`INSERT INTO vendor_prices (supplier_id, raw_material_id, rate, moq, lead_time_days, effective_from, notes, created_by)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(supplier_id, raw_material_id, parseFloat(rate), parseFloat(moq || 0), parseInt(lead_time_days || 0),
         effective_from || todayLocal(), notes || null, req.session.user.id);
  flash(req, 'success', 'Vendor price recorded.');
  res.redirect('/purchasing/compare/' + raw_material_id);
});

// ============================================================
// PURCHASE ORDERS
// ============================================================
router.get('/orders', (req, res) => {
  const status = req.query.status || 'all';
  let sql = `SELECT po.*, s.name AS supplier_name,
    (SELECT COUNT(*) FROM purchase_order_items WHERE po_id = po.id) AS items
    FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id`;
  const params = [];
  if (status !== 'all') { sql += ' WHERE po.status = ?'; params.push(status); }
  sql += ' ORDER BY po.id DESC LIMIT 200';
  const orders = db.prepare(sql).all(...params);
  res.render('purchasing/orders', { title: 'Purchase Orders', orders, status });
});

router.get('/orders/new', (req, res) => {
  const suppliers = db.prepare('SELECT * FROM suppliers WHERE active=1 ORDER BY name').all();
  // Each material with its best vendor & latest rate
  const materials = db.prepare(`
    SELECT rm.*,
      (SELECT MIN(rate) FROM vendor_prices WHERE raw_material_id = rm.id) AS best_rate
    FROM raw_materials rm WHERE rm.active=1 ORDER BY rm.name`).all();
  res.render('purchasing/orderForm', { title: 'New Purchase Order', suppliers, materials, preselectMaterials: req.query.materials || '' });
});

router.post('/orders', (req, res) => {
  const { supplier_id, po_date, expected_delivery, notes } = req.body;
  const items = parseItems(req.body);
  if (items.length === 0) { flash(req, 'danger', 'Add at least one item'); return res.redirect('/purchasing/orders/new'); }
  let subtotal = 0, gst = 0;
  items.forEach(i => { subtotal += i.amount; gst += i.amount * i.gst_rate / 100; });
  const total = subtotal + gst;
  const po_no = nextCode('purchase_orders', 'po_no', 'PO');
  let poId;
  const trx = db.transaction(() => {
    const r = db.prepare(`INSERT INTO purchase_orders (po_no, supplier_id, po_date, expected_delivery, subtotal, gst_amount, total, notes, created_by, status) VALUES (?,?,?,?,?,?,?,?,?,'draft')`)
      .run(po_no, supplier_id, po_date || todayLocal(), expected_delivery || null, subtotal, gst, total, notes || null, req.session.user.id);
    poId = r.lastInsertRowid;
    const ins = db.prepare(`INSERT INTO purchase_order_items (po_id, raw_material_id, quantity, rate, gst_rate, amount) VALUES (?,?,?,?,?,?)`);
    items.forEach(i => {
      ins.run(poId, i.raw_material_id, i.quantity, i.rate, i.gst_rate, i.amount);
      // Auto-record this rate as a vendor_price entry (so the rate history stays in sync)
      db.prepare(`INSERT INTO vendor_prices (supplier_id, raw_material_id, rate, effective_from, notes, created_by) VALUES (?,?,?,?,?,?)`)
        .run(supplier_id, i.raw_material_id, i.rate, po_date || todayLocal(), 'From PO ' + po_no, req.session.user.id);
    });
  });
  trx();
  flash(req, 'success', 'PO ' + po_no + ' created.');
  res.redirect('/purchasing/orders/' + poId);
});

router.get('/orders/:id', (req, res) => {
  const po = db.prepare(`SELECT po.*, s.name AS supplier_name, s.phone AS supplier_phone, s.contact_person, s.email AS supplier_email, s.gstin FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = ?`).get(req.params.id);
  if (!po) return res.redirect('/purchasing/orders');
  const items = db.prepare(`SELECT pi.*, rm.code, rm.name, rm.unit FROM purchase_order_items pi JOIN raw_materials rm ON rm.id = pi.raw_material_id WHERE pi.po_id = ?`).all(req.params.id);
  res.render('purchasing/orderDetail', { title: 'PO ' + po.po_no, po, items });
});

router.post('/orders/:id/send', (req, res) => {
  db.prepare(`UPDATE purchase_orders SET status='sent' WHERE id=? AND status='draft'`).run(req.params.id);
  flash(req, 'success', 'PO marked as sent.');
  res.redirect('/purchasing/orders/' + req.params.id);
});

router.post('/orders/:id/cancel', (req, res) => {
  db.prepare(`UPDATE purchase_orders SET status='cancelled' WHERE id=? AND status IN ('draft','sent')`).run(req.params.id);
  flash(req, 'success', 'PO cancelled.');
  res.redirect('/purchasing/orders/' + req.params.id);
});

router.post('/orders/:id/receive', (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(req.params.id);
  if (!po) return res.redirect('/purchasing/orders');
  if (po.status === 'cancelled' || po.status === 'received') { flash(req, 'danger', 'Cannot receive on this PO.'); return res.redirect('/purchasing/orders/' + req.params.id); }
  const items = db.prepare('SELECT * FROM purchase_order_items WHERE po_id=?').all(req.params.id);
  const recvd = [].concat(req.body.received || []);
  let totalRecvAmt = 0, anyShort = false, allFull = true;
  const trx = db.transaction(() => {
    items.forEach((it, i) => {
      const newRecv = parseFloat(recvd[i] || 0);
      if (newRecv <= 0) { allFull = false; return; }
      const delta = newRecv;
      const cumulative = (it.qty_received || 0) + delta;
      if (cumulative > it.quantity) {
        flash(req, 'warning', 'Received qty exceeds ordered for ' + (db.prepare('SELECT name FROM raw_materials WHERE id=?').get(it.raw_material_id).name));
      }
      const totalAmt = delta * it.rate;
      totalRecvAmt += totalAmt + (totalAmt * (it.gst_rate || 0) / 100);
      // Increment raw material stock + record txn
      db.prepare('UPDATE raw_materials SET current_stock = current_stock + ?, cost_per_unit = ? WHERE id=?').run(delta, it.rate, it.raw_material_id);
      db.prepare(`INSERT INTO raw_material_txns (raw_material_id, txn_type, quantity, rate, total_amount, ref_no, notes, created_by) VALUES (?,?,?,?,?,?,?,?)`)
        .run(it.raw_material_id, 'purchase', delta, it.rate, delta * it.rate, po.po_no, 'Received from PO ' + po.po_no, req.session.user.id);
      // Update PO line item
      db.prepare('UPDATE purchase_order_items SET qty_received = qty_received + ? WHERE id=?').run(delta, it.id);
      if (cumulative < it.quantity) anyShort = true;
    });
    // Determine new PO status
    const updated = db.prepare('SELECT quantity, qty_received FROM purchase_order_items WHERE po_id=?').all(req.params.id);
    const fullyReceived = updated.every(u => u.qty_received >= u.quantity);
    const partial = updated.some(u => u.qty_received > 0 && u.qty_received < u.quantity);
    let newStatus = po.status;
    if (fullyReceived) newStatus = 'received';
    else if (partial || updated.some(u => u.qty_received > 0)) newStatus = 'partial';
    db.prepare('UPDATE purchase_orders SET status=? WHERE id=?').run(newStatus, req.params.id);
  });
  trx();
  flash(req, 'success', 'Received items recorded. Stock updated. Total received value (incl. GST): ₹' + totalRecvAmt.toFixed(2));
  res.redirect('/purchasing/orders/' + req.params.id);
});

function parseItems(body) {
  const out = [];
  const ids = [].concat(body.raw_material_id || []);
  const qtys = [].concat(body.quantity || []);
  const rates = [].concat(body.rate || []);
  const gsts = [].concat(body.gst_rate || []);
  for (let i = 0; i < ids.length; i++) {
    const rid = parseInt(ids[i]); const q = parseFloat(qtys[i] || 0); const r = parseFloat(rates[i] || 0); const g = parseFloat(gsts[i] || 0);
    if (!rid || !q || !r) continue;
    out.push({ raw_material_id: rid, quantity: q, rate: r, gst_rate: g, amount: q * r });
  }
  return out;
}

module.exports = router;
