const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const router = express.Router();

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

router.get('/movements', (req, res) => {
  const items = db.prepare(`
    SELECT sm.*, p.code AS product_code, p.name AS product_name, u.name AS by_name
    FROM stock_movements sm JOIN products p ON p.id=sm.product_id
    LEFT JOIN users u ON u.id=sm.created_by
    ORDER BY sm.id DESC LIMIT 200
  `).all();
  res.render('stock/movements', { title: 'Stock Movements', items });
});

router.post('/adjust', (req, res) => {
  const { product_id, quantity, notes } = req.body;
  const qty = parseInt(quantity);
  db.prepare(`INSERT INTO ready_stock (product_id, quantity) VALUES (?,?) ON CONFLICT(product_id) DO UPDATE SET quantity=excluded.quantity, updated_at=datetime('now')`).run(product_id, qty);
  db.prepare(`INSERT INTO stock_movements (product_id, movement_type, quantity, notes, created_by) VALUES (?,?,?,?,?)`)
    .run(product_id, 'adjustment', qty, notes||null, req.session.user.id);
  flash(req,'success','Adjusted.'); res.redirect('/stock');
});

module.exports = router;
