const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { nextCode } = require('../utils/codegen');
const { notifyDispatch } = require('../utils/notify');
const router = express.Router();

function maybeAutoSendDispatchSMS(id) {
  const r = db.prepare(`SELECT value FROM app_settings WHERE key='SMS_AUTO_SEND_DISPATCH'`).get();
  if (r && r.value === 'false') return;
  setImmediate(() => { notifyDispatch(id).catch(e => console.error('[autoSendDispatchSMS]', e.message)); });
}

router.get('/', (req, res) => {
  const from = req.query.from || null, to = req.query.to || null;
  const where = [], params = [];
  if (from) { where.push('d.dispatch_date >= ?'); params.push(from); }
  if (to)   { where.push('d.dispatch_date <= ?'); params.push(to); }
  let sql = `SELECT d.*, dl.name AS dealer_name, i.invoice_no FROM dispatches d JOIN dealers dl ON dl.id=d.dealer_id JOIN invoices i ON i.id=d.invoice_id`;
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY d.id DESC LIMIT 500';
  const items = db.prepare(sql).all(...params);
  res.render('dispatch/index', { title: 'Dispatch', items, from, to });
});

router.get('/new', (req, res) => {
  let invoice = null;
  if (req.query.invoice_id) {
    invoice = db.prepare(`SELECT i.*, d.name AS dealer_name FROM invoices i JOIN dealers d ON d.id=i.dealer_id WHERE i.id=?`).get(req.query.invoice_id);
  }
  const invoices = invoice ? [] : db.prepare(`SELECT i.id, i.invoice_no, i.total, d.name AS dealer_name FROM invoices i JOIN dealers d ON d.id=i.dealer_id WHERE i.status NOT IN ('cancelled') ORDER BY i.id DESC LIMIT 100`).all();
  res.render('dispatch/form', { title: 'New Dispatch', invoice, invoices, dispatch: null });
});

router.get('/:id/edit', (req, res) => {
  const dispatch = db.prepare(`SELECT d.*, i.invoice_no, i.total, dl.name AS dealer_name FROM dispatches d JOIN invoices i ON i.id=d.invoice_id JOIN dealers dl ON dl.id=d.dealer_id WHERE d.id=?`).get(req.params.id);
  if (!dispatch) return res.redirect('/dispatch');
  const invoice = { id: dispatch.invoice_id, invoice_no: dispatch.invoice_no, total: dispatch.total, dealer_name: dispatch.dealer_name };
  res.render('dispatch/form', { title: 'Edit Dispatch ' + dispatch.dispatch_no, invoice, invoices: [], dispatch });
});

router.post('/:id', (req, res) => {
  const { transport_name, vehicle_no, lr_no, freight, dispatch_date, notes } = req.body;
  db.prepare(`UPDATE dispatches SET dispatch_date=?, transport_name=?, vehicle_no=?, lr_no=?, freight=?, notes=? WHERE id=?`)
    .run(dispatch_date, transport_name||null, vehicle_no||null, lr_no||null, parseFloat(freight||0), notes||null, req.params.id);
  flash(req,'success','Updated.'); res.redirect('/dispatch');
});

