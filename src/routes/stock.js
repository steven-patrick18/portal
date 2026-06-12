const express = require('express');
const multer = require('multer');
const { parse: parseCsv } = require('csv-parse/sync');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { toCsv, sendCsv } = require('../utils/csv');
const stock = require('../utils/stock');
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

// ─── Bundle stock helpers ───────────────────────────────────
// A bundle SKU's available count = MIN(floor(component_stock / qty_per_bundle))
// across its components. This is the single source of truth — wherever the
// bundle's ready_stock cache might be stale, we recompute and persist it
// here. Returns the new value (or null if the bundle has no components).
function computeBundleStock(bundleId) {
  // Bundle stock = MIN(component pieces / pieces-per-bundle) across all
  // components. Components' available pieces are SUMmed across locations
  // (a piece anywhere counts toward the bundle's total avail).
  const comps = db.prepare(`
    SELECT bc.qty AS per_bundle, COALESCE(rs.quantity, 0) AS in_stock
    FROM product_bundle_components bc
    LEFT JOIN ready_stock_total rs ON rs.product_id = bc.member_product_id
    WHERE bc.bundle_product_id = ?
  `).all(bundleId);
  if (comps.length === 0) return null;
  return Math.min(...comps.map(c => Math.floor(c.in_stock / Math.max(c.per_bundle, 1))));
}

// Sync the stored ready_stock for ALL active bundles to their computed value.
// Called from /stock GET so the display is always self-healing. Each change
// is audited with a 'bundle_recompute' movement so the trail explains why
// stock changed without a sale/adjust.
function syncAllBundleStocks(userId) {
  const bundles = db.prepare(`SELECT id, code FROM products WHERE is_bundle_sku=1 AND active=1`).all();
  let updated = 0;
  for (const b of bundles) {
    const computed = computeBundleStock(b.id);
    if (computed === null) continue;
    const existing = stock.totalQty(b.id);
    if (computed !== existing) {
      stock.setQty(b.id, computed);  // Phase 4: bundle stock lives at default location
      db.prepare(`INSERT INTO stock_movements (product_id, movement_type, quantity, notes, created_by) VALUES (?, 'adjustment', ?, ?, ?)`)
        .run(b.id, computed, `[bundle auto-recompute] components changed: ${existing} → ${computed}`, userId || null);
      updated++;
    }
  }
  return updated;
}

// Recompute every bundle that has the given product as a component.
// Used after a manual /stock/adjust on a single variant.
function syncBundlesForComponent(componentId, userId) {
  const bundles = db.prepare(`
    SELECT DISTINCT p.id, p.code
    FROM product_bundle_components bc
    JOIN products p ON p.id = bc.bundle_product_id
    WHERE bc.member_product_id = ? AND p.is_bundle_sku=1 AND p.active=1
  `).all(componentId);
  let updated = 0;
  for (const b of bundles) {
    const computed = computeBundleStock(b.id);
    if (computed === null) continue;
    const existing = stock.totalQty(b.id);
    if (computed !== existing) {
      stock.setQty(b.id, computed);
      db.prepare(`INSERT INTO stock_movements (product_id, movement_type, quantity, notes, created_by) VALUES (?, 'adjustment', ?, ?, ?)`)
        .run(b.id, computed, `[bundle auto-recompute] component changed: ${existing} → ${computed}`, userId || null);
      updated++;
    }
  }
  return updated;
}

