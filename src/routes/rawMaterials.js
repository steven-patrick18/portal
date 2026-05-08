const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { nextCode } = require('../utils/codegen');
const router = express.Router();

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

router.post('/', upload.single('photo'), (req, res) => {
  const { name, type, unit, current_stock, reorder_level, cost_per_unit, supplier_id } = req.body;
  const code = req.body.code || nextCode('raw_materials','code','RM');
  const imagePath = req.file ? '/uploads/raw_materials/' + req.file.filename : null;
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

module.exports = router;
