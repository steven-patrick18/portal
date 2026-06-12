const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { nextCode } = require('../utils/codegen');
const stock = require('../utils/stock');
const router = express.Router();

// Stages are now driven from the production_stages_master table.
// We compute STAGES and STAGE_LABELS per-request to pick up admin changes immediately.
function getStages() {
  const rows = db.prepare('SELECT stage_key, label FROM production_stages_master WHERE active=1 ORDER BY sort_order, id').all();
  if (rows.length === 0) {
    // Fallback if master is empty
    return { keys: ['cutting','stitching','washing','finishing','packing'], labels: { cutting:'Cutting', stitching:'Stitching', washing:'Washing', finishing:'Finishing', packing:'Packing' }, packingKey: 'packing' };
  }
  const labels = {}; rows.forEach(r => labels[r.stage_key] = r.label);
  // The "packing" stage triggers ready-stock auto-add. If a custom packing stage exists, use it.
  // Convention: any stage_key === 'packing' OR the LAST stage in sort order is packing-equivalent.
  let packingKey = rows.find(r => r.stage_key === 'packing')?.stage_key;
  if (!packingKey) packingKey = rows[rows.length - 1].stage_key;
  return { keys: rows.map(r => r.stage_key), labels, packingKey };
}

// Parse bundle size input. Duplicates count as quantity. Also supports `Size:N`, `Size*N`, `Size xN`.
//   "XL, XL, L"        →  { XL: 2, L: 1 }
//   "XL*2, L, M:3"     →  { XL: 2, L: 1, M: 3 }
//   "28, 30, 32, 32"   →  { '28': 1, '30': 1, '32': 2 }
function parseBundleSizes(input) {
  const result = {};
  if (!input) return result;
  input.split(',').map(s => s.trim()).filter(Boolean).forEach(part => {
    const m = part.match(/^(.+?)(?:\s*[*:x×]\s*(\d+))?$/i);
    if (!m) return;
    const size = m[1].trim();
    const qty = parseInt(m[2] || 1);
    if (!size || qty < 1) return;
    // Find existing key case-insensitively to merge "XL" and "xl"
    const existing = Object.keys(result).find(k => k.toLowerCase() === size.toLowerCase());
    if (existing) result[existing] += qty;
    else result[size] = qty;
  });
  return result;
}

router.get('/', (req, res) => {
  const status = req.query.status || 'all';
  let sql = `SELECT b.*, p.name AS product_name, p.code AS product_code FROM production_batches b JOIN products p ON p.id=b.product_id`;
  const params = [];
  if (status !== 'all') { sql += ' WHERE b.status=?'; params.push(status); }
  sql += ' ORDER BY b.id DESC';
  const batches = db.prepare(sql).all(...params);
  res.render('production/index', { title: 'Production Batches', batches, status });
});

router.get('/new', (req, res) => {
  const products = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY name').all();
  res.render('production/form', { title: 'New Batch', products });
});

