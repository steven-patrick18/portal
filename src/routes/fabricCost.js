const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const router = express.Router();

// Compute the four numbers: total cost, fabric/piece, cost/piece, efficiency
function computeFabric({ meters, pieces, wastage_pct, rate }) {
  meters = parseFloat(meters || 0);
  pieces = parseInt(pieces || 0);
  wastage_pct = parseFloat(wastage_pct || 0);
  rate = parseFloat(rate || 0);
  // Effective metres consumed = metres on table (the wastage is part of what was put on the table)
  const totalCost = meters * rate;
  const fabricPerPiece = pieces > 0 ? meters / pieces : 0;
  // Cost per piece reflects ALL fabric used, including wastage allocated to each piece
  const costPerPiece = fabricPerPiece * rate;
  // Efficiency: net pieces / theoretical (assume theoretical = pieces / (1 - wastage/100))
  // Or simpler: pieces per metre (higher = better)
  const efficiency = meters > 0 ? (pieces / meters) * 100 : 0;
  return { totalCost, fabricPerPiece, costPerPiece, efficiency };
}

router.get('/', (req, res) => {
  const items = db.prepare(`
    SELECT f.*, p.name AS product_name, p.code AS product_code, rm.name AS material_name, rm.unit AS unit, rm.cost_per_unit
    FROM fabric_cost_calc f
    JOIN products p ON p.id=f.product_id
    JOIN raw_materials rm ON rm.id=f.raw_material_id
    ORDER BY f.id DESC
  `).all();
  res.render('fabricCost/index', { title: 'Fabric Cost Calculation', items });
});

router.get('/new', (req, res) => {
  const products = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY name').all();
  const materials = db.prepare("SELECT * FROM raw_materials WHERE active=1 ORDER BY name").all();
  res.render('fabricCost/form', { title: 'New Fabric Cost', products, materials, f: null });
});

router.post('/', (req, res) => {
  const { product_id, raw_material_id, fabric_used_meters, pieces_cut, wastage_percent, calc_date, notes } = req.body;
  const rm = db.prepare('SELECT cost_per_unit FROM raw_materials WHERE id=?').get(raw_material_id);
  const { totalCost, costPerPiece, efficiency } = computeFabric({ meters: fabric_used_meters, pieces: pieces_cut, wastage_pct: wastage_percent, rate: rm.cost_per_unit });
  db.prepare(`INSERT INTO fabric_cost_calc (product_id,raw_material_id,fabric_used_meters,pieces_cut,wastage_percent,efficiency_percent,fabric_cost_per_piece,total_fabric_cost,notes,calc_date,created_by)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(product_id, raw_material_id, parseFloat(fabric_used_meters), parseInt(pieces_cut), parseFloat(wastage_percent || 0), efficiency, costPerPiece, totalCost, notes || null, calc_date || new Date().toISOString().slice(0, 10), req.session.user.id);
  flash(req, 'success', 'Fabric cost calculated and saved.');
  res.redirect('/fabric-cost');
});

router.get('/:id/edit', (req, res) => {
  const f = db.prepare('SELECT * FROM fabric_cost_calc WHERE id=?').get(req.params.id);
  if (!f) return res.redirect('/fabric-cost');
  const products = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY name').all();
  const materials = db.prepare("SELECT * FROM raw_materials WHERE active=1 ORDER BY name").all();
  res.render('fabricCost/form', { title: 'Edit Fabric Cost', products, materials, f });
});

router.post('/:id', (req, res) => {
  const { product_id, raw_material_id, fabric_used_meters, pieces_cut, wastage_percent, calc_date, notes } = req.body;
  const rm = db.prepare('SELECT cost_per_unit FROM raw_materials WHERE id=?').get(raw_material_id);
  const { totalCost, costPerPiece, efficiency } = computeFabric({ meters: fabric_used_meters, pieces: pieces_cut, wastage_pct: wastage_percent, rate: rm.cost_per_unit });
  db.prepare(`UPDATE fabric_cost_calc SET product_id=?, raw_material_id=?, fabric_used_meters=?, pieces_cut=?, wastage_percent=?, efficiency_percent=?, fabric_cost_per_piece=?, total_fabric_cost=?, notes=?, calc_date=? WHERE id=?`)
    .run(product_id, raw_material_id, parseFloat(fabric_used_meters), parseInt(pieces_cut), parseFloat(wastage_percent || 0), efficiency, costPerPiece, totalCost, notes || null, calc_date || new Date().toISOString().slice(0, 10), req.params.id);
  flash(req, 'success', 'Fabric cost updated.');
  res.redirect('/fabric-cost');
});

router.post('/:id/delete', (req, res) => {
  db.prepare('DELETE FROM fabric_cost_calc WHERE id=?').run(req.params.id);
  flash(req, 'success', 'Deleted.');
  res.redirect('/fabric-cost');
});

module.exports = router;
