// Website module — manage the public marketing site (sharvexport.com)
// content from inside the ERP. Edits site_content + site_products +
// site_certifications; the public /site route renders from them.
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const router = express.Router();

const UP_ROOT = path.join(__dirname, '..', '..', 'public', 'uploads', 'website');
function upDir() { if (!fs.existsSync(UP_ROOT)) fs.mkdirSync(UP_ROOT, { recursive: true }); return UP_ROOT; }
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, upDir()),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg';
      cb(null, (file.fieldname || 'img') + '_' + Date.now() + '_' + require('crypto').randomBytes(3).toString('hex') + ext);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//i.test(file.mimetype)),
});
const rel = (p) => '/uploads/website/' + path.relative(UP_ROOT, p).replace(/\\/g, '/');

function content() {
  return db.prepare('SELECT * FROM site_content WHERE id=1').get() || {};
}

router.get('/', (req, res) => {
  const c = content();
  const products = db.prepare('SELECT * FROM site_products ORDER BY sort, id').all();
  const certs = db.prepare('SELECT * FROM site_certifications ORDER BY sort, id').all();
  res.render('website/index', { title: 'Website', c, products, certs });
});

// Save the main content / branding / contact / socials / SEO.
router.post('/content', (req, res) => {
  const f = req.body;
  db.prepare(`UPDATE site_content SET
    company_name=?, tagline=?, hero_title=?, hero_subtitle=?, hero_cta_text=?, hero_video_url=?,
    about_title=?, about_html=?, stats_json=?, why_json=?, process_json=?,
    phone=?, email=?, whatsapp=?, address=?,
    instagram=?, linkedin=?, facebook=?, youtube=?,
    meta_title=?, meta_desc=?, published=?, updated_by=?, updated_at=datetime('now')
    WHERE id=1`)
    .run(
      f.company_name||null, f.tagline||null, f.hero_title||null, f.hero_subtitle||null, f.hero_cta_text||null, f.hero_video_url||null,
      f.about_title||null, f.about_html||null, f.stats_json||null, f.why_json||null, f.process_json||null,
      f.phone||null, f.email||null, f.whatsapp||null, f.address||null,
      f.instagram||null, f.linkedin||null, f.facebook||null, f.youtube||null,
      f.meta_title||null, f.meta_desc||null, f.published ? 1 : 0, req.session.user.id);
  req.audit('update', 'website', 1, 'site content updated');
  flash(req, 'success', 'Website content saved. Open "View Public Site" to see it.');
  res.redirect('/website');
});

// ── Products ──────────────────────────────────────────────────
router.post('/products', upload.single('image'), (req, res) => {
  const f = req.body;
  if (!f.name || !f.name.trim()) { flash(req,'danger','Product name required.'); return res.redirect('/website'); }
  const img = req.file ? rel(req.file.path) : null;
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort),0)+1 AS s FROM site_products').get().s;
  db.prepare('INSERT INTO site_products (name, tagline, image_path, sort) VALUES (?,?,?,?)')
    .run(f.name.trim(), f.tagline||null, img, maxSort);
  flash(req,'success','Product added.');
  res.redirect('/website');
});
router.post('/products/:id', upload.single('image'), (req, res) => {
  const p = db.prepare('SELECT * FROM site_products WHERE id=?').get(req.params.id);
  if (!p) return res.redirect('/website');
  const f = req.body;
  const img = req.file ? rel(req.file.path) : p.image_path;
  db.prepare('UPDATE site_products SET name=?, tagline=?, image_path=?, active=? WHERE id=?')
    .run(f.name||p.name, f.tagline||null, img, f.active ? 1 : 0, p.id);
  flash(req,'success','Product updated.');
  res.redirect('/website');
});
router.post('/products/:id/delete', (req, res) => {
  db.prepare('DELETE FROM site_products WHERE id=?').run(req.params.id);
  flash(req,'success','Product removed.');
  res.redirect('/website');
});

// ── Certifications ────────────────────────────────────────────
router.post('/certifications', upload.single('image'), (req, res) => {
  const f = req.body;
  if (!f.name || !f.name.trim()) { flash(req,'danger','Certification name required.'); return res.redirect('/website'); }
  const img = req.file ? rel(req.file.path) : null;
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort),0)+1 AS s FROM site_certifications').get().s;
  db.prepare('INSERT INTO site_certifications (name, image_path, sort) VALUES (?,?,?)')
    .run(f.name.trim(), img, maxSort);
  flash(req,'success','Certification added.');
  res.redirect('/website');
});
router.post('/certifications/:id', upload.single('image'), (req, res) => {
  const ct = db.prepare('SELECT * FROM site_certifications WHERE id=?').get(req.params.id);
  if (!ct) return res.redirect('/website');
  const f = req.body;
  const img = req.file ? rel(req.file.path) : ct.image_path;
  db.prepare('UPDATE site_certifications SET name=?, image_path=?, active=? WHERE id=?')
    .run(f.name||ct.name, img, f.active ? 1 : 0, ct.id);
  flash(req,'success','Certification updated.');
  res.redirect('/website');
});
router.post('/certifications/:id/delete', (req, res) => {
  db.prepare('DELETE FROM site_certifications WHERE id=?').run(req.params.id);
  flash(req,'success','Certification removed.');
  res.redirect('/website');
});

module.exports = router;
