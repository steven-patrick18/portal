const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { nextCode } = require('../utils/codegen');
const router = express.Router();

router.get('/', (req, res) => {
  const items = db.prepare(`SELECT d.*, dl.name AS dealer_name, i.invoice_no FROM dispatches d JOIN dealers dl ON dl.id=d.dealer_id JOIN invoices i ON i.id=d.invoice_id ORDER BY d.id DESC LIMIT 200`).all();
  res.render('dispatch/index', { title: 'Dispatch', items });
});

router.get('/new', (req, res) => {
  let invoice = null;
  if (req.query.invoice_id) {
    invoice = db.prepare(`SELECT i.*, d.name AS dealer_name FROM invoices i JOIN dealers d ON d.id=i.dealer_id WHERE i.id=?`).get(req.query.invoice_id);
  }
  const invoices = invoice ? [] : db.prepare(`SELECT i.id, i.invoice_no, i.total, d.name AS dealer_name FROM invoices i JOIN dealers d ON d.id=i.dealer_id WHERE i.status NOT IN ('cancelled') ORDER BY i.id DESC LIMIT 100`).all();
  res.render('dispatch/form', { title: 'New Dispatch', invoice, invoices });
});

router.post('/', (req, res) => {
  const { invoice_id, transport_name, vehicle_no, lr_no, freight, dispatch_date, notes } = req.body;
  const inv = db.prepare('SELECT dealer_id FROM invoices WHERE id=?').get(invoice_id);
  if (!inv) { flash(req,'danger','Invoice not found'); return res.redirect('/dispatch/new'); }
  const dispatch_no = nextCode('dispatches','dispatch_no','DSP');
  db.prepare(`INSERT INTO dispatches (dispatch_no,invoice_id,dealer_id,dispatch_date,transport_name,vehicle_no,lr_no,freight,notes,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(dispatch_no, invoice_id, inv.dealer_id, dispatch_date, transport_name||null, vehicle_no||null, lr_no||null, parseFloat(freight||0), notes||null, req.session.user.id);
  db.prepare("UPDATE sales_orders SET status='dispatched' WHERE id=(SELECT sales_order_id FROM invoices WHERE id=?) AND status='invoiced'").run(invoice_id);
  flash(req,'success','Dispatched: ' + dispatch_no); res.redirect('/dispatch');
});

router.post('/:id/status', (req, res) => {
  const { status } = req.body;
  const fields = ['status=?']; const vals = [status];
  if (status === 'delivered') { fields.push("delivered_date=date('now')"); }
  vals.push(req.params.id);
  db.prepare(`UPDATE dispatches SET ${fields.join(',')} WHERE id=?`).run(...vals);
  flash(req,'success','Updated.'); res.redirect('/dispatch');
});

module.exports = router;
