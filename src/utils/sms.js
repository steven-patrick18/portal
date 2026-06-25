// SMS sender. Real transport is Fast2SMS (DLT route) — sends a DLT-approved
// template id + pipe-separated variable values. Provider switch:
//   SMS_PROVIDER = 'fast2sms'  (real send via Fast2SMS DLT)
//                | 'off'       (test — only logs, doesn't send)
//
// All sends are logged in notifications_log regardless of provider.

const { db } = require('../db');
const fast2sms = require('./fast2sms');

function setting(key, fallback) {
  const r = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  if (r && r.value !== null && r.value !== '') return r.value;
  return process.env[key] || fallback;
}

function logSend({ to, template, message, dealer_id, payment_id, invoice_id, status, response }) {
  const r = db.prepare(`INSERT INTO notifications_log (channel,to_phone,template,message,related_dealer_id,related_payment_id,related_invoice_id,status,provider_response) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('sms', to, template || null, message, dealer_id || null, payment_id || null, invoice_id || null, status, typeof response === 'string' ? response : JSON.stringify(response || {}));
  return r.lastInsertRowid;
}

// `message` is the human-readable text (for logging/preview). For a real
// Fast2SMS DLT send we also need `dlt_template_id` + `variables_values`
// (pipe-separated, in the template's {#var#} order).
async function sendSMS({ to, message, template, dealer_id, payment_id, invoice_id, dlt_template_id, variables_values, sender_id }) {
  if (!to) return { ok: false, error: 'no recipient' };

  const provider = setting('SMS_PROVIDER', 'off');

  // Test/Off mode — log only, don't actually send.
  if (provider !== 'fast2sms') {
    const id = logSend({ to, template, message, dealer_id, payment_id, invoice_id, status: 'sent', response: { stub: true } });
    return { ok: true, stub: true, id };
  }

  const apiKey   = setting('FAST2SMS_API_KEY', '');
  // Each DLT template is bound to a specific header; use the template's own
  // sender id when set, else fall back to the account default.
  const senderId = (sender_id && String(sender_id).trim()) || setting('FAST2SMS_SENDER_ID', '');
  const route    = setting('FAST2SMS_ROUTE', 'dlt');
  const flash    = setting('FAST2SMS_FLASH', '0') === '1';
  if (!apiKey || !senderId) {
    const id = logSend({ to, template, message, dealer_id, payment_id, invoice_id, status: 'failed', response: { error: 'Fast2SMS API key / Sender ID not configured' } });
    return { ok: false, error: 'Fast2SMS API key / Sender ID are not configured. Set them in Settings → SMS Settings.', id };
  }
  if (!dlt_template_id) {
    const id = logSend({ to, template, message, dealer_id, payment_id, invoice_id, status: 'failed', response: { error: 'no DLT template id for this message' } });
    return { ok: false, error: 'No DLT Template ID set for this message type. Add it in Settings → SMS Settings → Templates.', id };
  }

  const result = await fast2sms.send({ apiKey, senderId, route, templateId: dlt_template_id, variablesValues: variables_values, numbers: to, flash });
  const status = result.ok ? 'sent' : 'failed';
  const id = logSend({ to, template, message, dealer_id, payment_id, invoice_id, status, response: result.response || result });
  return { ok: result.ok, error: result.error, request_id: result.request_id, id };
}

// Replace placeholders like {dealer}, {amount}, {invoice_no} in a template.
function fillTemplate(tpl, vars) {
  if (!tpl) return '';
  return String(tpl).replace(/\{\{?\s*([a-zA-Z_]+)\s*\}?\}/g, (m, key) => (vars[key] != null ? String(vars[key]) : ''));
}

module.exports = { sendSMS, fillTemplate, setting };
