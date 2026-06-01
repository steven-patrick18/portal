const express = require('express');
const multer = require('multer');
const { parse: parseCsv } = require('csv-parse/sync');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { toCsv, sendCsv } = require('../utils/csv');
const router = express.Router();

// `is_bundle` and `pieces_per_bundle` are EXPORT-ONLY columns so the user
// can see whether each row's `quantity` is a count of bundles or of pieces
// when filling in the CSV. They're ignored on import.
const STOCK_CSV_COLUMNS = ['code', 'name', 'size', 'color', 'is_bundle', 'pieces_per_bundle', 'quantity', 'unit_label', 'reorder_level', 'notes'];
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function ownerOnly(req, res, next) {
  if (req.session.user.role !== 'owner') {
    return res.status(403).render('error', { title: 'Forbidden', message: 'Owner access required.', code: 403 });
  }
  next();
}

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

// ─── CSV Export / Import (owner only) ───────────────────────
// Bulk-update product stock. Match by `code`; only the quantity is changed.
// Each modified row gets a stock_movements 'adjustment' entry so the audit
// trail mirrors the per-row Adjust button.
router.get('/export.csv', ownerOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT p.code, p.name, p.size, p.color,
           CASE WHEN p.is_bundle_sku = 1 THEN 'yes' ELSE 'no' END AS is_bundle,
           CASE WHEN p.is_bundle_sku = 1
                THEN COALESCE((SELECT SUM(qty) FROM product_bundle_components WHERE bundle_product_id = p.id), 0)
                ELSE '' END AS pieces_per_bundle,
           COALESCE(rs.quantity, 0) AS quantity,
           CASE WHEN p.is_bundle_sku = 1 THEN 'bundles' ELSE 'pcs' END AS unit_label,
           p.reorder_level,
           '' AS notes
    FROM products p LEFT JOIN ready_stock rs ON rs.product_id = p.id
    WHERE p.active = 1
    ORDER BY p.is_bundle_sku DESC, p.code
  `).all();
  const csv = toCsv(rows, STOCK_CSV_COLUMNS);
  const stamp = new Date().toISOString().slice(0, 10);
  sendCsv(res, `stock_${stamp}.csv`, csv);
});

router.get('/import', ownerOnly, (req, res) => {
  res.render('stock/import', { title: 'Import Stock (CSV)' });
});

router.post('/import', ownerOnly, csvUpload.single('file'), (req, res) => {
  if (!req.file) { flash(req, 'danger', 'No file uploaded'); return res.redirect('/stock/import'); }
  let rows;
  try {
    rows = parseCsv(req.file.buffer.toString('utf-8').replace(/^﻿/, ''), { columns: true, skip_empty_lines: true, trim: true });
  } catch (e) {
    flash(req, 'danger', 'CSV parse failed: ' + e.message);
    return res.redirect('/stock/import');
  }

  let adjusted = 0, unchanged = 0, missing = 0, failed = 0;
  const errors = [];

  const findProduct = db.prepare('SELECT id, code FROM products WHERE code = ? AND active = 1');
  const currentQty = db.prepare('SELECT COALESCE(quantity, 0) AS q FROM ready_stock WHERE product_id = ?');
  const upsertQty = db.prepare(`INSERT INTO ready_stock (product_id, quantity) VALUES (?, ?)
                                ON CONFLICT(product_id) DO UPDATE SET quantity = excluded.quantity, updated_at = datetime('now')`);
  const logMove = db.prepare(`INSERT INTO stock_movements (product_id, movement_type, quantity, notes, created_by)
                              VALUES (?, 'adjustment', ?, ?, ?)`);

  const trx = db.transaction(() => {
    rows.forEach((r, idx) => {
      try {
        const code = (r.code || '').trim();
        if (!code) throw new Error('code is required');
        const p = findProduct.get(code);
        if (!p) { missing++; errors.push(`Row ${idx + 2}: code "${code}" not found / inactive`); return; }
        if (r.quantity === undefined || r.quantity === '' || isNaN(parseInt(r.quantity))) {
          throw new Error('quantity is missing or not a number');
        }
        const qty = parseInt(r.quantity);
        const existing = currentQty.get(p.id)?.q ?? 0;
        if (qty === existing) { unchanged++; return; }
        upsertQty.run(p.id, qty);
        const note = (r.notes || '').trim() || `[CSV import] set ${existing} → ${qty}`;
        logMove.run(p.id, qty, note, req.session.user.id);
        adjusted++;
      } catch (e) {
        failed++;
        errors.push(`Row ${idx + 2}: ${e.message}`);
      }
    });
  });
  try { trx(); }
  catch (e) { flash(req, 'danger', 'Import aborted: ' + e.message); return res.redirect('/stock/import'); }

  req.audit('csv_import', 'stock', null, `${adjusted} adjusted, ${unchanged} unchanged, ${missing} not found, ${failed} failed`);
  const level = failed === 0 && missing === 0 ? 'success' : 'warning';
  let msg = `Stock import done — ${adjusted} adjusted, ${unchanged} unchanged`;
  if (missing) msg += `, ${missing} not found`;
  if (failed)  msg += `, ${failed} failed: ${errors.slice(0, 3).join('; ')}`;
  flash(req, level, msg);
  res.redirect('/stock');
});

router.post('/adjust', (req, res) => {
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
