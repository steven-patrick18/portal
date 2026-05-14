const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { parse: parseCsv } = require('csv-parse/sync');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { nextCode } = require('../utils/codegen');
const { toCsv, sendCsv } = require('../utils/csv');
const router = express.Router();

const RM_CSV_COLUMNS = ['code','name','type','unit','reorder_level','cost_per_unit','supplier','active'];
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'public', 'uploads', 'raw_materials');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg';
      const rnd = require('crypto').randomBytes(4).toString('hex');
      cb(null, 'rm_' + Date.now() + '_' + rnd + ext);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, /^image\/(jpe?g|png|webp|gif)$/i.test(file.mimetype));
  },
});

function deletePhotoFile(relPath) {
  if (!relPath) return;
  try {
    const fp = path.join(UPLOAD_DIR, path.basename(relPath));
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch {}
}

router.get('/', (req, res) => {
  const items = db.prepare(`SELECT rm.*, s.name AS supplier_name FROM raw_materials rm LEFT JOIN suppliers s ON s.id=rm.supplier_id ORDER BY rm.id DESC`).all();
  res.render('rawMaterials/index', { title: 'Raw Materials', items });
});

router.get('/new', (req, res) => {
  const suppliers = db.prepare('SELECT * FROM suppliers WHERE active=1 ORDER BY name').all();
  res.render('rawMaterials/form', { title: 'New Raw Material', m: null, suppliers });
});

// ----- CSV Export / Import (owner only) -----
// Defined BEFORE the /:id routes so Express doesn't treat "export.csv" or
// "import" as a numeric raw-material id.
function requireAdminCsv(req, res, next) {
  if (req.session.user.role !== 'owner') {
    return res.status(403).render('error', { title: 'Forbidden', message: 'Owner access required.', code: 403 });
  }
  next();
}

router.get('/export.csv', requireAdminCsv, (req, res) => {
  const rows = db.prepare(`
    SELECT rm.code, rm.name, rm.type, rm.unit, rm.reorder_level, rm.cost_per_unit, s.name AS supplier, rm.active
    FROM raw_materials rm LEFT JOIN suppliers s ON s.id = rm.supplier_id
    ORDER BY rm.code
  `).all();
  const csv = toCsv(rows, RM_CSV_COLUMNS);
  const stamp = new Date().toISOString().slice(0,10);
  sendCsv(res, `raw_materials_${stamp}.csv`, csv);
});

router.get('/import', requireAdminCsv, (req, res) => {
  res.render('rawMaterials/import', { title: 'Import Raw Materials (CSV)' });
});

router.post('/import', requireAdminCsv, csvUpload.single('file'), (req, res) => {
  if (!req.file) { flash(req,'danger','No file uploaded'); return res.redirect('/raw-materials/import'); }
  let rows;
  try {
    rows = parseCsv(req.file.buffer.toString('utf-8').replace(/^﻿/, ''), { columns: true, skip_empty_lines: true, trim: true });
  } catch (e) { flash(req,'danger','CSV parse failed: ' + e.message); return res.redirect('/raw-materials/import'); }

  const deactivateMissing = req.body.deactivate_missing === '1';
  let inserted = 0, updated = 0, deactivated = 0, failed = 0;
  const errors = [];
  const seenCodes = new Set();

  const findByCode = db.prepare('SELECT id FROM raw_materials WHERE code = ?');
  const findSupplier = db.prepare('SELECT id FROM suppliers WHERE name = ?');
  const insStmt = db.prepare(`INSERT INTO raw_materials (code,name,type,unit,reorder_level,cost_per_unit,supplier_id,active) VALUES (?,?,?,?,?,?,?,?)`);
  const updStmt = db.prepare(`UPDATE raw_materials SET name=?, type=?, unit=?, reorder_level=?, cost_per_unit=?, supplier_id=?, active=? WHERE id=?`);
  const deactStmt = db.prepare(`UPDATE raw_materials SET active=0 WHERE active=1 AND code NOT IN (SELECT value FROM json_each(?))`);

  const trx = db.transaction(() => {
    rows.forEach((r, idx) => {
      try {
        if (!r.name) throw new Error('name is required');
        const code = (r.code || '').trim() || nextCode('raw_materials','code','RM');
        seenCodes.add(code);
        const supplierId = r.supplier ? (findSupplier.get(r.supplier.trim())?.id || null) : null;
        const active = (r.active === '' || r.active === undefined) ? 1 : (parseInt(r.active) ? 1 : 0);
        const existing = findByCode.get(code);
        if (existing) {
          updStmt.run(r.name, r.type||null, r.unit||'MTR', parseFloat(r.reorder_level||0), parseFloat(r.cost_per_unit||0), supplierId, active, existing.id);
          updated++;
        } else {
          insStmt.run(code, r.name, r.type||null, r.unit||'MTR', parseFloat(r.reorder_level||0), parseFloat(r.cost_per_unit||0), supplierId, active);
          inserted++;
        }
      } catch (e) {
        failed++;
        errors.push(`Row ${idx+2}: ${e.message}`);
      }
    });
    if (deactivateMissing && seenCodes.size > 0) {
      const r = deactStmt.run(JSON.stringify([...seenCodes]));
      deactivated = r.changes;
    }
  });
  try { trx(); }
  catch (e) { flash(req,'danger','Import aborted: ' + e.message); return res.redirect('/raw-materials/import'); }

  req.audit('csv_import', 'raw_material', null, `${inserted} new, ${updated} updated, ${deactivated} deactivated, ${failed} failed`);
  const level = failed === 0 ? 'success' : 'warning';
  let msg = `Import done — ${inserted} new, ${updated} updated`;
  if (deactivateMissing) msg += `, ${deactivated} deactivated (not in CSV)`;
  if (failed) msg += `, ${failed} failed: ${errors.slice(0,3).join('; ')}`;
  flash(req, level, msg);
  res.redirect('/raw-materials');
});

router.post('/', upload.single('photo'), (req, res) => {
  const { name, type, unit, current_stock, reorder_level, cost_per_unit, supplier_id } = req.body;
  const code = req.body.code || nextCode('raw_materials','code','RM');
  const imagePath = req.file ? '/uploads/raw_materials/' + req.file.filename : null;
  // Creation is open to everyone with write access — they can set the
  // opening stock when adding the material. After creation, only the
  // owner can change the absolute stock value (see the txn handler).
  db.prepare(`INSERT INTO raw_materials (code,name,type,unit,current_stock,reorder_level,cost_per_unit,supplier_id,image_path) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(code, name, type||null, unit||'MTR', parseFloat(current_stock||0), parseFloat(reorder_level||0), parseFloat(cost_per_unit||0), supplier_id||null, imagePath);
  flash(req,'success','Raw material added.'); res.redirect('/raw-materials');
});

router.get('/:id', (req, res) => {
  const m = db.prepare(`SELECT rm.*, s.name AS supplier_name FROM raw_materials rm LEFT JOIN suppliers s ON s.id=rm.supplier_id WHERE rm.id=?`).get(req.params.id);
  if (!m) return res.redirect('/raw-materials');
  const txns = db.prepare(`SELECT t.*, u.name AS by_name FROM raw_material_txns t LEFT JOIN users u ON u.id=t.created_by WHERE t.raw_material_id=? ORDER BY t.id DESC`).all(req.params.id);
  res.render('rawMaterials/show', { title: m.name, m, txns });
});

router.get('/:id/edit', (req, res) => {
  const m = db.prepare('SELECT * FROM raw_materials WHERE id=?').get(req.params.id);
  const suppliers = db.prepare('SELECT * FROM suppliers WHERE active=1 ORDER BY name').all();
  res.render('rawMaterials/form', { title: 'Edit Raw Material', m, suppliers });
});

router.post('/:id', upload.single('photo'), (req, res) => {
  const { name, type, unit, reorder_level, cost_per_unit, supplier_id, active } = req.body;
  const existing = db.prepare('SELECT image_path FROM raw_materials WHERE id=?').get(req.params.id);
  let imagePath = existing ? existing.image_path : null;
  if (req.file) {
    if (existing && existing.image_path) deletePhotoFile(existing.image_path);
    imagePath = '/uploads/raw_materials/' + req.file.filename;
  }
  db.prepare(`UPDATE raw_materials SET name=?,type=?,unit=?,reorder_level=?,cost_per_unit=?,supplier_id=?,active=?,image_path=? WHERE id=?`)
    .run(name, type||null, unit||'MTR', parseFloat(reorder_level||0), parseFloat(cost_per_unit||0), supplier_id||null, active?1:0, imagePath, req.params.id);
  flash(req,'success','Updated.'); res.redirect('/raw-materials');
});

router.post('/:id/photo/delete', (req, res) => {
  const existing = db.prepare('SELECT image_path FROM raw_materials WHERE id=?').get(req.params.id);
  if (existing && existing.image_path) {
    deletePhotoFile(existing.image_path);
    db.prepare('UPDATE raw_materials SET image_path=NULL WHERE id=?').run(req.params.id);
    flash(req,'success','Photo removed.');
  }
  res.redirect('/raw-materials/' + req.params.id + '/edit');
});

router.post('/:id/txn', (req, res) => {
  const { txn_type, quantity, rate, ref_no, notes } = req.body;
  // "adjustment" sets stock to an absolute value — that's effectively
  // editing the opening stock, so it's owner-only. purchase/issue/return
  // are normal day-to-day operations everyone can do.
  if (txn_type === 'adjustment' && req.session.user.role !== 'owner') {
    flash(req,'danger','Only the owner can directly set stock (adjustment). Use purchase/issue/return for normal stock moves.');
    return res.redirect('/raw-materials/' + req.params.id);
  }
  const qty = parseFloat(quantity);
  const rt = parseFloat(rate||0);
  const total = qty * rt;
  const m = db.prepare('SELECT current_stock FROM raw_materials WHERE id=?').get(req.params.id);
  if (!m) { flash(req,'danger','Not found'); return res.redirect('/raw-materials'); }
  let newStock = m.current_stock;
  if (txn_type === 'purchase' || txn_type === 'return') newStock += qty;
  else if (txn_type === 'issue') newStock -= qty;
  else if (txn_type === 'adjustment') newStock = qty;
  db.prepare(`INSERT INTO raw_material_txns (raw_material_id,txn_type,quantity,rate,total_amount,ref_no,notes,created_by) VALUES (?,?,?,?,?,?,?,?)`)
    .run(req.params.id, txn_type, qty, rt, total, ref_no||null, notes||null, req.session.user.id);
  db.prepare('UPDATE raw_materials SET current_stock=? WHERE id=?').run(newStock, req.params.id);
  flash(req,'success','Transaction recorded.'); res.redirect('/raw-materials/' + req.params.id);
});

// Delete a raw material — owner only. Tries hard delete; if FK constraints
// (in product_bom, purchase_order_items, fabric_cost_calc, etc.) prevent it,
// falls back to soft-delete (active=0) so history is preserved.
router.post('/:id/delete', (req, res) => {
  if (req.session.user.role !== 'owner') {
    flash(req,'danger','Only the owner can delete a raw material.');
    return res.redirect('/raw-materials/' + req.params.id);
  }
  const m = db.prepare('SELECT code, name, image_path FROM raw_materials WHERE id=?').get(req.params.id);
  if (!m) { flash(req,'danger','Not found.'); return res.redirect('/raw-materials'); }
  // Check FK references that would block a hard delete.
  const usedInBom = db.prepare('SELECT COUNT(*) AS n FROM product_bom WHERE raw_material_id=?').get(req.params.id).n;
  const usedInPo  = db.prepare('SELECT COUNT(*) AS n FROM purchase_order_items WHERE raw_material_id=?').get(req.params.id).n;
  const usedInFc  = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='fabric_cost_calc'").get().n
                  ? db.prepare('SELECT COUNT(*) AS n FROM fabric_cost_calc WHERE raw_material_id=?').get(req.params.id).n : 0;
  const refs = usedInBom + usedInPo + usedInFc;
  if (refs > 0) {
    db.prepare('UPDATE raw_materials SET active=0 WHERE id=?').run(req.params.id);
    req.audit('soft_delete', 'raw_material', req.params.id, `${m.code} ${m.name} deactivated (referenced in ${refs} place(s))`);
    flash(req,'warning',`${m.code} is used elsewhere (BOM/POs/fabric-cost), so it was deactivated instead of hard-deleted. Existing records keep working.`);
    return res.redirect('/raw-materials');
  }
  // No references — safe to hard-delete. raw_material_txns FK cascades.
  if (m.image_path) deletePhotoFile(m.image_path);
  db.prepare('DELETE FROM raw_materials WHERE id=?').run(req.params.id);
  req.audit('delete', 'raw_material', req.params.id, `${m.code} ${m.name}`);
  flash(req,'success',`${m.code} ${m.name} deleted.`);
  res.redirect('/raw-materials');
});

module.exports = router;
