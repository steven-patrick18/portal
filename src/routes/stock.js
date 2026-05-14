const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const router = express.Router();

router.get('/', (req, res) => {
  const items = db.prepare(`
    SELECT p.id, p.code, p.name, p.size, p.color, p.unit, p.reorder_level,
           COALESCE(rs.quantity,0) AS quantity, p.sale_price, p.cost_price
    FROM products p LEFT JOIN ready_stock rs ON rs.product_id = p.id
    WHERE p.active = 1
    ORDER BY p.name
  `).all();
  const totalValue = items.reduce((s,i) => s + (i.quantity * i.cost_price), 0);
  const totalQty = items.reduce((s,i) => s + i.quantity, 0);
  res.render('stock/index', { title: 'Ready Stock', items, totalValue, totalQty });
});

// Drilldown: product → batches that produced it
router.get('/product/:id', (req, res) => {
  const p = db.prepare('SELECT id, code, name, size, color, unit, sale_price, cost_price, reorder_level FROM products WHERE id=?').get(req.params.id);
  if (!p) return res.redirect('/stock');
  const stockQty = db.prepare('SELECT COALESCE(quantity,0) AS v FROM ready_stock WHERE product_id=?').get(req.params.id);
  const summary = db.prepare(`
    SELECT
      SUM(CASE WHEN status='in_stock'   THEN 1 ELSE 0 END) AS in_stock,
      SUM(CASE WHEN status='sold'        THEN 1 ELSE 0 END) AS sold,
      SUM(CASE WHEN status='returned'    THEN 1 ELSE 0 END) AS returned,
      SUM(CASE WHEN status='dispatched'  THEN 1 ELSE 0 END) AS dispatched,
      SUM(CASE WHEN status='scrapped'    THEN 1 ELSE 0 END) AS scrapped,
      COUNT(*) AS total
    FROM inventory_pieces WHERE product_id=?
  `).get(req.params.id);
  // Batches that produced this product (via inventory_pieces.batch_id)
  const batches = db.prepare(`
    SELECT
      ip.batch_id,
      COALESCE(b.batch_no, '— Legacy / no batch —') AS batch_no,
      COALESCE(b.start_date, '') AS start_date,
      COALESCE(b.status, '') AS batch_status,
      COUNT(*) AS total_pieces,
      SUM(CASE WHEN ip.status='in_stock' THEN 1 ELSE 0 END) AS in_stock,
      SUM(CASE WHEN ip.status='sold'      THEN 1 ELSE 0 END) AS sold,
      SUM(CASE WHEN ip.status='returned'  THEN 1 ELSE 0 END) AS returned,
      AVG(ip.cost_per_piece) AS avg_cost
    FROM inventory_pieces ip
    LEFT JOIN production_batches b ON b.id = ip.batch_id
    WHERE ip.product_id = ?
    GROUP BY ip.batch_id
    ORDER BY ip.batch_id DESC
  `).all(req.params.id);
  res.render('stock/product', { title: p.name + ' · Inventory', p, stockQty: stockQty ? stockQty.v : 0, summary, batches });
});

// Drilldown: pieces in a specific batch for a product
router.get('/product/:id/batch/:bid', (req, res) => {
  const p = db.prepare('SELECT id, code, name, size, color, unit FROM products WHERE id=?').get(req.params.id);
  if (!p) return res.redirect('/stock');
  const batchId = req.params.bid === 'null' ? null : parseInt(req.params.bid);
  let batch = null;
  if (batchId) {
    batch = db.prepare('SELECT * FROM production_batches WHERE id=?').get(batchId);
  }
  const status = req.query.status || 'all';
  let sql = `
    SELECT ip.*, i.invoice_no, d.name AS dealer_name
    FROM inventory_pieces ip
    LEFT JOIN invoices i ON i.id = ip.invoice_id
    LEFT JOIN dealers d ON d.id = i.dealer_id
    WHERE ip.product_id = ? AND `;
  const params = [req.params.id];
  if (batchId) { sql += `ip.batch_id = ? `; params.push(batchId); }
  else         { sql += `ip.batch_id IS NULL `; }
  if (status !== 'all') { sql += ` AND ip.status = ?`; params.push(status); }
  sql += ` ORDER BY ip.id`;
  const pieces = db.prepare(sql).all(...params);
  res.render('stock/pieces', { title: p.name + ' · Pieces', p, batch, pieces, status, batchId });
});

router.get('/movements', (req, res) => {
  const items = db.prepare(`
    SELECT sm.*, p.code AS product_code, p.name AS product_name, u.name AS by_name
    FROM stock_movements sm JOIN products p ON p.id=sm.product_id
    LEFT JOIN users u ON u.id=sm.created_by
    ORDER BY sm.id DESC LIMIT 200
  `).all();
  res.render('stock/movements', { title: 'Stock Movements', items });
});

router.post('/adjust', (req, res) => {
  // Setting an absolute quantity = editing opening stock, so owner-only.
  if (req.session.user.role !== 'owner') {
    flash(req,'danger','Only the owner can adjust product stock directly.');
    return res.redirect('/stock');
  }
  const { product_id, quantity, notes } = req.body;
  const qty = parseInt(quantity);
  db.prepare(`INSERT INTO ready_stock (product_id, quantity) VALUES (?,?) ON CONFLICT(product_id) DO UPDATE SET quantity=excluded.quantity, updated_at=datetime('now')`).run(product_id, qty);
  db.prepare(`INSERT INTO stock_movements (product_id, movement_type, quantity, notes, created_by) VALUES (?,?,?,?,?)`)
    .run(product_id, 'adjustment', qty, notes||null, req.session.user.id);
  const p = db.prepare('SELECT code FROM products WHERE id=?').get(product_id)?.code;
  req.audit('stock_adjust', 'product', product_id, `${p} → ${qty} pcs (${notes || '-'})`);
  flash(req,'success','Adjusted.'); res.redirect('/stock');
});

module.exports = router;
