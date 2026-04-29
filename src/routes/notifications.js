const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { sendSMS, sendWhatsApp } = require('../utils/msg91');
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
  if (!p || !p.phone) { flash(req,'danger','No phone'); return res.redirect('/payments/' + req.params.paymentId); }
  const msg = `Hi ${p.dealer_name}, we have received your payment of Rs.${p.amount.toFixed(2)} dated ${p.payment_date}. Ref: ${p.payment_no}. Thanks - ${process.env.COMPANY_NAME||'Portal'}`;
  await sendSMS({ to: p.phone, message: msg, dealer_id: p.dealer_id, payment_id: p.id, template: process.env.MSG91_DLT_TEMPLATE_PAYMENT });
  flash(req,'success','Payment SMS sent.');
  res.redirect('/payments/' + req.params.paymentId);
});

module.exports = router;
