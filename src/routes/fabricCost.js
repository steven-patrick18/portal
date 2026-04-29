const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const router = express.Router();

router.get('/', (req, res) => {
  const items = db.prepare(`
    SELECT f.*, p.name AS product_name, p.code AS product_code, rm.name AS material_name, rm.unit AS unit
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
  res.render('fabricCost/form', { title: 'New Fabric Cost', products, materials });
});

router.post('/', (req, res) => {
  const { product_id, raw_material_id, fabric_used_meters, pieces_cut, notes } = req.body;
  const fab = parseFloat(fabric_used_meters);
  const pcs = parseInt(pieces_cut);
  const rm = db.prepare('SELECT cost_per_unit FROM raw_materials WHERE id=?').get(raw_material_id);
  const fabricCostTotal = fab * (rm ? rm.cost_per_unit : 0);
  const fabricCostPerPiece = pcs > 0 ? fabricCostTotal / pcs : 0;
  // Efficiency = (theoretical pieces / actual pieces) * 100, but here we treat efficiency as pcs/fabUsed metric
  // Use a simple metric: efficiency = pcs / fab (pieces per metre); store ratio so the planner can compare
  const efficiency = fab > 0 ? (pcs / fab) * 100 : 0;
  db.prepare(`INSERT INTO fabric_cost_calc (product_id,raw_material_id,fabric_used_meters,pieces_cut,efficiency_percent,fabric_cost_per_piece,notes,created_by)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(product_id, raw_material_id, fab, pcs, efficiency, fabricCostPerPiece, notes||null, req.session.user.id);
  flash(req,'success','Recorded.');
  res.redirect('/fabric-cost');
});

module.exports = router;