router.post('/', (req, res) => {
  const { product_id, qty_planned, notes, is_bundle } = req.body;
  const isBundle = is_bundle ? 1 : 0;
  const planned = parseInt(qty_planned);
  if (!product_id || !planned) { flash(req, 'danger', 'Pick a product and enter qty'); return res.redirect('/production/new'); }

  let batchId;
  let bundleSizeFinal = 1;
  let createdNames = [];

  const trx = db.transaction(() => {
    const primary = db.prepare('SELECT * FROM products WHERE id=?').get(product_id);
    if (!primary) throw new Error('Primary product not found');

    let sizesMap = {};
    if (isBundle) {
      // Parse "XL, XL, L" → {XL: 2, L: 1} or "XL:2, L, M*3" → {XL: 2, L: 1, M: 3}
      sizesMap = parseBundleSizes(req.body.bundle_sizes || '');
      // Auto-include primary's size if not already there (case-insensitive)
      if (primary.size) {
        const matchKey = Object.keys(sizesMap).find(k => k.toLowerCase() === primary.size.toLowerCase());
        if (!matchKey) sizesMap[primary.size] = 1;
      }
      const totalPerBundle = Object.values(sizesMap).reduce((a, b) => a + b, 0);
      bundleSizeFinal = totalPerBundle > 1 ? totalPerBundle : 1;
    }

    // Insert batch
    const batch_no = nextCode('production_batches', 'batch_no', 'BATCH');
    const r = db.prepare(`INSERT INTO production_batches (batch_no,product_id,qty_planned,is_bundle,bundle_size,notes,created_by) VALUES (?,?,?,?,?,?,?)`)
      .run(batch_no, product_id, planned, isBundle && bundleSizeFinal > 1 ? 1 : 0, bundleSizeFinal, notes || null, req.session.user.id);
    batchId = r.lastInsertRowid;

    // For bundle: find or auto-create variant products per size, with same pricing
    if (isBundle && bundleSizeFinal > 1) {
      const findVariant = db.prepare(`SELECT id FROM products WHERE name=? AND COALESCE(category_id,0)=COALESCE(?,0) AND COALESCE(size,'')=? AND active=1 ORDER BY id LIMIT 1`);
      const insProd = db.prepare(`INSERT INTO products (code,name,category_id,hsn_code,size,color,unit,mrp,sale_price,cost_price,gst_rate,reorder_level) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      const insStock = { run: (id) => stock.ensureRow(id) };  // Phase 4: default location
      const insMember = db.prepare(`INSERT INTO production_batch_products (batch_id,product_id,qty_per_bundle) VALUES (?,?,?)`);

      Object.entries(sizesMap).forEach(([size, qtyPerBundle]) => {
        let variantId;
        if (primary.size && primary.size.toLowerCase() === size.toLowerCase()) {
          variantId = primary.id;
        } else {
          const ex = findVariant.get(primary.name, primary.category_id, size);
          if (ex) {
            variantId = ex.id;
          } else {
            const newCode = nextCode('products', 'code', 'PRD');
            const result = insProd.run(
              newCode, primary.name, primary.category_id, primary.hsn_code,
              size, primary.color, primary.unit,
              primary.mrp, primary.sale_price, primary.cost_price, primary.gst_rate, primary.reorder_level
            );
            variantId = Number(result.lastInsertRowid);
            insStock.run(variantId);
            createdNames.push(`${newCode} ${primary.name} (${size})`);

            // Copy BOM from primary so each size variant inherits material requirements
            const primaryBom = db.prepare('SELECT raw_material_id, qty_per_piece, notes FROM product_bom WHERE product_id=?').all(primary.id);
            const insBom = db.prepare(`INSERT OR IGNORE INTO product_bom (product_id, raw_material_id, qty_per_piece, notes) VALUES (?,?,?,?)`);
            primaryBom.forEach(b => insBom.run(variantId, b.raw_material_id, b.qty_per_piece, b.notes));
          }
        }
        try { insMember.run(batchId, variantId, qtyPerBundle); } catch (e) { /* duplicate */ }
      });
    }
  });
  trx();

  let msg = `Batch created.`;
  const batchInfo = db.prepare('SELECT batch_no FROM production_batches WHERE id=?').get(batchId);
  if (isBundle && bundleSizeFinal > 1) {
    msg = `Batch ${batchInfo.batch_no} created (bundle of ${bundleSizeFinal} sizes).`;
    if (createdNames.length) {
      msg += ` Auto-created ${createdNames.length} new size variant(s): ${createdNames.join(', ')}.`;
    }
  } else {
    msg = `Batch ${batchInfo.batch_no} created.`;
  }
  req.audit('create', 'batch', batchId, `${batchInfo.batch_no} · planned ${planned}${isBundle ? ' bundles × ' + bundleSizeFinal + ' sizes' : ' pcs'}`);
  flash(req, 'success', msg);
  res.redirect('/production/' + batchId);
});

function computeStageTotals(batchId, stageKeys) {
  const rows = db.prepare(`
    SELECT stage, COALESCE(SUM(qty_out),0) AS done, COALESCE(SUM(qty_rejected),0) AS rejected
    FROM production_stage_entries WHERE batch_id=? GROUP BY stage
  `).all(batchId);
  const totals = {};
  stageKeys.forEach(s => { totals[s] = { done: 0, rejected: 0 }; });
  rows.forEach(r => { totals[r.stage] = totals[r.stage] || { done: 0, rejected: 0 }; totals[r.stage].done = r.done; totals[r.stage].rejected = r.rejected; });
  return totals;
}

router.get('/:id', (req, res) => {
  const b = db.prepare(`SELECT b.*, p.name AS product_name, p.code AS product_code FROM production_batches b JOIN products p ON p.id=b.product_id WHERE b.id=?`).get(req.params.id);
  if (!b) return res.redirect('/production');
  const entries = db.prepare(`
    SELECT e.*, u.name AS by_name,
           rv.code AS rejected_variant_code, rv.name AS rejected_variant_name, rv.size AS rejected_variant_size
    FROM production_stage_entries e
    LEFT JOIN users u ON u.id=e.created_by
    LEFT JOIN products rv ON rv.id=e.rejected_variant_id
    WHERE e.batch_id=?
    ORDER BY e.id DESC
  `).all(req.params.id);
  const { keys: STAGES, labels: STAGE_LABELS } = getStages();
  const totals = computeStageTotals(req.params.id, STAGES);

  // Pipeline view — cap/available math runs in PIECES (so the new
  // piece-level rejections subtract correctly). For bundle batches we
  // also expose a bundle-equivalent count for the dropdown labels,
  // computed as floor(availablePieces / bundleSize).
  const bundleSize = b.is_bundle ? Math.max(1, b.bundle_size || 1) : 1;
  const pipeline = STAGES.map((s, idx) => {
    const t = totals[s];
    let capPieces, availablePieces;
    if (idx === 0) {
      capPieces       = b.qty_planned * bundleSize;
      availablePieces = capPieces - (t.done * bundleSize) - t.rejected;
    } else {
      const prev      = totals[STAGES[idx - 1]];
      capPieces       = prev.done * bundleSize;
      availablePieces = capPieces - (t.done * bundleSize) - t.rejected;
    }
    if (availablePieces < 0) availablePieces = 0;
    const cap       = b.is_bundle ? Math.floor(capPieces / bundleSize) : capPieces;
    const available = b.is_bundle ? Math.floor(availablePieces / bundleSize) : availablePieces;
    const pct = cap > 0 ? Math.round((t.done * 100) / cap) : 0;
    return { stage: s, label: STAGE_LABELS[s] || s, done: t.done, rejected: t.rejected, cap, available, availablePieces, pct };
  });
  const nextStage = pipeline.find(p => p.available > 0)?.stage || STAGES[0];

  // Bundle products (size variants)
  const bundleProducts = b.is_bundle ? db.prepare(`
    SELECT bp.*, p.code, p.name, p.size, p.color, COALESCE(rs.quantity,0) AS stock_qty
    FROM production_batch_products bp
    JOIN products p ON p.id=bp.product_id
    LEFT JOIN ready_stock_total rs ON rs.product_id=p.id
    WHERE bp.batch_id=? ORDER BY bp.id`).all(req.params.id) : [];

  // BOM-based raw material requirement
  // Bundle: each member uses ITS OWN BOM if defined, ELSE inherits the master bundle SKU's BOM.
  // Regular: master product's BOM × qty_planned.
  let bomReq;
  if (b.is_bundle) {
    bomReq = db.prepare(`
      WITH effective_bom AS (
        -- Member's own BOM
        SELECT bp.product_id, bp.qty_per_bundle, bom.raw_material_id, bom.qty_per_piece
        FROM production_batch_products bp
        JOIN product_bom bom ON bom.product_id = bp.product_id
        WHERE bp.batch_id = ?
        UNION ALL
        -- Master's BOM falls back for members with no own BOM
        SELECT bp.product_id, bp.qty_per_bundle, mbom.raw_material_id, mbom.qty_per_piece
        FROM production_batch_products bp
        JOIN production_batches pb ON pb.id = bp.batch_id
        JOIN product_bom mbom ON mbom.product_id = pb.product_id
        WHERE bp.batch_id = ?
          AND NOT EXISTS (SELECT 1 FROM product_bom WHERE product_id = bp.product_id)
      )
      SELECT eb.raw_material_id, rm.code, rm.name, rm.unit, rm.cost_per_unit, rm.current_stock,
             SUM(eb.qty_per_piece * eb.qty_per_bundle) AS qty_per_piece,
             SUM(eb.qty_per_piece * eb.qty_per_bundle * ?) AS required
      FROM effective_bom eb
      JOIN raw_materials rm ON rm.id = eb.raw_material_id
      GROUP BY eb.raw_material_id
      ORDER BY rm.name
    `).all(req.params.id, req.params.id, b.qty_planned);
  } else {
    bomReq = db.prepare(`
      SELECT bom.raw_material_id, rm.code, rm.name, rm.unit, rm.cost_per_unit, rm.current_stock,
             bom.qty_per_piece, bom.qty_per_piece * ? AS required
      FROM product_bom bom JOIN raw_materials rm ON rm.id=bom.raw_material_id
      WHERE bom.product_id = ?
    `).all(b.qty_planned, b.product_id);
  }

  // ─── Batch Cost Summary ────────────────────────────────────────────────
  // Materials cost = sum of issue txns ref'd to this batch
  const matCostRow = db.prepare(`SELECT COALESCE(SUM(total_amount),0) AS v FROM raw_material_txns WHERE ref_no = ? AND txn_type = 'issue'`).get(b.batch_no);
  const materialsCost = matCostRow.v;
  // Labor cost = sum of stage entry total_costs (already corrected for bundle pieces)
  const laborCostRow = db.prepare(`SELECT COALESCE(SUM(total_cost),0) AS v FROM production_stage_entries WHERE batch_id = ?`).get(req.params.id);
  const laborCost = laborCostRow.v;
  const computedBatchCost = materialsCost + laborCost;
  const totalPiecesPlanned = b.is_bundle ? b.qty_planned * b.bundle_size : b.qty_planned;
  const computedPerPiece = totalPiecesPlanned > 0 ? computedBatchCost / totalPiecesPlanned : 0;

  // Expected cost = sum of variant cost_prices × pieces_for_variant
  let expectedBatchCost = 0;
  if (b.is_bundle) {
    const exp = db.prepare(`
      SELECT SUM(p.cost_price * bp.qty_per_bundle * ?) AS v
      FROM production_batch_products bp JOIN products p ON p.id = bp.product_id
      WHERE bp.batch_id = ?
    `).get(b.qty_planned, req.params.id);
    expectedBatchCost = exp ? exp.v || 0 : 0;
  } else {
    const p = db.prepare('SELECT cost_price FROM products WHERE id=?').get(b.product_id);
    expectedBatchCost = (p ? p.cost_price : 0) * b.qty_planned;
  }
  const expectedPerPiece = totalPiecesPlanned > 0 ? expectedBatchCost / totalPiecesPlanned : 0;
  const batchVariance = expectedBatchCost - computedBatchCost;
  const batchVariancePct = computedBatchCost > 0 ? (batchVariance * 100 / computedBatchCost) : 0;

  // Stage-by-stage breakdown for the summary card
  const stageBreakdown = db.prepare(`
    SELECT stage, COALESCE(SUM(total_cost), 0) AS cost, COALESCE(SUM(qty_out), 0) AS qty_out
    FROM production_stage_entries WHERE batch_id = ? GROUP BY stage
  `).all(req.params.id);
  // Sort by master stage order
  const stageOrder = db.prepare('SELECT stage_key, sort_order, label FROM production_stages_master').all();
  const stageMap = {}; stageOrder.forEach(s => { stageMap[s.stage_key] = s; });
  stageBreakdown.sort((a,b2) => (stageMap[a.stage]?.sort_order || 999) - (stageMap[b2.stage]?.sort_order || 999));
  stageBreakdown.forEach(s => { s.label = stageMap[s.stage]?.label || s.stage; });

  res.render('production/show', {
    title: 'Batch ' + b.batch_no, b, entries, pipeline, nextStage, bundleProducts, bomReq,
    materialsCost, laborCost, computedBatchCost, totalPiecesPlanned, computedPerPiece,
    expectedBatchCost, expectedPerPiece, batchVariance, batchVariancePct, stageBreakdown,
  });
});

// Compute the BOM lines needed for a batch (per-bundle or per-piece).
// Returns array of { raw_material_id, name, cost_per_unit, current_stock, qty_per_unit }
function computeBatchMaterialNeeds(batch) {
  if (batch.is_bundle) {
    return db.prepare(`
      WITH effective_bom AS (
        SELECT bp.product_id, bp.qty_per_bundle, bom.raw_material_id, bom.qty_per_piece
        FROM production_batch_products bp
        JOIN product_bom bom ON bom.product_id = bp.product_id
        WHERE bp.batch_id = ?
        UNION ALL
        SELECT bp.product_id, bp.qty_per_bundle, mbom.raw_material_id, mbom.qty_per_piece
        FROM production_batch_products bp
        JOIN production_batches pb ON pb.id = bp.batch_id
        JOIN product_bom mbom ON mbom.product_id = pb.product_id
        WHERE bp.batch_id = ?
          AND NOT EXISTS (SELECT 1 FROM product_bom WHERE product_id = bp.product_id)
      )
      SELECT eb.raw_material_id, rm.cost_per_unit, rm.current_stock, rm.name, rm.unit,
             SUM(eb.qty_per_piece * eb.qty_per_bundle) AS qty_per_unit
      FROM effective_bom eb
      JOIN raw_materials rm ON rm.id = eb.raw_material_id
      GROUP BY eb.raw_material_id
    `).all(batch.id, batch.id);
  }
  return db.prepare(`
    SELECT bom.raw_material_id, bom.qty_per_piece AS qty_per_unit, rm.cost_per_unit, rm.current_stock, rm.name, rm.unit
    FROM product_bom bom JOIN raw_materials rm ON rm.id=bom.raw_material_id
    WHERE bom.product_id=?
  `).all(batch.product_id);
}

// Issue all BOM materials for a batch. Called from the manual button OR
// auto-triggered on the first stage entry. Returns { ok, issued, errors, insufficient }.
function issueBatchMaterials(batch, userId, options = {}) {
  const { allowInsufficient = false } = options;
  const bom = computeBatchMaterialNeeds(batch);
  if (bom.length === 0) {
    return { ok: false, errors: ['No BOM defined for ' + (batch.is_bundle ? 'any size variant in this bundle' : 'this product')], issued: 0 };
  }
  const insufficient = bom.filter(item => item.current_stock < item.qty_per_unit * batch.qty_planned);
  if (insufficient.length && !allowInsufficient) {
    return {
      ok: false,
      insufficient,
      errors: insufficient.map(i => `${i.name} (need ${(i.qty_per_unit * batch.qty_planned).toFixed(2)} ${i.unit||''}, have ${i.current_stock})`),
      issued: 0,
    };
  }
  // Issue all (even if some are short, when allowInsufficient = true — stock can go negative for visibility)
  db.prepare('UPDATE production_batches SET materials_issued=1 WHERE id=?').run(batch.id);
  bom.forEach(item => {
    const qty = item.qty_per_unit * batch.qty_planned;
    const total = qty * item.cost_per_unit;
    db.prepare('UPDATE raw_materials SET current_stock = current_stock - ? WHERE id=?').run(qty, item.raw_material_id);
    db.prepare(`INSERT INTO raw_material_txns (raw_material_id,txn_type,quantity,rate,total_amount,ref_no,notes,created_by) VALUES (?,?,?,?,?,?,?,?)`)
      .run(item.raw_material_id, 'issue', qty, item.cost_per_unit, total, batch.batch_no, 'Auto-issued for ' + batch.batch_no + (batch.is_bundle ? ' (bundle, summed across variants)' : ''), userId);
  });
  return { ok: true, issued: bom.length, insufficient };
}

router.post('/:id/issue-materials', (req, res) => {
  const b = db.prepare('SELECT * FROM production_batches WHERE id=?').get(req.params.id);
  if (!b) return res.redirect('/production');
  if (b.materials_issued) { flash(req, 'warning', 'Materials already issued for this batch.'); return res.redirect('/production/' + req.params.id); }
  const result = issueBatchMaterials(b, req.session.user.id);
  if (!result.ok) {
    flash(req, 'danger', (result.insufficient ? 'Not enough stock: ' : '') + result.errors.join('; '));
    return res.redirect('/production/' + req.params.id);
  }
  flash(req, 'success', `Materials issued for ${result.issued} BOM line${result.issued>1?'s':''}${b.is_bundle ? ' (summed across ' + b.bundle_size + ' variants)' : ''}.`);
  res.redirect('/production/' + req.params.id);
});

router.post('/:id/stage', (req, res) => {
  const { stage, qty_completed, qty_rejected, rejected_variant_id, worker_name, rate_per_piece, entry_date, notes } = req.body;
  const { keys: STAGES, labels: STAGE_LABELS, packingKey } = getStages();
  if (!STAGES.includes(stage)) { flash(req, 'danger', 'Invalid stage'); return res.redirect('/production/' + req.params.id); }
  const qOut = parseInt(qty_completed || 0);
  const qRej = parseInt(qty_rejected || 0);
  if (qOut < 0 || qRej < 0) { flash(req, 'danger', 'Quantities cannot be negative'); return res.redirect('/production/' + req.params.id); }
  if (qOut === 0 && qRej === 0) { flash(req, 'danger', 'Enter at least one — completed or rejected pieces'); return res.redirect('/production/' + req.params.id); }

  const b = db.prepare('SELECT * FROM production_batches WHERE id=?').get(req.params.id);
  if (!b) return res.redirect('/production');
  if (b.status !== 'in_progress') { flash(req, 'danger', 'Batch is not in progress'); return res.redirect('/production/' + req.params.id); }

  // Unit convention going forward (Option B):
  //   * qty_out      = bundles for bundle batches, pieces for regular batches.
  //   * qty_rejected = PIECES always (rejections happen at piece level —
  //                    rejecting 1 bundle of 26 because of 1 bad shirt is
  //                    wrong, was the bug owner reported).
  // Cap math therefore runs in PIECES so the two columns can be summed.
  const bundleSize = b.is_bundle ? Math.max(1, b.bundle_size || 1) : 1;
  const toPieces = (out, rej) => (b.is_bundle ? out * bundleSize : out) + rej;

  const totals = computeStageTotals(req.params.id, STAGES);
  const idx = STAGES.indexOf(stage);
  let availablePieces;
  if (idx === 0) {
    const plannedPieces = b.qty_planned * bundleSize;     // qty_planned is bundles when is_bundle, else 1×qty
    const usedPieces    = toPieces(totals[STAGES[0]].done, totals[STAGES[0]].rejected);
    availablePieces     = plannedPieces - usedPieces;
  } else {
    const prev          = totals[STAGES[idx - 1]];
    const prevDonePcs   = b.is_bundle ? prev.done * bundleSize : prev.done;
    const usedPieces    = toPieces(totals[stage].done, totals[stage].rejected);
    availablePieces     = prevDonePcs - usedPieces;
  }

  const entryPieces = toPieces(qOut, qRej);
  if (entryPieces > availablePieces) {
    const prevLabel = idx === 0
      ? `planned qty (${b.qty_planned}${b.is_bundle ? ' bundles = ' + (b.qty_planned * bundleSize) + ' pcs' : ' pcs'})`
      : `${STAGE_LABELS[STAGES[idx - 1]]} completed (${b.is_bundle ? totals[STAGES[idx - 1]].done + ' bundles = ' + (totals[STAGES[idx - 1]].done * bundleSize) + ' pcs' : totals[STAGES[idx - 1]].done + ' pcs'})`;
    flash(req, 'danger', `Cannot enter ${entryPieces} pieces in ${STAGE_LABELS[stage]} — only ${availablePieces} available (capped by ${prevLabel}).`);
    return res.redirect('/production/' + req.params.id);
  }

  const rate = parseFloat(rate_per_piece || 0);
  // For bundle batches: qty_out is BUNDLES, rate is per PIECE — multiply by bundle_size.
  // Rejected pieces also count toward labor cost (worker did the work even if defective).
  const piecesProduced = b.is_bundle ? qOut * bundleSize : qOut;
  const total = (piecesProduced + qRej) * rate;
  const qIn = entryPieces;   // qty_in stored in PIECES (consistent across batch types)

  // Optional size-variant tag for rejected pieces. Only honoured for
  // bundle batches with a matching member; ignored otherwise.
  let rejectedVariantId = null;
  if (b.is_bundle && qRej > 0 && rejected_variant_id) {
    const v = parseInt(rejected_variant_id);
    const valid = db.prepare('SELECT 1 AS ok FROM production_batch_products WHERE batch_id=? AND product_id=?').get(req.params.id, v);
    if (valid) rejectedVariantId = v;
  }

  let autoIssueResult = null;
  const trx = db.transaction(() => {
    db.prepare(`INSERT INTO production_stage_entries (batch_id,stage,qty_in,qty_out,qty_rejected,rejected_variant_id,worker_name,rate_per_piece,total_cost,entry_date,notes,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(req.params.id, stage, qIn, qOut, qRej, rejectedVariantId, worker_name || null, rate, total, entry_date || new Date().toISOString().slice(0, 10), notes || null, req.session.user.id);

    // Auto-issue raw materials on the FIRST stage entry (when qty_out > 0).
    // Materials are physically consumed at cutting → so any stage producing pieces means consumption already happened.
    if (!b.materials_issued && qOut > 0) {
      autoIssueResult = issueBatchMaterials(b, req.session.user.id, { allowInsufficient: true });
    }

    if (stage === packingKey && qOut > 0) {
      if (b.is_bundle) {
        // Distribute across bundle members
        const members = db.prepare('SELECT * FROM production_batch_products WHERE batch_id=?').all(req.params.id);
        if (members.length === 0) {
          // Fallback: stock to primary product
          stockTo(b.product_id, qOut, req.params.id, req.session.user.id);
        } else {
          // Treat qOut as bundles produced; each bundle adds qty_per_bundle pieces of each member
          members.forEach(m => {
            const pieces = qOut * m.qty_per_bundle;
            stockTo(m.product_id, pieces, req.params.id, req.session.user.id);
            db.prepare('UPDATE production_batch_products SET qty_packed = qty_packed + ? WHERE id=?').run(pieces, m.id);
          });
        }
      } else {
        stockTo(b.product_id, qOut, req.params.id, req.session.user.id);
      }
      db.prepare(`UPDATE production_batches SET qty_completed = qty_completed + ? WHERE id=?`).run(qOut, req.params.id);
    }

    db.prepare(`UPDATE production_batches SET current_stage = ? WHERE id=?`).run(stage, req.params.id);
  });
  trx();

  const doneUnit = b.is_bundle ? 'bundles' : 'pieces';
  let msg = `Recorded: ${qOut} ${doneUnit} completed${qRej ? `, ${qRej} pcs rejected` : ''} in ${STAGE_LABELS[stage]}.`;
  if (autoIssueResult && autoIssueResult.ok) {
    msg += ` Auto-issued ${autoIssueResult.issued} BOM material line${autoIssueResult.issued>1?'s':''} from raw stock.`;
    if (autoIssueResult.insufficient && autoIssueResult.insufficient.length) {
      msg += ` ⚠ Stock went negative for: ${autoIssueResult.insufficient.map(i=>i.name).join(', ')}.`;
    }
  } else if (autoIssueResult && !autoIssueResult.ok) {
    msg += ` (Note: materials NOT auto-issued — ${autoIssueResult.errors[0]})`;
  }
  const variantTag = rejectedVariantId
    ? ' (' + (db.prepare('SELECT code FROM products WHERE id=?').get(rejectedVariantId)?.code || '#' + rejectedVariantId) + ')'
    : '';
  req.audit('stage_entry', 'batch', req.params.id, `${stage}: +${qOut} ${doneUnit} done${qRej ? ', ' + qRej + ' pcs rejected' + variantTag : ''} (rate ₹${rate})`);
  flash(req, autoIssueResult && autoIssueResult.insufficient && autoIssueResult.insufficient.length ? 'warning' : 'success', msg);
  res.redirect('/production/' + req.params.id);
});

function stockTo(productId, qty, batchId, userId) {
  // Production output lands at the default location (the factory). When
  // we want per-batch fulfillment targeting (Phase 4b), this can take a
  // location_id parameter.
  const locId = stock.defaultLocationId();
  stock.addQty(productId, qty, locId);
  db.prepare(`INSERT INTO stock_movements (product_id, movement_type, quantity, ref_table, ref_id, to_location_id, created_by) VALUES (?,?,?,?,?,?,?)`)
    .run(productId, 'production_in', qty, 'production_batches', batchId, locId, userId);
  // Create per-piece records with unique codes
  const product = db.prepare('SELECT code, cost_price FROM products WHERE id=?').get(productId);
  if (!product) return;
  const lastSeq = db.prepare('SELECT COUNT(*) AS n FROM inventory_pieces WHERE product_id=?').get(productId).n;
  // Compute per-piece manufacturing cost from BOM + stage rates available at this point
  const matCost = db.prepare(`SELECT COALESCE(SUM(b.qty_per_piece * rm.cost_per_unit), 0) AS v FROM product_bom b JOIN raw_materials rm ON rm.id=b.raw_material_id WHERE b.product_id=?`).get(productId).v;
  const stageCost = db.prepare(`SELECT COALESCE(SUM(rate_per_piece), 0) AS v FROM (SELECT stage, AVG(rate_per_piece) AS rate_per_piece FROM production_stage_entries WHERE batch_id=? AND rate_per_piece > 0 GROUP BY stage)`).get(batchId).v;
  const piecePrice = matCost + stageCost;
  const insPiece = db.prepare(`INSERT INTO inventory_pieces (piece_code, product_id, batch_id, status, cost_per_piece) VALUES (?,?,?,?,?)`);
  for (let i = 0; i < qty; i++) {
    const code = product.code + '-' + String(lastSeq + i + 1).padStart(5, '0');
    try { insPiece.run(code, productId, batchId, 'in_stock', piecePrice); } catch (e) { /* dupe — should not happen */ }
  }
}

router.post('/:id/entry/:entryId/delete', (req, res) => {
  const e = db.prepare('SELECT * FROM production_stage_entries WHERE id=? AND batch_id=?').get(req.params.entryId, req.params.id);
  if (!e) { flash(req, 'danger', 'Entry not found'); return res.redirect('/production/' + req.params.id); }
  const b = db.prepare('SELECT * FROM production_batches WHERE id=?').get(req.params.id);
  const { packingKey } = getStages();
  if (e.stage === packingKey && e.qty_out > 0) {
    const reversePieces = (productId, n) => {
      // Remove the most recently created in-stock pieces for this product+batch
      const ids = db.prepare(`SELECT id FROM inventory_pieces WHERE product_id=? AND batch_id=? AND status='in_stock' ORDER BY id DESC LIMIT ?`).all(productId, req.params.id, n);
      ids.forEach(p => db.prepare('DELETE FROM inventory_pieces WHERE id=?').run(p.id));
    };
    if (b.is_bundle) {
      const members = db.prepare('SELECT * FROM production_batch_products WHERE batch_id=?').all(req.params.id);
      members.forEach(m => {
        const pieces = e.qty_out * m.qty_per_bundle;
        stock.removeQty(m.product_id, pieces);  // Phase 4: default location
        db.prepare('UPDATE production_batch_products SET qty_packed = qty_packed - ? WHERE id=?').run(pieces, m.id);
        reversePieces(m.product_id, pieces);
        db.prepare(`INSERT INTO stock_movements (product_id, movement_type, quantity, ref_table, ref_id, notes, created_by) VALUES (?,?,?,?,?,?,?)`)
          .run(m.product_id, 'adjustment', -pieces, 'production_batches', req.params.id, 'Reverted: deleted packing entry #' + e.id, req.session.user.id);
      });
    } else {
      stock.removeQty(b.product_id, e.qty_out);  // Phase 4: default location
      reversePieces(b.product_id, e.qty_out);
      db.prepare(`INSERT INTO stock_movements (product_id, movement_type, quantity, ref_table, ref_id, notes, created_by) VALUES (?,?,?,?,?,?,?)`)
        .run(b.product_id, 'adjustment', -e.qty_out, 'production_batches', req.params.id, 'Reverted: deleted packing entry #' + e.id, req.session.user.id);
    }
    db.prepare('UPDATE production_batches SET qty_completed = qty_completed - ? WHERE id=?').run(e.qty_out, req.params.id);
  }
  db.prepare('DELETE FROM production_stage_entries WHERE id=?').run(req.params.entryId);
  flash(req, 'success', `Entry deleted (${e.qty_out} ${b.is_bundle && e.stage === packingKey ? 'bundles' : 'pcs'} in ${e.stage}).`);
  res.redirect('/production/' + req.params.id);
});

router.post('/:id/complete', (req, res) => {
  db.prepare(`UPDATE production_batches SET status='completed', end_date=date('now') WHERE id=?`).run(req.params.id);
  req.audit('complete', 'batch', req.params.id);
  flash(req, 'success', 'Batch marked complete.');
  res.redirect('/production/' + req.params.id);
});

router.post('/:id/cancel', (req, res) => {
  db.prepare(`UPDATE production_batches SET status='cancelled', end_date=date('now') WHERE id=?`).run(req.params.id);
  req.audit('cancel', 'batch', req.params.id);
  flash(req, 'success', 'Batch cancelled.');
  res.redirect('/production/' + req.params.id);
});

function batchIsLocked(batchId) {
  const b = db.prepare('SELECT status, materials_issued FROM production_batches WHERE id=?').get(batchId);
  if (!b) return 'not found';
  if (b.status === 'completed' || b.status === 'cancelled') return 'Batch is ' + b.status;
  if (b.materials_issued) return 'Materials already issued — cannot change qty/product';
  const entries = db.prepare('SELECT COUNT(*) AS n FROM production_stage_entries WHERE batch_id=?').get(batchId);
  if (entries.n > 0) return 'Stage entries exist — cannot change qty/product';
  return null;
}

router.get('/:id/edit', (req, res) => {
  const b = db.prepare('SELECT * FROM production_batches WHERE id=?').get(req.params.id);
  if (!b) return res.redirect('/production');
  const lock = batchIsLocked(req.params.id);
  if (lock && lock !== 'Materials already issued — cannot change qty/product' && lock !== 'Stage entries exist — cannot change qty/product') {
    flash(req, 'danger', lock); return res.redirect('/production/' + b.id);
  }
  // notesOnly = true means qty/product fields are locked
  const notesOnly = !!lock;
  res.render('production/edit', { title: 'Edit Batch ' + b.batch_no, b, notesOnly });
});

router.post('/:id/edit', (req, res) => {
  const b = db.prepare('SELECT * FROM production_batches WHERE id=?').get(req.params.id);
  if (!b) return res.redirect('/production');
  const lock = batchIsLocked(req.params.id);
  const { notes, qty_planned } = req.body;
  if (lock) {
    db.prepare('UPDATE production_batches SET notes=? WHERE id=?').run(notes||null, b.id);
    flash(req, 'success', 'Notes updated.');
  } else {
    const planned = parseInt(qty_planned);
    if (!planned || planned < 1) { flash(req,'danger','Invalid qty'); return res.redirect('/production/' + b.id + '/edit'); }
    db.prepare('UPDATE production_batches SET qty_planned=?, notes=? WHERE id=?').run(planned, notes||null, b.id);
    flash(req, 'success', 'Batch updated.');
  }
  req.audit('update', 'batch', b.id, b.batch_no + ' — qty ' + (qty_planned||b.qty_planned));
  res.redirect('/production/' + b.id);
});

module.exports = router;