router.get('/', (req, res) => {
  // Self-heal: every page load recomputes every active bundle's stock from
  // its components. So even if a sale, dispatch, return, or manual adjust
  // mutated component stock elsewhere without our knowing, the bundles on
  // this list are guaranteed accurate by the time they render.
  try { syncAllBundleStocks(req.session.user?.id); } catch (_) {}

  // Phase 4: pull every active location so we can render a column per
  // location alongside the existing "total across all locations" column.
  const locations = db.prepare("SELECT id, code, name, type FROM locations WHERE active=1 ORDER BY CASE type WHEN 'factory' THEN 1 WHEN 'office' THEN 2 ELSE 3 END, name").all();

  const items = db.prepare(`
    SELECT p.id, p.code, p.name, p.size, p.color, p.unit, p.reorder_level,
           p.is_bundle_sku,
           COALESCE(rs.quantity, 0) AS quantity,
           p.sale_price, p.cost_price,
           CASE WHEN p.is_bundle_sku = 1
                THEN COALESCE((SELECT SUM(qty) FROM product_bundle_components WHERE bundle_product_id = p.id), 1)
                ELSE 1 END AS pieces_per_bundle
    FROM products p LEFT JOIN ready_stock_total rs ON rs.product_id = p.id
    WHERE p.active = 1
    ORDER BY p.is_bundle_sku DESC, p.name
  `).all();

  // For each product, fetch per-location quantities. We do this as a single
  // pivot query that maps product_id -> { location_id: quantity } so the
  // view can read `i.byLocation[loc.id]` cheaply.
  if (locations.length > 1 && items.length) {
    const perLocRows = db.prepare(`
      SELECT product_id, location_id, quantity FROM ready_stock
      WHERE product_id IN (${items.map(() => '?').join(',')})
    `).all(...items.map(i => i.id));
    const pivot = {};
    perLocRows.forEach(r => {
      if (!pivot[r.product_id]) pivot[r.product_id] = {};
      pivot[r.product_id][r.location_id] = r.quantity;
    });
    items.forEach(i => { i.byLocation = pivot[i.id] || {}; });
  }
  // Per-row value for bundles = bundles × pieces_per_bundle × cost (user's formula).
  // For regular SKUs it stays qty × cost.
  items.forEach(i => {
    i.total_pieces = i.is_bundle_sku ? i.quantity * i.pieces_per_bundle : i.quantity;
    i.value = i.total_pieces * (i.cost_price || 0);
  });
  // Counts BEFORE filtering (always show the full picture in the chips).
  const counts = {
    total: items.length,
    available: items.filter(i => i.quantity > 0).length,
    out:       items.filter(i => i.quantity <= 0).length,
  };
  // Apply stock filter for display.
  const stockFilter = req.query.stock || '';
  let visibleItems = items;
  if (stockFilter === 'available') visibleItems = items.filter(i => i.quantity > 0);
  else if (stockFilter === 'out')  visibleItems = items.filter(i => i.quantity <= 0);
  // Totals EXCLUDE bundles — a bundle is just a virtual aggregator of its
  // variants, so including both would double-count the same physical stock.
  const totalValue = items.filter(i => !i.is_bundle_sku).reduce((s, i) => s + i.value, 0);
  const totalQty   = items.filter(i => !i.is_bundle_sku).reduce((s, i) => s + i.quantity, 0);
  res.render('stock/index', { title: 'Ready Stock', items: visibleItems, totalValue, totalQty, counts, stockFilter, locations });
});

