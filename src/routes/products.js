const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const QRCode = require('qrcode');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { nextCode } = require('../utils/codegen');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'public', 'uploads', 'products');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg';
      const rnd = require('crypto').randomBytes(4).toString('hex');
      cb(null, 'p' + req.params.id + '_' + Date.now() + '_' + rnd + ext);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, /^image\/(jpe?g|png|webp|gif)$/i.test(file.mimetype));
  },
});

const router = express.Router();

router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  const view = req.query.view || 'grid'; // 'grid' (catalog) or 'list' (table)
  const categoryId = req.query.category || '';
  const sortBy = req.query.sort || 'newest';
  let sql = `SELECT p.*, c.name AS category_name, COALESCE(rs.quantity,0) AS stock_qty
             FROM products p LEFT JOIN product_categories c ON c.id = p.category_id
             LEFT JOIN ready_stock rs ON rs.product_id = p.id WHERE 1=1`;
  const params = [];
  if (q) { sql += ' AND (p.code LIKE ? OR p.name LIKE ? OR p.color LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (categoryId) { sql += ' AND p.category_id = ?'; params.push(categoryId); }
  if (sortBy === 'price_low')      sql += ' ORDER BY p.sale_price ASC';
  else if (sortBy === 'price_high')sql += ' ORDER BY p.sale_price DESC';
  else if (sortBy === 'name')      sql += ' ORDER BY p.name ASC';
  else if (sortBy === 'stock')     sql += ' ORDER BY stock_qty DESC';
  else                              sql += ' ORDER BY p.id DESC';
  const products = db.prepare(sql).all(...params);
  const cats = db.prepare('SELECT * FROM product_categories ORDER BY name').all();
  res.render('products/index', { title: 'Products Catalog', products, q, view, categoryId, sortBy, cats });
});

router.get('/new', (req, res) => {
  const cats = db.prepare('SELECT * FROM product_categories ORDER BY name').all();
  res.render('products/form', { title: 'New Product', p: null, cats });
});

// Parse "28, 30, 32, 34" → {28:1, 30:1, 32:1, 34:1}
// Or "XL, XL, L" → {XL:2, L:1}; supports `Size:N`, `Size*N`, `Size xN`
function parseBundleSizes(input) {
  const result = {};
  if (!input) return result;
  input.split(',').map(s => s.trim()).filter(Boolean).forEach(part => {
    const m = part.match(/^(.+?)(?:\s*[*:x×]\s*(\d+))?$/i);
    if (!m) return;
    const sz = m[1].trim();
    const qty = parseInt(m[2] || 1);
    if (!sz || qty < 1) return;
    const existing = Object.keys(result).find(k => k.toLowerCase() === sz.toLowerCase());
    if (existing) result[existing] += qty;
    else result[sz] = qty;
  });
  return result;
}

