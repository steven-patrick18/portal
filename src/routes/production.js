const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { nextCode } = require('../utils/codegen');
const router = express.Router();

const STAGES = ['cutting','stitching','washing','finishing','packing'];

router.get('/', (req, res) => {
  const status = req.query.status || 'all';
  let sql = `SELECT b.*, p.name AS product_name, p.code AS product_code FROM production_batches b JOIN products p ON p.id=b.product_id`;
  const params = [];
  if (status !== 'all') { sql += ' WHERE b.status=?'; params.push(status); }
  sql += ' ORDER BY b.id DESC';
  const batches = db.prepare(sql).all(...params);
  res.render('production/index', { title: 'Production Batches', batches, status });
});

router.get('/new', (req, res) => {
  const products = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY name').all();
  res.render('production/form', { title: 'New Batch', products });
});

router.post('/', (req, res) => {
  const { product_id, qty_planned, notes } = req.body;
  const batch_no = nextCode('production_batches','batch_no','BATCH');
  db.prepare(`INSERT INTO production_batches (batch_no,product_id,qty_planned,notes,created_by) VALUES (?,?,?,?,?)`)
    .run(batch_no, product_id, parseInt(qty_planned), notes||null, req.session.user.id);
  flash(req,'success','Batch created: ' + batch_no);
  res.redirect('/production');
});

router.get('/:id', (req, res) => {
  const b = db.prepare(`SELECT b.*, p.name AS product_name, p.code AS product_code FROM production_batches b JOIN products p ON p.id=b.product_id WHERE b.id=?`).get(req.params.id);
  if (!b) return res.redirect('/production');
  const entries = db.prepare(`SELECT e.*, u.name AS by_name FROM production_stage_entries e LEFT JOIN users u ON u.id=e.created_by WHERE e.batch_id=? ORDER BY e.id`).all(req.params.id);
  // Compute stage totals
  const stageTotals = {};
  STAGES.forEach(s => { stageTotals[s] = { in:0, out:0, rej:0 }; });
  entries.forEach(e => { stageTotals[e.stage].in += e.qty_in; stageTotals[e.stage].out += e.qty_out; stageTotals[e.stage].rej += e.qty_rejected; });
  res.render('production/show', { title: 'Batch ' + b.batch_no, b, entries, stages: STAGES, stageTotals });
});

router.post('/:id/stage', (req, res) => {
  const { stage, qty_in, qty_out, qty_rejected, worker_name, rate_per_piece, entry_date, notes } = req.body;
  if (!STAGES.includes(stage)) { flash(req,'danger','Invalid stage'); return res.redirect('/production/'+req.params.id); }
  const qIn = parseInt(qty_in||0), qOut = parseInt(qty_out||0), qRej = parseInt(qty_rejected||0);
  const rate = parseFloat(rate_per_piece||0);
  const total = qOut * rate;
  db.prepare(`INSERT INTO production_stage_entries (batch_id,stage,qty_in,qty_out,qty_rejected,worker_name,rate_per_piece,total_cost,entry_date,notes,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.params.id, stage, qIn, qOut, qRej, worker_name||null, rate, total, entry_date||new Date().toISOString().slice(0,10), notes||null, req.session.user.id);
  // If packing, increment ready stock
  if (stage === 'packing' && qOut > 0) {
    const b = db.prepare('SELECT product_id FROM production_batches WHERE id=?').get(req.params.id);
    db.prepare(`INSERT INTO ready_stock (product_id, quantity) VALUES (?,?) ON CONFLICT(product_id) DO UPDATE SET quantity = quantity + excluded.quantity, updated_at=datetime('now')`).run(b.product_id, qOut);
    db.prepare(`INSERT INTO stock_movements (product_id, movement_type, quantity, ref_table, ref_id, created_by) VALUES (?,?,?,?,?,?)`)
      .run(b.product_id, 'production_in', qOut, 'production_batches', req.params.id, req.session.user.id);
    db.prepare(`UPDATE production_batches SET qty_completed = qty_completed + ?, current_stage = ? WHERE id=?`).run(qOut, 'packing', req.params.id);
  } else {
    db.prepare(`UPDATE production_batches SET current_stage = ? WHERE id=?`).run(stage, req.params.id);
  }
  flash(req,'success','Stage entry recorded.');
  res.redirect('/production/'+req.params.id);
});

router.post('/:id/complete', (req, res) => {
  db.prepare(`UPDATE production_batches SET status='completed', end_date=date('now') WHERE id=?`).run(req.params.id);
  flash(req,'success','Batch marked complete.'); res.redirect('/production/'+req.params.id);
});

module.exports = router;