router.post('/', (req, res) => {
  const { invoice_id, transport_name, vehicle_no, lr_no, freight, dispatch_date, notes } = req.body;
  const inv = db.prepare('SELECT dealer_id FROM invoices WHERE id=?').get(invoice_id);
  if (!inv) { flash(req,'danger','Invoice not found'); return res.redirect('/dispatch/new'); }
  const dispatch_no = nextCode('dispatches','dispatch_no','DSP');
  const r = db.prepare(`INSERT INTO dispatches (dispatch_no,invoice_id,dealer_id,dispatch_date,transport_name,vehicle_no,lr_no,freight,notes,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(dispatch_no, invoice_id, inv.dealer_id, dispatch_date, transport_name||null, vehicle_no||null, lr_no||null, parseFloat(freight||0), notes||null, req.session.user.id);
  db.prepare("UPDATE sales_orders SET status='dispatched' WHERE id=(SELECT sales_order_id FROM invoices WHERE id=?) AND status='invoiced'").run(invoice_id);
  flash(req,'success','Dispatched: ' + dispatch_no);
  maybeAutoSendDispatchSMS(r.lastInsertRowid);
  res.redirect('/dispatch');
});

router.post('/:id/status', (req, res) => {
  const { status } = req.body;
  const fields = ['status=?']; const vals = [status];
  if (status === 'delivered') { fields.push("delivered_date=date('now')"); }
  vals.push(req.params.id);
  db.prepare(`UPDATE dispatches SET ${fields.join(',')} WHERE id=?`).run(...vals);
  flash(req,'success','Updated.'); res.redirect('/dispatch');
});

// ── One-click dispatch from the Route Plan sheet ────────────────────────
// "Mark dispatched": for each picked dealer, create a dispatch for every
// invoice of theirs that hasn't been dispatched yet (loading the vehicle).
router.post('/route/dispatched', (req, res) => {
  const ids = String(req.body.dealer_ids || '').split(',').map(x => parseInt(x)).filter(Boolean);
  const transport = (req.body.transport_name || '').trim() || null;
  const vehicle = (req.body.vehicle_no || '').trim() || null;
  const back = req.body.back || '/visits/plan?mode=dispatch&source=pending';
  if (!ids.length) { flash(req, 'danger', 'No dealers selected.'); return res.redirect(back); }
  const pend = db.prepare(`SELECT id FROM invoices WHERE dealer_id=? AND status!='cancelled' AND NOT EXISTS (SELECT 1 FROM dispatches d WHERE d.invoice_id=invoices.id)`);
  const insDsp = db.prepare(`INSERT INTO dispatches (dispatch_no,invoice_id,dealer_id,dispatch_date,transport_name,vehicle_no,created_by) VALUES (?,?,?,date('now'),?,?,?)`);
  const updSO = db.prepare("UPDATE sales_orders SET status='dispatched' WHERE id=(SELECT sales_order_id FROM invoices WHERE id=?) AND status='invoiced'");
  const newIds = []; let dealersDone = 0;
  db.transaction(() => {
    ids.forEach(did => {
      const invs = pend.all(did);
      if (invs.length) dealersDone++;
      invs.forEach(inv => {
        const no = nextCode('dispatches', 'dispatch_no', 'DSP');
        const r = insDsp.run(no, inv.id, did, transport, vehicle, req.session.user.id);
        updSO.run(inv.id);
        newIds.push(r.lastInsertRowid);
      });
    });
  })();
  newIds.forEach(id => maybeAutoSendDispatchSMS(id));
  req.audit('route_dispatch', 'dispatch', null, `marked dispatched: ${newIds.length} invoice(s) for ${dealersDone} dealer(s)${vehicle ? ' · veh ' + vehicle : ''}`);
  flash(req, newIds.length ? 'success' : 'info', newIds.length
    ? `Marked dispatched: ${newIds.length} invoice${newIds.length > 1 ? 's' : ''} across ${dealersDone} dealer${dealersDone > 1 ? 's' : ''}.`
    : 'Nothing to dispatch — those invoices are already dispatched.');
  res.redirect(back);
});

// "Mark delivered": for each picked dealer, close out their open dispatches.
router.post('/route/delivered', (req, res) => {
  const ids = String(req.body.dealer_ids || '').split(',').map(x => parseInt(x)).filter(Boolean);
  const back = req.body.back || '/visits/plan?mode=dispatch&source=transit';
  if (!ids.length) { flash(req, 'danger', 'No dealers selected.'); return res.redirect(back); }
  const upd = db.prepare("UPDATE dispatches SET status='delivered', delivered_date=date('now') WHERE dealer_id=? AND status='dispatched' AND (delivered_date IS NULL OR delivered_date='')");
  let n = 0;
  db.transaction(() => { ids.forEach(did => { n += upd.run(did).changes; }); })();
  req.audit('route_deliver', 'dispatch', null, `marked delivered: ${n} dispatch(es) across ${ids.length} dealer(s)`);
  flash(req, n ? 'success' : 'info', n ? `Marked delivered: ${n} dispatch${n > 1 ? 'es' : ''}.` : 'Nothing open to mark delivered.');
  res.redirect(back);
});

module.exports = router;