router.post('/', (req, res) => {
  try {
    const { name, category_id, hsn_code, size, color, unit, mrp, sale_price, cost_price, gst_rate, reorder_level, is_bundle_sku } = req.body;
    let masterId;
    const createdNames = [];
    const trx = db.transaction(() => {
      const code = req.body.code || nextCode('products', 'code', 'PRD');
      const r = db.prepare(`INSERT INTO products (code,name,category_id,hsn_code,size,color,unit,mrp,sale_price,cost_price,gst_rate,reorder_level,is_bundle_sku)
                            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(code, name, category_id || null, hsn_code || null, size || null, color || null, unit || 'PCS',
          parseFloat(mrp || 0), parseFloat(sale_price || 0), parseFloat(cost_price || 0), parseFloat(gst_rate || 5), parseInt(reorder_level || 0),
          is_bundle_sku ? 1 : 0);
      masterId = Number(r.lastInsertRowid);
      db.prepare('INSERT OR IGNORE INTO ready_stock (product_id, quantity) VALUES (?,0)').run(masterId);

      // Bundle SKU + sizes input → auto-create sized variants & link as components
      if (is_bundle_sku && req.body.bundle_sizes) {
        const sizesMap = parseBundleSizes(req.body.bundle_sizes);
        const findVariant = db.prepare(`SELECT id FROM products WHERE name=? AND COALESCE(category_id,0)=COALESCE(?,0) AND COALESCE(size,'')=? AND is_bundle_sku=0 AND active=1 ORDER BY id LIMIT 1`);
        const insProd = db.prepare(`INSERT INTO products (code,name,category_id,hsn_code,size,color,unit,mrp,sale_price,cost_price,gst_rate,reorder_level,is_bundle_sku) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)`);
        const insStock = db.prepare('INSERT OR IGNORE INTO ready_stock (product_id, quantity) VALUES (?,0)');
        const insComp = db.prepare(`INSERT OR IGNORE INTO product_bundle_components (bundle_product_id, member_product_id, qty) VALUES (?,?,?)`);

        Object.entries(sizesMap).forEach(([sz, qtyPerBundle]) => {
          let variantId;
          const ex = findVariant.get(name, category_id || null, sz);
          if (ex) {
            variantId = ex.id;
          } else {
            const newCode = nextCode('products', 'code', 'PRD');
            const result = insProd.run(
              newCode, name, category_id || null, hsn_code || null,
              sz, color || null, unit || 'PCS',
              parseFloat(mrp || 0), parseFloat(sale_price || 0), parseFloat(cost_price || 0),
              parseFloat(gst_rate || 5), parseInt(reorder_level || 0)
            );
            variantId = Number(result.lastInsertRowid);
            insStock.run(variantId);
            createdNames.push(`${newCode} (${sz})`);
          }
          insComp.run(masterId, variantId, qtyPerBundle);
        });
      }
    });
    trx();

    let msg = 'Product created.';
    if (createdNames.length) msg = `Bundle SKU created with ${createdNames.length} auto-generated size variant${createdNames.length>1?'s':''}: ${createdNames.join(', ')}.`;
    req.audit('create', 'product', masterId, `${name}${createdNames.length ? ' + auto-created variants: ' + createdNames.join(', ') : ''}`);
    flash(req, 'success', msg);
    res.redirect('/products/' + masterId);
  } catch (e) { flash(req, 'danger', e.message); res.redirect('/products/new'); }
});

router.get('/:id', (req, res) => {
  const p = db.prepare(`SELECT p.*, c.name AS category_name, COALESCE(rs.quantity,0) AS stock_qty
                        FROM products p LEFT JOIN product_categories c ON c.id=p.category_id
                        LEFT JOIN ready_stock rs ON rs.product_id=p.id WHERE p.id=?`).get(req.params.id);
  if (!p) return res.redirect('/products');
  let bom = db.prepare(`SELECT b.*, rm.name AS material_name, rm.code AS material_code, rm.unit AS material_unit, rm.cost_per_unit
                        FROM product_bom b JOIN raw_materials rm ON rm.id=b.raw_material_id
                        WHERE b.product_id=? ORDER BY b.id`).all(req.params.id);
  // BOM inheritance: if variant has no BOM, inherit from any bundle master containing it
  let bomInheritedFrom = null;
  if (bom.length === 0) {
    const master = db.prepare(`
      SELECT m.id, m.code, m.name FROM products m
      JOIN product_bundle_components bc ON bc.bundle_product_id = m.id
      WHERE bc.member_product_id = ? AND m.is_bundle_sku = 1
      LIMIT 1
    `).get(req.params.id);
    if (master) {
      const masterBom = db.prepare(`SELECT b.*, rm.name AS material_name, rm.code AS material_code, rm.unit AS material_unit, rm.cost_per_unit
                                    FROM product_bom b JOIN raw_materials rm ON rm.id=b.raw_material_id
                                    WHERE b.product_id=? ORDER BY b.id`).all(master.id);
      if (masterBom.length > 0) { bom = masterBom; bomInheritedFrom = master; }
    }
  }
  const materials = db.prepare("SELECT id, code, name, unit, cost_per_unit FROM raw_materials WHERE active=1 ORDER BY name").all();
  const totalBomCost = bom.reduce((s, b) => s + b.qty_per_piece * b.cost_per_unit, 0);

  // Bundle SKU components
  const components = db.prepare(`
    SELECT bc.*, p2.code, p2.name, p2.size, p2.color, p2.sale_price,
           COALESCE(rs.quantity, 0) AS stock_qty
    FROM product_bundle_components bc
    JOIN products p2 ON p2.id = bc.member_product_id
    LEFT JOIN ready_stock rs ON rs.product_id = p2.id
    WHERE bc.bundle_product_id = ? ORDER BY bc.id
  `).all(req.params.id);
  const piecesPerBundle = components.reduce((s, c) => s + c.qty, 0);
  const availableBundles = components.length > 0
    ? Math.min(...components.map(c => Math.floor(c.stock_qty / c.qty)))
    : 0;
  const allProducts = db.prepare("SELECT id, code, name, size, sale_price FROM products WHERE active=1 AND is_bundle_sku=0 AND id != ? ORDER BY name, size").all(req.params.id);

  // Average per-stage labor cost — weighted across all batches that produced this product.
  // For a bundle batch, qty_out is BUNDLES; allocate the stage's total_cost to this variant
  // proportional to its share of the bundle (qty_per_bundle / bundle_size).
  // For a regular batch (non-bundle), the variant must equal the batch's primary product.
  const stageRows = db.prepare(`
    SELECT pse.stage,
           SUM(
             CASE WHEN pb.is_bundle = 0 THEN pse.qty_out
                  ELSE pse.qty_out * bpp.qty_per_bundle
             END
           ) AS total_pieces,
           SUM(
             CASE WHEN pb.is_bundle = 0 THEN pse.total_cost
                  ELSE pse.total_cost * (CAST(bpp.qty_per_bundle AS REAL) / NULLIF(pb.bundle_size, 0))
             END
           ) AS total_cost,
           CASE WHEN SUM(
                       CASE WHEN pb.is_bundle = 0 THEN pse.qty_out
                            ELSE pse.qty_out * bpp.qty_per_bundle END
                     ) > 0
                THEN SUM(
                       CASE WHEN pb.is_bundle = 0 THEN pse.total_cost
                            ELSE pse.total_cost * (CAST(bpp.qty_per_bundle AS REAL) / NULLIF(pb.bundle_size, 0)) END
                     ) * 1.0
                     / SUM(
                       CASE WHEN pb.is_bundle = 0 THEN pse.qty_out
                            ELSE pse.qty_out * bpp.qty_per_bundle END
                     )
                ELSE 0
           END AS avg_rate
    FROM production_stage_entries pse
    JOIN production_batches pb ON pb.id = pse.batch_id
    LEFT JOIN production_batch_products bpp ON bpp.batch_id = pb.id AND bpp.product_id = ?
    WHERE pse.qty_out > 0
      AND (
        (pb.is_bundle = 0 AND pb.product_id = ?)
        OR (pb.is_bundle = 1 AND bpp.id IS NOT NULL)
      )
    GROUP BY pse.stage
    ORDER BY pse.stage
  `).all(req.params.id, req.params.id);
  // Sort by master stage order
  const stageOrder = db.prepare('SELECT stage_key, label, sort_order FROM production_stages_master').all();
  const orderMap = {}; stageOrder.forEach(s => { orderMap[s.stage_key] = { sort: s.sort_order, label: s.label }; });
  stageRows.sort((a, b) => (orderMap[a.stage]?.sort || 999) - (orderMap[b.stage]?.sort || 999));
  stageRows.forEach(r => r.label = orderMap[r.stage]?.label || r.stage);
  const totalStageCost = stageRows.reduce((s, r) => s + r.avg_rate, 0);

  // Photo gallery
  const photos = db.prepare(`SELECT id, image_path, is_primary FROM product_photos WHERE product_id=? ORDER BY is_primary DESC, sort_order, id`).all(req.params.id);

  // Live inventory snapshot for this product (piece-level)
  const inventory = db.prepare(`
    SELECT
      SUM(CASE WHEN status='in_stock' THEN 1 ELSE 0 END) AS in_stock,
      SUM(CASE WHEN status='sold'      THEN 1 ELSE 0 END) AS sold,
      SUM(CASE WHEN status='returned'  THEN 1 ELSE 0 END) AS returned,
      COUNT(*) AS total
    FROM inventory_pieces WHERE product_id=?
  `).get(req.params.id);

  // For a master bundle SKU: count total bundle members (used by the bulk-apply button)
  const memberCount = p.is_bundle_sku ? components.length : 0;

  res.render('products/show', {
    title: p.name, p, bom, materials, totalBomCost, components, piecesPerBundle, availableBundles, allProducts,
    stageRows, totalStageCost, inventory, photos, MAX_PHOTOS,
    bomInheritedFrom, memberCount,
  });
});

// Bulk-apply this product's BOM to all members of bundles where this product is the master.
router.post('/:id/bom/apply-to-members', (req, res) => {
  const master = db.prepare('SELECT id, code, is_bundle_sku FROM products WHERE id=?').get(req.params.id);
  if (!master || !master.is_bundle_sku) {
    flash(req, 'danger', 'This product is not a bundle SKU.');
    return res.redirect('/products/' + req.params.id);
  }
  const masterBom = db.prepare('SELECT raw_material_id, qty_per_piece, notes FROM product_bom WHERE product_id=?').all(req.params.id);
  if (masterBom.length === 0) {
    flash(req, 'warning', 'Master has no BOM rows to apply.');
    return res.redirect('/products/' + req.params.id);
  }
  const members = db.prepare('SELECT member_product_id FROM product_bundle_components WHERE bundle_product_id=?').all(req.params.id);
  if (members.length === 0) {
    flash(req, 'warning', 'No bundle members.');
    return res.redirect('/products/' + req.params.id);
  }
  const overwrite = req.body.overwrite === '1';
  let appliedTo = 0, addedRows = 0, replacedRows = 0;
  const trx = db.transaction(() => {
    members.forEach(m => {
      let memberAffected = false;
      masterBom.forEach(bRow => {
        const existing = db.prepare('SELECT id FROM product_bom WHERE product_id=? AND raw_material_id=?').get(m.member_product_id, bRow.raw_material_id);
        if (existing) {
          if (overwrite) {
            db.prepare('UPDATE product_bom SET qty_per_piece=?, notes=? WHERE id=?').run(bRow.qty_per_piece, bRow.notes, existing.id);
            replacedRows++; memberAffected = true;
          }
        } else {
          db.prepare('INSERT INTO product_bom (product_id, raw_material_id, qty_per_piece, notes) VALUES (?,?,?,?)').run(m.member_product_id, bRow.raw_material_id, bRow.qty_per_piece, bRow.notes);
          addedRows++; memberAffected = true;
        }
      });
      if (memberAffected) appliedTo++;
    });
  });
  trx();
  req.audit('bom_bulk_apply', 'product', req.params.id, `Applied to ${appliedTo} member(s): +${addedRows} new${overwrite ? `, ${replacedRows} replaced` : ''}`);
  flash(req, 'success', `BOM applied to ${appliedTo} member${appliedTo===1?'':'s'}: ${addedRows} new line${addedRows===1?'':'s'} added${overwrite ? `, ${replacedRows} updated` : ', existing rows kept'}.`);
  res.redirect('/products/' + req.params.id);
});

// Detach inherited BOM into the variant's own BOM (so it can be customized independently)
router.post('/:id/bom/detach', (req, res) => {
  const own = db.prepare('SELECT COUNT(*) AS n FROM product_bom WHERE product_id=?').get(req.params.id).n;
  if (own > 0) { flash(req, 'info', 'This product already has its own BOM.'); return res.redirect('/products/' + req.params.id); }
  // Find master bundle
  const master = db.prepare(`SELECT m.id FROM products m
    JOIN product_bundle_components bc ON bc.bundle_product_id = m.id
    WHERE bc.member_product_id = ? AND m.is_bundle_sku = 1 LIMIT 1`).get(req.params.id);
  if (!master) { flash(req, 'warning', 'No bundle master to inherit from.'); return res.redirect('/products/' + req.params.id); }
  const masterBom = db.prepare('SELECT raw_material_id, qty_per_piece, notes FROM product_bom WHERE product_id=?').all(master.id);
  if (masterBom.length === 0) { flash(req, 'warning', 'Master has no BOM rows.'); return res.redirect('/products/' + req.params.id); }
  const ins = db.prepare('INSERT INTO product_bom (product_id, raw_material_id, qty_per_piece, notes) VALUES (?,?,?,?)');
  masterBom.forEach(b => ins.run(req.params.id, b.raw_material_id, b.qty_per_piece, b.notes));
  flash(req, 'success', `${masterBom.length} BOM line${masterBom.length===1?'':'s'} copied. You can now customize without affecting the master.`);
  res.redirect('/products/' + req.params.id);
});

router.get('/:id/edit', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p) return res.redirect('/products');
  const cats = db.prepare('SELECT * FROM product_categories ORDER BY name').all();
  res.render('products/form', { title: 'Edit Product', p, cats });
});

router.post('/:id', (req, res) => {
  const { name, category_id, hsn_code, size, color, unit, mrp, sale_price, cost_price, gst_rate, reorder_level, active, is_bundle_sku } = req.body;
  db.prepare(`UPDATE products SET name=?, category_id=?, hsn_code=?, size=?, color=?, unit=?, mrp=?, sale_price=?, cost_price=?, gst_rate=?, reorder_level=?, is_bundle_sku=?, active=?, updated_at=datetime('now') WHERE id=?`)
    .run(name, category_id || null, hsn_code || null, size || null, color || null, unit || 'PCS',
      parseFloat(mrp || 0), parseFloat(sale_price || 0), parseFloat(cost_price || 0), parseFloat(gst_rate || 5), parseInt(reorder_level || 0),
      is_bundle_sku ? 1 : 0, active ? 1 : 0, req.params.id);
  req.audit('update', 'product', req.params.id, `${name} · sale ₹${sale_price} · cost ₹${cost_price}`);
  flash(req, 'success', 'Product updated.'); res.redirect('/products/' + req.params.id);
});

// ----- Bundle Components -----
router.post('/:id/component', (req, res) => {
  const { member_product_id, qty } = req.body;
  if (parseInt(member_product_id) === parseInt(req.params.id)) {
    flash(req, 'danger', 'A bundle cannot include itself.');
    return res.redirect('/products/' + req.params.id);
  }
  try {
    db.prepare('INSERT INTO product_bundle_components (bundle_product_id, member_product_id, qty) VALUES (?,?,?)')
      .run(req.params.id, member_product_id, parseInt(qty) || 1);
    flash(req, 'success', 'Component added.');
  } catch (e) {
    flash(req, 'danger', /UNIQUE/.test(e.message) ? 'That component is already in the bundle. Edit the existing line.' : e.message);
  }
  res.redirect('/products/' + req.params.id);
});

router.post('/:id/component/:cid/update', (req, res) => {
  db.prepare('UPDATE product_bundle_components SET qty=? WHERE id=? AND bundle_product_id=?')
    .run(parseInt(req.body.qty) || 1, req.params.cid, req.params.id);
  flash(req, 'success', 'Component updated.');
  res.redirect('/products/' + req.params.id);
});

router.post('/:id/component/:cid/delete', (req, res) => {
  db.prepare('DELETE FROM product_bundle_components WHERE id=? AND bundle_product_id=?').run(req.params.cid, req.params.id);
  flash(req, 'success', 'Component removed.');
  res.redirect('/products/' + req.params.id);
});

// ----- Photo gallery (max 6 per product) -----
const MAX_PHOTOS = 6;

function syncPrimaryToProductImagePath(productId) {
  const primary = db.prepare(`SELECT image_path FROM product_photos WHERE product_id=? AND is_primary=1 LIMIT 1`).get(productId)
                || db.prepare(`SELECT image_path FROM product_photos WHERE product_id=? ORDER BY sort_order, id LIMIT 1`).get(productId);
  db.prepare(`UPDATE products SET image_path=?, updated_at=datetime('now') WHERE id=?`).run(primary ? primary.image_path : null, productId);
}

router.post('/:id/photos', upload.array('photos', MAX_PHOTOS), (req, res) => {
  if (!req.files || req.files.length === 0) { flash(req, 'danger', 'No images uploaded (jpg/png/webp, ≤5MB each).'); return res.redirect('/products/' + req.params.id); }
  const existing = db.prepare('SELECT COUNT(*) AS n FROM product_photos WHERE product_id=?').get(req.params.id).n;
  const remaining = MAX_PHOTOS - existing;
  if (remaining <= 0) {
    // Clean up uploaded files since we can't accept them
    req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
    flash(req, 'danger', `Already at max ${MAX_PHOTOS} photos. Delete some first.`);
    return res.redirect('/products/' + req.params.id);
  }
  const toAdd = req.files.slice(0, remaining);
  const dropped = req.files.slice(remaining);
  dropped.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });

  const ins = db.prepare(`INSERT INTO product_photos (product_id, image_path, is_primary, sort_order) VALUES (?,?,?,?)`);
  toAdd.forEach((f, i) => {
    const relPath = '/uploads/products/' + f.filename;
    const isPrimary = (existing === 0 && i === 0) ? 1 : 0;
    ins.run(req.params.id, relPath, isPrimary, existing + i);
  });
  syncPrimaryToProductImagePath(req.params.id);
  req.audit('photo_upload', 'product', req.params.id, `+${toAdd.length} photo(s)`);
  let msg = `${toAdd.length} photo${toAdd.length>1?'s':''} added.`;
  if (dropped.length > 0) msg += ` ${dropped.length} skipped (max ${MAX_PHOTOS}).`;
  flash(req, 'success', msg);
  res.redirect('/products/' + req.params.id);
});

router.post('/:id/photos/:photoId/primary', (req, res) => {
  db.prepare(`UPDATE product_photos SET is_primary=0 WHERE product_id=?`).run(req.params.id);
  db.prepare(`UPDATE product_photos SET is_primary=1 WHERE id=? AND product_id=?`).run(req.params.photoId, req.params.id);
  syncPrimaryToProductImagePath(req.params.id);
  flash(req, 'success', 'Primary photo updated.');
  res.redirect('/products/' + req.params.id);
});

router.post('/:id/photos/:photoId/delete', (req, res) => {
  const photo = db.prepare(`SELECT image_path, is_primary FROM product_photos WHERE id=? AND product_id=?`).get(req.params.photoId, req.params.id);
  if (!photo) { flash(req, 'danger', 'Photo not found'); return res.redirect('/products/' + req.params.id); }
  const filePath = path.join(UPLOAD_DIR, path.basename(photo.image_path));
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
  db.prepare('DELETE FROM product_photos WHERE id=?').run(req.params.photoId);
  if (photo.is_primary) {
    const next = db.prepare(`SELECT id FROM product_photos WHERE product_id=? ORDER BY sort_order, id LIMIT 1`).get(req.params.id);
    if (next) db.prepare(`UPDATE product_photos SET is_primary=1 WHERE id=?`).run(next.id);
  }
  syncPrimaryToProductImagePath(req.params.id);
  req.audit('photo_delete', 'product', req.params.id, `Removed photo #${req.params.photoId}`);
  flash(req, 'success', 'Photo removed.');
  res.redirect('/products/' + req.params.id);
});

// ----- BOM management -----
router.post('/:id/bom', (req, res) => {
  const { raw_material_id, qty_per_piece, notes } = req.body;
  try {
    db.prepare(`INSERT INTO product_bom (product_id, raw_material_id, qty_per_piece, notes) VALUES (?,?,?,?)`)
      .run(req.params.id, raw_material_id, parseFloat(qty_per_piece), notes || null);
    const matName = db.prepare('SELECT name FROM raw_materials WHERE id=?').get(raw_material_id)?.name || raw_material_id;
    req.audit('bom_add', 'product', req.params.id, `Added ${qty_per_piece} of ${matName}`);
    flash(req, 'success', 'BOM line added.');
  } catch (e) {
    flash(req, 'danger', /UNIQUE/.test(e.message) ? 'That material is already in this BOM. Edit the existing line instead.' : e.message);
  }
  res.redirect('/products/' + req.params.id);
});

router.post('/:id/bom/:bomId/update', (req, res) => {
  db.prepare(`UPDATE product_bom SET qty_per_piece=?, notes=? WHERE id=? AND product_id=?`)
    .run(parseFloat(req.body.qty_per_piece), req.body.notes || null, req.params.bomId, req.params.id);
  req.audit('bom_update', 'product', req.params.id, `BOM line #${req.params.bomId} qty=${req.body.qty_per_piece}`);
  flash(req, 'success', 'BOM line updated.');
  res.redirect('/products/' + req.params.id);
});

router.post('/:id/bom/:bomId/delete', (req, res) => {
  db.prepare('DELETE FROM product_bom WHERE id=? AND product_id=?').run(req.params.bomId, req.params.id);
  req.audit('bom_delete', 'product', req.params.id, `Removed BOM line #${req.params.bomId}`);
  flash(req, 'success', 'BOM line removed.');
  res.redirect('/products/' + req.params.id);
});

// ----- QR + Hangtag -----
router.get('/:id/qr.png', async (req, res) => {
  const p = db.prepare('SELECT code, name, size, color, mrp FROM products WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).end();
  const payload = JSON.stringify({ code: p.code, name: p.name, size: p.size, color: p.color, mrp: p.mrp });
  const buf = await QRCode.toBuffer(payload, { width: 360, margin: 1 });
  res.setHeader('Content-Type', 'image/png');
  res.send(buf);
});

router.get('/:id/hangtag', async (req, res) => {
  const p = db.prepare(`SELECT p.*, c.name AS category_name FROM products p LEFT JOIN product_categories c ON c.id=p.category_id WHERE p.id=?`).get(req.params.id);
  if (!p) return res.redirect('/products');
  const payload = `${p.code}|${p.name}|${p.size || ''}|${p.color || ''}|MRP:${p.mrp}`;
  const qrDataUrl = await QRCode.toDataURL(payload, { width: 220, margin: 1 });
  res.render('products/hangtag', { title: p.name + ' · Hangtag', p, qrDataUrl, layout: false });
});

module.exports = router;
