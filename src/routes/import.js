const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { db } = require('../db');
const { requireRole, flash } = require('../middleware/auth');
const { nextCode } = require('../utils/codegen');
const router = express.Router();
router.use(requireRole('admin'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.get('/', (req, res) => {
  const log = db.prepare(`SELECT i.*, u.name AS by_name FROM import_log i LEFT JOIN users u ON u.id=i.created_by ORDER BY i.id DESC LIMIT 50`).all();
  res.render('import/index', { title: 'Data Import', log });
});

router.post('/:entity', upload.single('file'), (req, res) => {
  const entity = req.params.entity;
  if (!req.file) { flash(req,'danger','No file uploaded'); return res.redirect('/import'); }
  let rows = [];
  try {
    rows = parse(req.file.buffer.toString('utf-8'), { columns: true, skip_empty_lines: true, trim: true });
  } catch (e) { flash(req,'danger','CSV parse failed: ' + e.message); return res.redirect('/import'); }

  let inserted = 0, failed = 0;
  const errors = [];

  const handlers = {
    products: (r) => {
      const code = r.code || nextCode('products','code','PRD');
      db.prepare(`INSERT INTO products (code,name,unit,mrp,sale_price,cost_price,gst_rate,reorder_level,size,color,hsn_code) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(code, r.name, r.unit||'PCS', parseFloat(r.mrp||0), parseFloat(r.sale_price||0), parseFloat(r.cost_price||0), parseFloat(r.gst_rate||5), parseInt(r.reorder_level||0), r.size||null, r.color||null, r.hsn_code||null);
    },
    dealers: (r) => {
      const code = r.code || nextCode('dealers','code','DLR');
      db.prepare(`INSERT INTO dealers (code,name,contact_person,phone,email,address,city,state,pincode,gstin,credit_limit,opening_balance) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(code, r.name, r.contact_person||null, r.phone||null, r.email||null, r.address||null, r.city||null, r.state||null, r.pincode||null, r.gstin||null, parseFloat(r.credit_limit||0), parseFloat(r.opening_balance||0));
    },
    suppliers: (r) => {
      db.prepare(`INSERT INTO suppliers (name,contact_person,phone,email,address,gstin) VALUES (?,?,?,?,?,?)`)
        .run(r.name, r.contact_person||null, r.phone||null, r.email||null, r.address||null, r.gstin||null);
    },
    raw_materials: (r) => {
      const code = r.code || nextCode('raw_materials','code','RM');
      db.prepare(`INSERT INTO raw_materials (code,name,type,unit,current_stock,reorder_level,cost_per_unit) VALUES (?,?,?,?,?,?,?)`)
        .run(code, r.name, r.type||null, r.unit||'MTR', parseFloat(r.current_stock||0), parseFloat(r.reorder_level||0), parseFloat(r.cost_per_unit||0));
    },
  };

  if (!handlers[entity]) { flash(req,'danger','Unknown entity'); return res.redirect('/import'); }

  rows.forEach((r, idx) => {
    try { handlers[entity](r); inserted++; }
    catch (e) { failed++; errors.push(`Row ${idx+2}: ${e.message}`); }
  });

  db.prepare(`INSERT INTO import_log (entity, filename, total_rows, inserted, failed, errors, created_by) VALUES (?,?,?,?,?,?,?)`)
    .run(entity, req.file.originalname, rows.length, inserted, failed, errors.slice(0,30).join('\n'), req.session.user.id);

  flash(req, failed === 0 ? 'success' : 'warning', `Imported ${inserted}/${rows.length} ${entity} (${failed} failed).`);
  res.redirect('/import');
});

module.exports = router;
