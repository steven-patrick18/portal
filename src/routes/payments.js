const express = require('express');
const { db } = require('../db');
const { flash, requireRole } = require('../middleware/auth');
const { nextCode } = require('../utils/codegen');
const { notifyPayment } = require('../utils/notify');
const router = express.Router();

// Helper: fire-and-forget the auto SMS on a verified payment, if enabled.
// Doesn't await so a slow gateway can never delay the route response.
function maybeAutoSendPaymentSMS(paymentId) {
  const setting = db.prepare(`SELECT value FROM app_settings WHERE key='SMS_AUTO_SEND_PAYMENT'`).get();
  // Default to ON if the user hasn't toggled it (set === undefined OR value !== 'false').
  if (setting && setting.value === 'false') return;
  // Run after the response is on the wire so we never block.
  setImmediate(() => { notifyPayment(paymentId).catch(e => console.error('[autoSendPaymentSMS]', e.message)); });
}

router.get('/', (req, res) => {
  const status = req.query.status || 'all';
  const dealerId = req.query.dealer_id;
  let sql = `SELECT p.*, d.name AS dealer_name, u.name AS sp_name, pm.name AS mode FROM payments p JOIN dealers d ON d.id=p.dealer_id LEFT JOIN users u ON u.id=p.salesperson_id LEFT JOIN payment_modes pm ON pm.id=p.payment_mode_id`;
  const params = []; const where = [];
  if (status !== 'all') { where.push('p.status=?'); params.push(status); }
  if (dealerId) { where.push('p.dealer_id=?'); params.push(dealerId); }
  if (req.session.user.role === 'salesperson') { where.push('p.salesperson_id=?'); params.push(req.session.user.id); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY p.id DESC LIMIT 200';
  const items = db.prepare(sql).all(...params);
  let dealerName = null;
  if (dealerId) {
    const d = db.prepare('SELECT name FROM dealers WHERE id=?').get(dealerId);
    dealerName = d ? d.name : null;
  }
  res.render('payments/index', { title: 'Payments', items, status, dealerId, dealerName });
});

router.get('/new', (req, res) => {
  const dealers = db.prepare('SELECT * FROM dealers WHERE active=1 ORDER BY name').all();
  const modes = db.prepare('SELECT * FROM payment_modes WHERE active=1 ORDER BY name').all();
  let invoices = [];
  if (req.query.dealer_id) {
    invoices = db.prepare(`SELECT id, invoice_no, total, paid_amount, invoice_date FROM invoices WHERE dealer_id=? AND status IN ('unpaid','partial') ORDER BY id DESC`).all(req.query.dealer_id);
  }
  res.render('payments/form', { title: 'Receive Payment', dealers, modes, invoices, preDealer: req.query.dealer_id, preInvoice: req.query.invoice_id });
});

router.get('/dealer/:dealerId/invoices', (req, res) => {
  const invoices = db.prepare(`SELECT id, invoice_no, total, paid_amount, invoice_date FROM invoices WHERE dealer_id=? AND status IN ('unpaid','partial') ORDER BY id DESC`).all(req.params.dealerId);
  res.json(invoices);
});

router.post('/', (req, res) => {
  const { dealer_id, invoice_id, amount, payment_mode_id, payment_date, reference_no, remarks, lat, lng } = req.body;
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) { flash(req,'danger','Invalid amount'); return res.redirect('/payments/new'); }

  // Fraud control
  const fraudFlags = [];
  // 1. Duplicate amount + dealer + ref within last 24h
  if (reference_no) {
    const dup = db.prepare(`SELECT id FROM payments WHERE dealer_id=? AND amount=? AND reference_no=? AND created_at >= datetime('now','-1 day')`).get(dealer_id, amt, reference_no);
    if (dup) fraudFlags.push('Duplicate ref+amount within 24h');
  }
  // 2. Amount exceeds invoice balance
  if (invoice_id) {
    const inv = db.prepare('SELECT total, paid_amount FROM invoices WHERE id=?').get(invoice_id);
    if (inv && amt > (inv.total - inv.paid_amount + 0.01)) fraudFlags.push('Amount exceeds invoice balance');
  }
  // 3. Salesperson not assigned to dealer
  if (req.session.user.role === 'salesperson') {
    const d = db.prepare('SELECT salesperson_id FROM dealers WHERE id=?').get(dealer_id);
    if (d && d.salesperson_id && d.salesperson_id !== req.session.user.id) fraudFlags.push('Dealer not assigned to this salesperson');
  }

  const payment_no = nextCode('payments','payment_no','PMT');
  const status = req.session.user.role === 'salesperson' ? 'pending' : (fraudFlags.length ? 'pending' : 'verified');
  const verified_by = status === 'verified' ? req.session.user.id : null;
  const verified_at = status === 'verified' ? new Date().toISOString() : null;
  const remarksFinal = (remarks || '') + (fraudFlags.length ? '\n[FRAUD-FLAGS] ' + fraudFlags.join('; ') : '');

  const trx = db.transaction(() => {
    const r = db.prepare(`INSERT INTO payments (payment_no,dealer_id,invoice_id,salesperson_id,payment_date,amount,payment_mode_id,reference_no,remarks,status,verified_by,verified_at,collected_lat,collected_lng,device_info,ip,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(payment_no, dealer_id, invoice_id||null, req.session.user.id, payment_date, amt, payment_mode_id||null, reference_no||null, remarksFinal, status, verified_by, verified_at, lat||null, lng||null, req.headers['user-agent']||null, req.ip, req.session.user.id);
    if (status === 'verified' && invoice_id) applyToInvoice(invoice_id, amt);
    return r.lastInsertRowid;
  });
  const id = trx();
  req.audit('create', 'payment', id, `${payment_no} · ₹${amt} · dealer #${dealer_id}${fraudFlags.length ? ' · FLAGS: ' + fraudFlags.join(', ') : ''}`);
  flash(req, fraudFlags.length ? 'warning' : 'success', `Payment ${payment_no} recorded${fraudFlags.length ? ' (flagged for review)' : ''}.`);
  // If the payment went straight to 'verified' (admin/accountant created it
  // and no fraud flags), fire the auto-SMS. Pending payments wait for /verify.
  if (status === 'verified') maybeAutoSendPaymentSMS(id);
  res.redirect('/payments/' + id);
});

router.get('/:id', (req, res) => {
  const p = db.prepare(`SELECT p.*, d.name AS dealer_name, u.name AS sp_name, pm.name AS mode, vu.name AS verified_by_name, i.invoice_no FROM payments p JOIN dealers d ON d.id=p.dealer_id LEFT JOIN users u ON u.id=p.salesperson_id LEFT JOIN payment_modes pm ON pm.id=p.payment_mode_id LEFT JOIN users vu ON vu.id=p.verified_by LEFT JOIN invoices i ON i.id=p.invoice_id WHERE p.id=?`).get(req.params.id);
  if (!p) return res.redirect('/payments');
  res.render('payments/show', { title: 'Payment ' + p.payment_no, p });
});

router.post('/:id/verify', requireRole('admin','accountant'), (req, res) => {
  const p = db.prepare('SELECT * FROM payments WHERE id=?').get(req.params.id);
  if (!p || p.status !== 'pending') { flash(req,'danger','Cannot verify'); return res.redirect('/payments/' + req.params.id); }
  const trx = db.transaction(() => {
    db.prepare(`UPDATE payments SET status='verified', verified_by=?, verified_at=datetime('now') WHERE id=?`).run(req.session.user.id, req.params.id);
    if (p.invoice_id) applyToInvoice(p.invoice_id, p.amount);
  });
  trx();
  req.audit('verify', 'payment', req.params.id, `Verified ₹${p.amount}, applied to invoice #${p.invoice_id || '-'}`);
  maybeAutoSendPaymentSMS(req.params.id);
  flash(req,'success','Verified — auto-SMS dispatched if enabled.'); res.redirect('/payments/' + req.params.id);
});

// Edit allowed only while pending — verified/rejected payments are locked
// because they affect invoice paid_amount and status.
router.get('/:id/edit', (req, res) => {
  const p = db.prepare('SELECT * FROM payments WHERE id=?').get(req.params.id);
  if (!p) return res.redirect('/payments');
  if (p.status !== 'pending') { flash(req,'danger','Only pending payments can be edited'); return res.redirect('/payments/' + p.id); }
  if (req.session.user.role === 'salesperson' && p.created_by !== req.session.user.id) {
    flash(req,'danger','Not your payment'); return res.redirect('/payments/' + p.id);
  }
  const modes = db.prepare('SELECT * FROM payment_modes WHERE active=1 ORDER BY name').all();
  const dealer = db.prepare('SELECT name FROM dealers WHERE id=?').get(p.dealer_id);
  const invoice = p.invoice_id ? db.prepare('SELECT invoice_no, total, paid_amount FROM invoices WHERE id=?').get(p.invoice_id) : null;
  res.render('payments/edit', { title: 'Edit Payment ' + p.payment_no, p, modes, dealer, invoice });
});

router.post('/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM payments WHERE id=?').get(req.params.id);
  if (!p) return res.redirect('/payments');
  if (p.status !== 'pending') { flash(req,'danger','Only pending payments can be edited'); return res.redirect('/payments/' + p.id); }
  if (req.session.user.role === 'salesperson' && p.created_by !== req.session.user.id) {
    flash(req,'danger','Not your payment'); return res.redirect('/payments/' + p.id);
  }
  const { amount, payment_mode_id, payment_date, reference_no, remarks } = req.body;
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) { flash(req,'danger','Invalid amount'); return res.redirect('/payments/' + p.id + '/edit'); }
  db.prepare('UPDATE payments SET amount=?, payment_mode_id=?, payment_date=?, reference_no=?, remarks=? WHERE id=?')
    .run(amt, payment_mode_id||null, payment_date, reference_no||null, remarks||null, p.id);
  req.audit('update', 'payment', p.id, `${p.payment_no} · ₹${amt}`);
  flash(req,'success','Updated.'); res.redirect('/payments/' + p.id);
});

router.post('/:id/reject', requireRole('admin','accountant'), (req, res) => {
  db.prepare(`UPDATE payments SET status='rejected', verified_by=?, verified_at=datetime('now'), remarks = COALESCE(remarks,'') || '\n[REJECTED] ' || ? WHERE id=?`)
    .run(req.session.user.id, req.body.reason || '', req.params.id);
  req.audit('reject', 'payment', req.params.id, `Reason: ${req.body.reason || '(none)'}`);
  flash(req,'success','Rejected.'); res.redirect('/payments/' + req.params.id);
});

function applyToInvoice(invoiceId, amount) {
  const inv = db.prepare('SELECT total, paid_amount FROM invoices WHERE id=?').get(invoiceId);
  if (!inv) return;
  const newPaid = (inv.paid_amount || 0) + amount;
  let status = 'unpaid';
  if (newPaid + 0.01 >= inv.total) status = 'paid';
  else if (newPaid > 0) status = 'partial';
  db.prepare('UPDATE invoices SET paid_amount=?, status=? WHERE id=?').run(newPaid, status, invoiceId);
}

module.exports = router;
