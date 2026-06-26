// High-level "send notification for X" helpers. They look up the record,
// compute extras like outstanding balance, pick the active SMS template for
// the event (from sms_templates), build the readable message + the DLT
// variable values, and call sendSMS().

const { db } = require('../db');
const { sendSMS, fillTemplate } = require('./sms');

function setting(key, fallback) {
  const r = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  if (r && r.value !== null && r.value !== '') return r.value;
  return process.env[key] || fallback;
}
function brandName() { return setting('COMPANY_NAME', 'Sharv Enterprises'); }

// Active template for an event (the one auto-fire uses).
function templateFor(event) {
  return db.prepare('SELECT * FROM sms_templates WHERE event=? AND active=1 ORDER BY id LIMIT 1').get(event);
}
// Pipe-separated values in the template's declared variable order — what
// Fast2SMS DLT expects for variables_values.
function buildValues(varOrder, vars) {
  return String(varOrder || '').split(',').map((k) => k.trim()).filter(Boolean)
    .map((k) => (vars[k] != null ? String(vars[k]) : '')).join('|');
}

function outstandingForDealer(dealerId) {
  const dealer = db.prepare('SELECT opening_balance FROM dealers WHERE id=?').get(dealerId);
  const opening = dealer ? (dealer.opening_balance || 0) : 0;
  // Mirror the dealer page EXACTLY: bill total minus VERIFIED PAYMENTS from
  // the payments table — NOT the invoices.paid_amount cache. Standalone
  // "Receive Payment" entries (invoice_id NULL, e.g. paying down the opening
  // balance) don't touch invoice.paid_amount, so the old cache-based sum
  // overstated outstanding by exactly those payments.
  const billed = db.prepare("SELECT COALESCE(SUM(total),0) AS v FROM invoices WHERE dealer_id=? AND status!='cancelled'").get(dealerId).v;
  const paid   = db.prepare("SELECT COALESCE(SUM(amount),0) AS v FROM payments WHERE dealer_id=? AND status='verified'").get(dealerId).v;
  const ret    = db.prepare("SELECT COALESCE(SUM(total_amount),0) AS v FROM returns WHERE dealer_id=? AND status IN ('approved','restocked')").get(dealerId).v;
  return Math.max(0, opening + billed - paid - ret);
}

// Fallback bodies if a template row was deleted (keeps logging sensible).
const FALLBACK = {
  invoice:     'Dear {dealer}, invoice {invoice_no} of Rs {amount} generated. Outstanding Rs {outstanding}. - {company}',
  payment:     'Dear {dealer}, payment of Rs {amount} received. Outstanding Rs {outstanding}. - {company}',
  dispatch:    'Dear {dealer}, order on invoice {invoice_no} dispatched. Vehicle {vehicle}, LR {lr}. - {company}',
  outstanding: 'Dear {dealer}, outstanding Rs {amount} across {count} invoice(s). Please clear. - {company}',
};

// Build {message, dlt_template_id, variables_values} for an event + vars.
function compose(event, vars) {
  const t = templateFor(event);
  const body = t ? t.body : FALLBACK[event];
  return {
    message: fillTemplate(body, vars),
    dlt_template_id: t ? t.dlt_template_id : null,
    sender_id: t ? t.sender_id : null,   // template's own DLT header (else account default)
    variables_values: t ? buildValues(t.var_order, vars) : '',
  };
}

async function notifyPayment(paymentId) {
  const p = db.prepare(`SELECT p.*, d.name AS dealer_name, d.phone FROM payments p JOIN dealers d ON d.id=p.dealer_id WHERE p.id=?`).get(paymentId);
  if (!p) return { ok: false, error: 'payment not found' };
  if (!p.phone) return { ok: false, error: 'dealer has no phone on file' };
  const vars = { dealer: p.dealer_name, amount: p.amount.toFixed(2), date: p.payment_date, ref: p.payment_no, outstanding: outstandingForDealer(p.dealer_id).toFixed(2), company: brandName() };
  const c = compose('payment', vars);
  return sendSMS({ to: p.phone, ...c, template: 'payment', dealer_id: p.dealer_id, payment_id: p.id });
}

async function notifyInvoice(invoiceId) {
  const i = db.prepare(`SELECT i.*, d.name AS dealer_name, d.phone FROM invoices i JOIN dealers d ON d.id=i.dealer_id WHERE i.id=?`).get(invoiceId);
  if (!i) return { ok: false, error: 'invoice not found' };
  if (!i.phone) return { ok: false, error: 'dealer has no phone on file' };
  const vars = { dealer: i.dealer_name, invoice_no: i.invoice_no, amount: i.total.toFixed(2), outstanding: outstandingForDealer(i.dealer_id).toFixed(2), company: brandName() };
  const c = compose('invoice', vars);
  return sendSMS({ to: i.phone, ...c, template: 'invoice', dealer_id: i.dealer_id, invoice_id: i.id });
}

async function notifyDispatch(dispatchId) {
  const d = db.prepare(`SELECT d.*, dl.name AS dealer_name, dl.phone, i.invoice_no FROM dispatches d JOIN dealers dl ON dl.id=d.dealer_id LEFT JOIN invoices i ON i.id=d.invoice_id WHERE d.id=?`).get(dispatchId);
  if (!d) return { ok: false, error: 'dispatch not found' };
  if (!d.phone) return { ok: false, error: 'dealer has no phone on file' };
  const vars = { dealer: d.dealer_name, invoice_no: d.invoice_no || '-', vehicle: d.vehicle_no || '-', lr: d.lr_no || '-', company: brandName() };
  const c = compose('dispatch', vars);
  return sendSMS({ to: d.phone, ...c, template: 'dispatch', dealer_id: d.dealer_id, invoice_id: d.invoice_id });
}

async function notifyOutstandingReminder(dealerId) {
  const d = db.prepare('SELECT id, name, phone FROM dealers WHERE id=?').get(dealerId);
  if (!d || !d.phone) return { ok: false, error: 'dealer not found / no phone' };
  const count = db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE dealer_id=? AND status IN ('unpaid','partial')").get(d.id).n;
  const vars = { dealer: d.name, amount: outstandingForDealer(d.id).toFixed(2), count, company: brandName() };
  const c = compose('outstanding', vars);
  return sendSMS({ to: d.phone, ...c, template: 'outstanding', dealer_id: d.id });
}

module.exports = {
  notifyPayment, notifyInvoice, notifyDispatch, notifyOutstandingReminder,
  outstandingForDealer, templateFor, buildValues, compose,
};
