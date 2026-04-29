const express = require('express');
const { db } = require('../db');
const { requireRole, flash } = require('../middleware/auth');
const router = express.Router();
router.use(requireRole('admin'));

router.get('/', (req, res) => {
  const cats = db.prepare('SELECT * FROM product_categories ORDER BY name').all();
  res.render('categories/index', { title: 'Product Categories', cats });
});
router.post('/', (req, res) => {
  try { db.prepare('INSERT INTO product_categories (name) VALUES (?)').run(req.body.name); flash(req,'success','Added.'); }
  catch (e) { flash(req,'danger',e.message); }
  res.redirect('/categories');
});
router.post('/:id/delete', (req, res) => {
  try { db.prepare('DELETE FROM product_categories WHERE id=?').run(req.params.id); flash(req,'success','Deleted.'); }
  catch (e) { flash(req,'danger',e.message); }
  res.redirect('/categories');
});
module.exports = router;
