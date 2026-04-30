const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { sendSMS, fillTemplate } = require('../utils/sms');
const { getSetting } = require('./settings');
const router = express.Router();

function brandName() {
  return getSetting('COMPANY_NAME', process.env.COMPANY_NAME || 'Portal');
}

router.get('/', (req, res) => {
  const items = db.prepare(`SELECT n.*, d.name AS dealer_name FROM notifications_log n LEFT JOIN dealers d ON d.id=n.related_dealer_id ORDER BY n.id DESC LIMIT 200`).all();
  res.render('notifications/index', { title: 'Notifications Log', items });
});

router.get('/send', (req, res) => {
  const dealers = db.prepare('SELECT id,code,name,phone FROM dealers WHERE active=1 AND phone IS NOT NULL ORDER BY name').all();
  res.render('notifications/send', { title: 'Send Notification', dealers, preDealer: req.query.dealer_id });
});

router.post('/send', async (req, res) => {
  const { dealer_id, channel, message } = req.body;
  const d = db.prepare('SELECT name, phone FROM dealers WHERE id=?').get(dealer_id);
  if (!d || !d.phone) { flash(req,'danger','Dealer has no phone'); return res.redirect('/notifications/send'); }
  const fn = channel === 'whatsapp' ? sendWhatsApp : sendSMS;
  await fn({ to: d.phone, message, dealer_id });
  flash(req,'success', `Notification queued via ${channel}.`);
  res.redirect('/notifications');
});

router.post('/payment/:paymentId', async (req, res) => {
  const p = db.prepare(`SELECT p.*, d.name AS dealer_name, d.phone FROM payments p JOIN dealers d ON d.id=p.dealer_id WHERE p.id=?`).get(req.params.paymentId);
  if (!p || !p.phone) { flash(req,'danger','Dealer has no phone on file'); return res.redirect('/payments/' + req.params.paymentId); }
  const tpl = getSetting('SMS_TEMPLATE_PAYMENT', 'Hi {dealer}, payment Rs.{amount} received on {date}. Ref: {ref}. Thanks - {company}');
  const msg = fillTemplate(tpl, { dealer: p.dealer_name, amount: p.amount.toFixed(2), date: p.payment_date, ref: p.payment_no, company: brandName() });
  const r = await sendSMS({ to: p.phone, message: msg, dealer_id: p.dealer_id, payment_id: p.id });
  flash(req, r.ok ? 'success' : 'danger', r.ok ? (r.stub ? 'Stub mode — logged but not sent.' : 'Payment SMS sent.') : ('Failed: ' + (r.error || 'unknown')));
  res.redirect('/payments/' + req.params.paymentId);
});

router.post('/invoice/:invoiceId', async (req, res) => {
  const i = db.prepare(`SELECT i.*, d.name AS dealer_name, d.phone FROM invoices i JOIN dealers d ON d.id=i.dealer_id WHERE i.id=?`).get(req.params.invoiceId);
  if (!i || !i.phone) { flash(req,'danger','Dealer has no phone on file'); return res.redirect('/invoices/' + req.params.invoiceId); }
  const tpl = getSetting('SMS_TEMPLATE_INVOICE', 'Hi {dealer}, invoice {invoice_no} of Rs.{amount} ready. Thanks - {company}');
  const msg = fillTemplate(tpl, { dealer: i.dealer_name, invoice_no: i.invoice_no, amount: i.total.toFixed(2), company: brandName() });
  const r = await sendSMS({ to: i.phone, message: msg, dealer_id: i.dealer_id, invoice_id: i.id });
  flash(req, r.ok ? 'success' : 'danger', r.ok ? (r.stub ? 'Stub mode — logged but not sent.' : 'Invoice SMS sent.') : ('Failed: ' + (r.error || 'unknown')));
  res.redirect('/invoices/' + req.params.invoiceId);
});

router.post('/dispatch/:dispatchId', async (req, res) => {
  const d = db.prepare(`SELECT d.*, dl.name AS dealer_name, dl.phone FROM dispatches d JOIN dealers dl ON dl.id=d.dealer_id WHERE d.id=?`).get(req.params.dispatchId);
  if (!d || !d.phone) { flash(req,'danger','Dealer has no phone on file'); return res.redirect('/dispatch/' + req.params.dispatchId); }
  const tpl = getSetting('SMS_TEMPLATE_DISPATCH', 'Hi {dealer}, your order has been dispatched. Vehicle: {vehicle}, LR: {lr}. Thanks - {company}');
  const msg = fillTemplate(tpl, { dealer: d.dealer_name, vehicle: d.vehicle_no || '-', lr: d.lr_no || '-', company: brandName() });
  const r = await sendSMS({ to: d.phone, message: msg, dealer_id: d.dealer_id });
  flash(req, r.ok ? 'success' : 'danger', r.ok ? (r.stub ? 'Stub mode — logged but not sent.' : 'Dispatch SMS sent.') : ('Failed: ' + (r.error || 'unknown')));
  res.redirect('/dispatch');
});

module.exports = router;
