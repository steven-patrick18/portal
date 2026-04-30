const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { sendSMS } = require('../utils/sms');
const { notifyPayment, notifyInvoice, notifyDispatch, notifyOutstandingReminder } = require('../utils/notify');
const router = express.Router();

router.get('/', (req, res) => {
  const items = db.prepare(`SELECT n.*, d.name AS dealer_name FROM notifications_log n LEFT JOIN dealers d ON d.id=n.related_dealer_id ORDER BY n.id DESC LIMIT 200`).all();
  res.render('notifications/index', { title: 'Notifications Log', items });
});

router.get('/send', (req, res) => {
  const dealers = db.prepare('SELECT id,code,name,phone FROM dealers WHERE active=1 AND phone IS NOT NULL ORDER BY name').all();
  res.render('notifications/send', { title: 'Send Notification', dealers, preDealer: req.query.dealer_id });
});

router.post('/send', async (req, res) => {
  const { dealer_id, message } = req.body;
  const d = db.prepare('SELECT name, phone FROM dealers WHERE id=?').get(dealer_id);
  if (!d || !d.phone) { flash(req,'danger','Dealer has no phone'); return res.redirect('/notifications/send'); }
  await sendSMS({ to: d.phone, message, dealer_id });
  flash(req,'success', `SMS queued.`);
  res.redirect('/notifications');
});

function flashResult(req, res, redirect, r, label) {
  if (r.stub)    flash(req, 'warning', `Stub mode — ${label} SMS logged but not actually sent.`);
  else if (r.ok) flash(req, 'success', `${label} SMS sent.`);
  else           flash(req, 'danger', `${label} SMS failed: ${r.error || 'unknown'}`);
  res.redirect(redirect);
}

router.post('/payment/:paymentId', async (req, res) => {
  const r = await notifyPayment(req.params.paymentId);
  flashResult(req, res, '/payments/' + req.params.paymentId, r, 'Payment');
});

router.post('/invoice/:invoiceId', async (req, res) => {
  const r = await notifyInvoice(req.params.invoiceId);
  flashResult(req, res, '/invoices/' + req.params.invoiceId, r, 'Invoice');
});

router.post('/dispatch/:dispatchId', async (req, res) => {
  const r = await notifyDispatch(req.params.dispatchId);
  flashResult(req, res, '/dispatch', r, 'Dispatch');
});

router.post('/outstanding/:dealerId', async (req, res) => {
  const r = await notifyOutstandingReminder(req.params.dealerId);
  flashResult(req, res, '/dealers/' + req.params.dealerId, r, 'Outstanding reminder');
});

module.exports = router;