// Drilldown: product → batches that produced it
router.get('/product/:id', (req, res) => {
  const p = db.prepare('SELECT id, code, name, size, color, unit, sale_price, cost_price, reorder_level FROM products WHERE id=?').get(req.params.id);
  if (!p) return res.redirect('/stock');
  const stockQty = { v: stock.totalQty(req.params.id) };  // Phase 4: total across all locations
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
    FROM products p LEFT JOIN ready_stock_total rs ON rs.product_id = p.id
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
  let bundlesAuto = 0, bundlesSkipped = 0;
  const errors = [];

  const findProduct = db.prepare('SELECT id, code, is_bundle_sku FROM products WHERE code = ? AND active = 1');
  // Phase 4: read total across all locations, write to default location.
  const currentQty = { get: (id) => ({ q: stock.totalQty(id) }) };
  const upsertQty = { run: (id, qty) => stock.setQty(id, qty) };
  const logMove = db.prepare(`INSERT INTO stock_movements (product_id, movement_type, quantity, notes, created_by)
                              VALUES (?, 'adjustment', ?, ?, ?)`);

  // Recompute a bundle SKU's available stock = MIN(floor(component_stock / qty_per_bundle))
  // across all its component products. Returns null if the bundle has no components.
  const bundleComponents = db.prepare(`
    SELECT bc.qty AS per_bundle, COALESCE(rs.quantity, 0) AS in_stock
    FROM product_bundle_components bc
    LEFT JOIN ready_stock_total rs ON rs.product_id = bc.member_product_id
    WHERE bc.bundle_product_id = ?
  `);
  function computeBundleStock(bundleId) {
    const comps = bundleComponents.all(bundleId);
    if (comps.length === 0) return null;
    return Math.min(...comps.map(c => Math.floor(c.in_stock / Math.max(c.per_bundle, 1))));
  }

  const trx = db.transaction(() => {
    rows.forEach((r, idx) => {
      try {
        const code = (r.code || '').trim();
        if (!code) throw new Error('code is required');
        const p = findProduct.get(code);
        if (!p) { missing++; errors.push(`Row ${idx + 2}: code "${code}" not found / inactive`); return; }

        // Bundle SKU: quantity is auto-derived from components after the import,
        // so we ignore whatever the CSV says (blank or filled). Treat as a hint
        // row only.
        if (p.is_bundle_sku) { bundlesSkipped++; return; }

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

    // ── Auto-recompute bundle quantities after variant pieces are set ──
    const bundles = db.prepare("SELECT id, code FROM products WHERE is_bundle_sku = 1 AND active = 1").all();
    for (const b of bundles) {
      const computed = computeBundleStock(b.id);
      if (computed === null) continue; // no components defined → skip
      const existing = currentQty.get(b.id)?.q ?? 0;
      if (computed !== existing) {
        upsertQty.run(b.id, computed);
        logMove.run(b.id, computed, `[CSV import] bundle auto-computed from components: ${existing} → ${computed}`, req.session.user.id);
        bundlesAuto++;
      }
    }
  });
  try { trx(); }
  catch (e) { flash(req, 'danger', 'Import aborted: ' + e.message); return res.redirect('/stock/import'); }

  req.audit('csv_import', 'stock', null, `${adjusted} adjusted, ${unchanged} unchanged, ${bundlesAuto} bundles auto, ${bundlesSkipped} bundle rows skipped, ${missing} not found, ${failed} failed`);
  const level = failed === 0 && missing === 0 ? 'success' : 'warning';
  let msg = `Stock import done — ${adjusted} piece-SKU adjusted, ${unchanged} unchanged`;
  if (bundlesAuto)    msg += `, ${bundlesAuto} bundle${bundlesAuto===1?'':'s'} auto-recomputed`;
  if (bundlesSkipped) msg += ` (${bundlesSkipped} bundle row${bundlesSkipped===1?'':'s'} in CSV ignored — bundles derive from components)`;
  if (missing) msg += `, ${missing} not found`;
  if (failed)  msg += `, ${failed} failed: ${errors.slice(0, 3).join('; ')}`;
  flash(req, level, msg);
  res.redirect('/stock');
});

router.post('/adjust', (req, res) => {
  const { product_id, quantity, notes } = req.body;
  const qty = parseInt(quantity);
  const pid = parseInt(product_id);
  stock.setQty(pid, qty);  // Phase 4: defaults to head location
  db.prepare(`INSERT INTO stock_movements (product_id, movement_type, quantity, notes, created_by) VALUES (?,?,?,?,?)`)
    .run(pid, 'adjustment', qty, notes||null, req.session.user.id);
  const p = db.prepare('SELECT code, is_bundle_sku FROM products WHERE id=?').get(pid);
  // If the adjusted product is itself a bundle, the manual value will be
  // overwritten by the next /stock load anyway (bundles are derived). Warn
  // the user.
  if (p?.is_bundle_sku) {
    flash(req,'warning',`${p.code} is a bundle SKU — quantity is derived from its components and will be auto-recomputed on the next load. Adjust the components instead.`);
  } else {
    // Adjusted a variant — recompute any bundles that contain it.
    const bumped = syncBundlesForComponent(pid, req.session.user.id);
    let msg = 'Adjusted.';
    if (bumped) msg += ` ${bumped} bundle${bumped===1?'':'s'} auto-recomputed from the new component stock.`;
    flash(req,'success', msg);
  }
  req.audit('stock_adjust', 'product', pid, `${p?.code} → ${qty} pcs (${notes || '-'})`);
  res.redirect('/stock');
});

// ─── Phase 4: Stock Transfer between locations ─────────────────
// Move qty of one or more products from one location's pool to another.
// Atomically debits the source, credits the destination, and records
// a stock_movements row with from_location_id + to_location_id.
router.get('/transfer', (req, res) => {
  // Only locations that ARE warehouses (is_warehouse=1) can be source /
  // destination — transferring to a pure office row doesn't make sense
  // because nothing fulfils invoices from there.
  const locations = db.prepare("SELECT id, code, name, type, city FROM locations WHERE active=1 AND is_warehouse=1 ORDER BY CASE type WHEN 'factory' THEN 1 WHEN 'office' THEN 2 ELSE 3 END, name").all();
  if (locations.length < 2) {
    flash(req, 'warning', 'You need at least two active locations to transfer stock. Add another at /locations/new.');
    return res.redirect('/locations');
  }
  // Bundle SKUs are included (listed first, like the Sales Order picker)
  // — picking one transfers N pcs of EACH member variant per bundle.
  // Physical stock still lives on the members; the bundle row is just a
  // convenient way to say "send 10 complete bundles".
  const products = db.prepare(`
    SELECT p.id, p.code, p.name, p.size, p.color, p.unit, COALESCE(p.is_bundle_sku,0) AS is_bundle_sku,
      COALESCE((SELECT SUM(qty) FROM product_bundle_components WHERE bundle_product_id=p.id),0) AS pcs_per_bundle
    FROM products p WHERE p.active=1
    ORDER BY COALESCE(p.is_bundle_sku,0) DESC, p.name`).all();
  // Bundle composition map for the client: bundleId → [{m: memberId, q: qtyPerBundle}]
  const bundleComp = {};
  db.prepare('SELECT bundle_product_id, member_product_id, qty FROM product_bundle_components').all()
    .forEach(r => {
      if (!bundleComp[r.bundle_product_id]) bundleComp[r.bundle_product_id] = [];
      bundleComp[r.bundle_product_id].push({ m: r.member_product_id, q: r.qty });
    });
  // For the from-location dropdown, pre-load per-product qty so the UI
  // can show "PRD001 · Cotton Shirt (12 pcs at LOC0001)" once the user
  // picks a source location.
  const perLoc = db.prepare(`SELECT product_id, location_id, quantity FROM ready_stock WHERE quantity > 0`).all();
  const stockByLoc = {};
  perLoc.forEach(r => {
    if (!stockByLoc[r.location_id]) stockByLoc[r.location_id] = {};
    stockByLoc[r.location_id][r.product_id] = r.quantity;
  });
  res.render('stock/transfer', { title: 'Stock Transfer', locations, products, stockByLoc, bundleComp });
});

router.post('/transfer', (req, res) => {
  const fromId = parseInt(req.body.from_location_id);
  const toId   = parseInt(req.body.to_location_id);
  if (!fromId || !toId || fromId === toId) {
    flash(req, 'danger', 'Pick two different locations.');
    return res.redirect('/stock/transfer');
  }
  const productIds = [].concat(req.body.product_id || []);
  const qtys       = [].concat(req.body.quantity || []);
  const notes      = (req.body.notes || '').trim() || null;
  const rawLines = [];
  for (let i = 0; i < productIds.length; i++) {
    const pid = parseInt(productIds[i]); const q = parseInt(qtys[i] || 0);
    if (pid && q > 0) rawLines.push({ product_id: pid, quantity: q });
  }
  if (rawLines.length === 0) {
    flash(req, 'danger', 'Add at least one product with a quantity.');
    return res.redirect('/stock/transfer');
  }

  // Explode bundle SKUs into member-variant lines: qty bundles ×
  // qty_per_bundle of each member. Physical stock moves on members —
  // the bundle row itself never holds stock.
  const lines = [];          // { product_id, quantity, viaBundle? }
  let bundleCount = 0;
  for (const l of rawLines) {
    const p = db.prepare('SELECT id, code, is_bundle_sku FROM products WHERE id=?').get(l.product_id);
    if (!p) continue;
    if (p.is_bundle_sku) {
      const comp = db.prepare('SELECT member_product_id, qty FROM product_bundle_components WHERE bundle_product_id=?').all(p.id);
      if (comp.length === 0) {
        flash(req, 'danger', `${p.code} is a bundle with no members defined — fix its composition on the product page first.`);
        return res.redirect('/stock/transfer');
      }
      comp.forEach(c => lines.push({ product_id: c.member_product_id, quantity: l.quantity * c.qty, viaBundle: p.code + ' × ' + l.quantity }));
      bundleCount += l.quantity;
    } else {
      lines.push({ product_id: l.product_id, quantity: l.quantity });
    }
  }

  // Validate against AGGREGATE demand per product — two lines tapping
  // the same member (e.g. a bundle + a loose-pieces line) must not
  // overdraw the source pool together.
  const demand = new Map();
  lines.forEach(l => demand.set(l.product_id, (demand.get(l.product_id) || 0) + l.quantity));
  const insufficient = [];
  for (const [pid, q] of demand) {
    const avail = stock.qtyAt(pid, fromId);
    if (avail < q) {
      const code = db.prepare('SELECT code FROM products WHERE id=?').get(pid)?.code || ('#' + pid);
      insufficient.push(`${code} (avail ${avail}, asked ${q})`);
    }
  }
  if (insufficient.length) {
    flash(req, 'danger', `Not enough stock at source: ${insufficient.join(', ')}`);
    return res.redirect('/stock/transfer');
  }

  const trx = db.transaction(() => {
    lines.forEach(l => {
      stock.removeQty(l.product_id, l.quantity, fromId);
      stock.addQty(l.product_id, l.quantity, toId);
      const lineNote = l.viaBundle ? `[bundle ${l.viaBundle}]${notes ? ' ' + notes : ''}` : notes;
      db.prepare(`INSERT INTO stock_movements (product_id, movement_type, quantity, ref_table, notes, from_location_id, to_location_id, created_by) VALUES (?,?,?,?,?,?,?,?)`)
        .run(l.product_id, 'transfer', l.quantity, 'transfer', lineNote, fromId, toId, req.session.user.id);
    });
  });
  trx();

  const fromName = db.prepare('SELECT name FROM locations WHERE id=?').get(fromId)?.name;
  const toName   = db.prepare('SELECT name FROM locations WHERE id=?').get(toId)?.name;
  const totalPcs = lines.reduce((s, l) => s + l.quantity, 0);
  const what = `${totalPcs} pcs${bundleCount ? ' (incl. ' + bundleCount + ' bundle' + (bundleCount===1?'':'s') + ')' : ''} across ${demand.size} product${demand.size===1?'':'s'}`;
  req.audit('transfer', 'stock', null, `${what} from ${fromName} → ${toName}${notes ? ' · ' + notes : ''}`);
  flash(req, 'success', `Transferred ${what} from ${fromName} → ${toName}.`);
  res.redirect('/stock');
});

module.exports = router;
