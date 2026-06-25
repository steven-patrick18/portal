const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { sendSMS, fillTemplate, setting } = require('../utils/sms');
const { notifyPayment, notifyInvoice, notifyDispatch, notifyOutstandingReminder, outstandingForDealer, buildValues } = require('../utils/notify');
const router = express.Router();

router.get('/', (req, res) => {
  const items = db.prepare(`SELECT n.*, d.name AS dealer_name FROM notifications_log n LEFT JOIN dealers d ON d.id=n.related_dealer_id ORDER BY n.id DESC LIMIT 200`).all();
  res.render('notifications/index', { title: 'Notifications Log', items });
});

router.get('/send', (req, res) => {
  const dealers = db.prepare('SELECT id,code,name,phone FROM dealers WHERE active=1 AND phone IS NOT NULL ORDER BY name').all();
  // DLT can only send APPROVED templates — so the manual sender picks a
  // template, not free text. Dealer-level templates (outstanding reminder)
  // are the typical manual use.
  const templates = db.prepare("SELECT id, label, event, body, dlt_template_id FROM sms_templates WHERE active=1 ORDER BY event, id").all();
  res.render('notifications/send', { title: 'Send Notification', dealers, templates, preDealer: req.query.dealer_id });
});

router.post('/send', async (req, res) => {
  const { dealer_id, template_id } = req.body;
  const d = db.prepare('SELECT id, name, phone FROM dealers WHERE id=?').get(dealer_id);
  if (!d || !d.phone) { flash(req, 'danger', 'Dealer has no phone on file'); return res.redirect('/notifications/send'); }
  const t = template_id ? db.prepare('SELECT * FROM sms_templates WHERE id=?').get(template_id) : null;
  if (!t) { flash(req, 'danger', 'Pick a template — DLT can only send approved templates, not free text.'); return res.redirect('/notifications/send'); }
  // Auto-derive the dealer-level variables; invoice/dispatch-specific ones
  // (invoice_no, vehicle, lr, ref, date) stay blank for a manual send.
  const outstanding = outstandingForDealer(d.id).toFixed(2);
  const count = db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE dealer_id=? AND status IN ('unpaid','partial')").get(d.id).n;
  const vars = { dealer: d.name, amount: outstanding, outstanding, count, company: setting('COMPANY_NAME', 'Sharv Enterprises') };
  const r = await sendSMS({
    to: d.phone, message: fillTemplate(t.body, vars), template: t.event,
    dlt_template_id: t.dlt_template_id, sender_id: t.sender_id, variables_values: buildValues(t.var_order, vars), dealer_id: d.id,
  });
  if (r.stub)    flash(req, 'warning', 'Test/Off mode — message logged but not sent.');
  else if (r.ok) flash(req, 'success', 'SMS sent.');
  else           flash(req, 'danger', 'SMS failed: ' + (r.error || 'unknown'));
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
