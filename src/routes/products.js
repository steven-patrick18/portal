const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { nextCode } = require('../utils/codegen');

const router = express.Router();

router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  let sql = `SELECT p.*, c.name AS category_name, COALESCE(rs.quantity,0) AS stock_qty
             FROM products p LEFT JOIN product_categories c ON c.id = p.category_id
             LEFT JOIN ready_stock rs ON rs.product_id = p.id`;
  const params = [];
  if (q) { sql += ' WHERE p.code LIKE ? OR p.name LIKE ?'; params.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY p.id DESC';
  const products = db.prepare(sql).all(...params);
  res.render('products/index', { title: 'Products', products, q });
});

router.get('/new', (req, res) => {
  const cats = db.prepare('SELECT * FROM product_categories ORDER BY name').all();
  res.render('products/form', { title: 'New Product', p: null, cats });
});

router.post('/', (req, res) => {
  try {
    const { name, category_id, hsn_code, size, color, unit, mrp, sale_price, cost_price, gst_rate, reorder_level } = req.body;
    const code = req.body.code || nextCode('products', 'code', 'PRD');
    const stmt = db.prepare(`INSERT INTO products (code,name,category_id,hsn_code,size,color,unit,mrp,sale_price,cost_price,gst_rate,reorder_level)
                             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    const r = stmt.run(code, name, category_id || null, hsn_code || null, size || null, color || null, unit || 'PCS',
      parseFloat(mrp||0), parseFloat(sale_price||0), parseFloat(cost_price||0), parseFloat(gst_rate||5), parseInt(reorder_level||0));
    db.prepare('INSERT OR IGNORE INTO ready_stock (product_id, quantity) VALUES (?,0)').run(r.lastInsertRowid);
    flash(req, 'success', 'Product created.');
    res.redirect('/products');
  } catch (e) { flash(req, 'danger', e.message); res.redirect('/products/new'); }
});

router.get('/:id/edit', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p) return res.redirect('/products');
  const cats = db.prepare('SELECT * FROM product_categories ORDER BY name').all();
  res.render('products/form', { title: 'Edit Product', p, cats });
});

router.post('/:id', (req, res) => {
  const { name, category_id, hsn_code, size, color, unit, mrp, sale_price, cost_price, gst_rate, reorder_level, active } = req.body;
  db.prepare(`UPDATE products SET name=?, category_id=?, hsn_code=?, size=?, color=?, unit=?, mrp=?, sale_price=?, cost_price=?, gst_rate=?, reorder_level=?, active=?, updated_at=datetime('now') WHERE id=?`)
    .run(name, category_id || null, hsn_code || null, size || null, color || null, unit || 'PCS',
      parseFloat(mrp||0), parseFloat(sale_price||0), parseFloat(cost_price||0), parseFloat(gst_rate||5), parseInt(reorder_level||0),
      active ? 1 : 0, req.params.id);
  flash(req, 'success', 'Product updated.'); res.redirect('/products');
});

module.exports = router;
