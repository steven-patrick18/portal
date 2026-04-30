// High-level "send notification for X" helpers. They look up the record,
// compute extras like outstanding balance, fill the right template from
// app_settings, and call sendSMS(). Used by both manual "Send SMS" buttons
// and the auto-fire hooks (e.g. on payment verification).

const { db } = require('../db');
const { sendSMS, fillTemplate } = require('./sms');

function setting(key, fallback) {
  const r = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  if (r && r.value !== null && r.value !== '') return r.value;
  return process.env[key] || fallback;
}
function brandName() { return setting('COMPANY_NAME', 'Portal'); }

// Sum of balances on every non-cancelled invoice for a dealer (i.e. how
// much they currently owe). Adds in any opening_balance carried from the
// dealer master.
function outstandingForDealer(dealerId) {
  const dealer = db.prepare('SELECT opening_balance FROM dealers WHERE id=?').get(dealerId);
  const opening = dealer ? (dealer.opening_balance || 0) : 0;
  const inv = db.prepare(
    "SELECT COALESCE(SUM(total - paid_amount),0) AS bal FROM invoices WHERE dealer_id=? AND status!='cancelled'"
  ).get(dealerId);
  return Math.max(0, opening + (inv ? inv.bal : 0));
}

// Default SMS template if the user hasn't customized one in /settings/sms.
// Each section bakes in the "outstanding + sales nudge" the way the user
// asked: confirms the payment, tells them their remaining balance, and
// invites them back for more business.
const DEFAULTS = {
  invoice:     'Hi {dealer}, invoice {invoice_no} of Rs.{amount} ready. Outstanding now Rs.{outstanding}. Thanks - {company}',
  payment:     'Hi {dealer}, payment of Rs.{amount} received on {date} (ref {ref}). Outstanding balance now Rs.{outstanding}. Thank you for your business — visit us for our latest collection! - {company}',
  dispatch:    'Hi {dealer}, your order has been dispatched. Vehicle {vehicle}, LR {lr}. Thanks - {company}',
  outstanding: 'Hi {dealer}, your outstanding balance is Rs.{amount} across {count} invoice(s). Please clear at your earliest. - {company}',
};

async function notifyPayment(paymentId) {
  const p = db.prepare(`SELECT p.*, d.name AS dealer_name, d.phone FROM payments p JOIN dealers d ON d.id=p.dealer_id WHERE p.id=?`).get(paymentId);
  if (!p) return { ok: false, error: 'payment not found' };
  if (!p.phone) return { ok: false, error: 'dealer has no phone on file' };
  const tpl = setting('SMS_TEMPLATE_PAYMENT', DEFAULTS.payment);
  const outstanding = outstandingForDealer(p.dealer_id).toFixed(2);
  const msg = fillTemplate(tpl, {
    dealer: p.dealer_name,
    amount: p.amount.toFixed(2),
    date: p.payment_date,
    ref: p.payment_no,
    outstanding,
    company: brandName(),
  });
  return sendSMS({ to: p.phone, message: msg, dealer_id: p.dealer_id, payment_id: p.id });
}

async function notifyInvoice(invoiceId) {
  const i = db.prepare(`SELECT i.*, d.name AS dealer_name, d.phone FROM invoices i JOIN dealers d ON d.id=i.dealer_id WHERE i.id=?`).get(invoiceId);
  if (!i) return { ok: false, error: 'invoice not found' };
  if (!i.phone) return { ok: false, error: 'dealer has no phone on file' };
  const tpl = setting('SMS_TEMPLATE_INVOICE', DEFAULTS.invoice);
  const outstanding = outstandingForDealer(i.dealer_id).toFixed(2);
  const msg = fillTemplate(tpl, {
    dealer: i.dealer_name,
    invoice_no: i.invoice_no,
    amount: i.total.toFixed(2),
    outstanding,
    company: brandName(),
  });
  return sendSMS({ to: i.phone, message: msg, dealer_id: i.dealer_id, invoice_id: i.id });
}

async function notifyDispatch(dispatchId) {
  const d = db.prepare(`SELECT d.*, dl.name AS dealer_name, dl.phone FROM dispatches d JOIN dealers dl ON dl.id=d.dealer_id WHERE d.id=?`).get(dispatchId);
  if (!d) return { ok: false, error: 'dispatch not found' };
  if (!d.phone) return { ok: false, error: 'dealer has no phone on file' };
  const tpl = setting('SMS_TEMPLATE_DISPATCH', DEFAULTS.dispatch);
  const msg = fillTemplate(tpl, {
    dealer: d.dealer_name,
    vehicle: d.vehicle_no || '-',
    lr: d.lr_no || '-',
    company: brandName(),
  });
  return sendSMS({ to: d.phone, message: msg, dealer_id: d.dealer_id });
}

async function notifyOutstandingReminder(dealerId) {
  const d = db.prepare('SELECT id, name, phone FROM dealers WHERE id=?').get(dealerId);
  if (!d || !d.phone) return { ok: false, error: 'dealer not found / no phone' };
  const tpl = setting('SMS_TEMPLATE_OUTSTANDING', DEFAULTS.outstanding);
  const amount = outstandingForDealer(d.id).toFixed(2);
  const count = db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE dealer_id=? AND status IN ('unpaid','partial')").get(d.id).n;
  const msg = fillTemplate(tpl, { dealer: d.name, amount, count, company: brandName() });
  return sendSMS({ to: d.phone, message: msg, dealer_id: d.id });
}

module.exports = {
  notifyPayment, notifyInvoice, notifyDispatch, notifyOutstandingReminder,
  outstandingForDealer, DEFAULTS,
};
