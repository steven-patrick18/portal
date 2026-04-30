// SMS sender. Uses the Capcom Android-phone gateway as the only real
// transport — no MSG91, no DLT, no sender-ID approval. Provider switch:
//   SMS_PROVIDER = 'gateway'  (real send via the phone's SIM)
//                | 'off'      (stub — only logs, doesn't send)
//
// All sends are logged in notifications_log regardless of provider.

const { db } = require('../db');
const gateway = require('./smsGateway');

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

async function sendSMS({ to, message, template, dealer_id, payment_id, invoice_id }) {
  if (!to)      return { ok: false, error: 'no recipient' };
  if (!message) return { ok: false, error: 'no message' };

  const provider = setting('SMS_PROVIDER', 'off');

  // Stub mode — log only, don't actually send.
  if (provider !== 'gateway') {
    const id = logSend({ to, template, message, dealer_id, payment_id, invoice_id, status: 'sent', response: { stub: true } });
    return { ok: true, stub: true, id };
  }

  // Real send via Capcom Android phone gateway.
  const url      = setting('SMS_GATEWAY_URL', gateway.DEFAULT_BASE);
  const username = setting('SMS_GATEWAY_USERNAME', '');
  const password = setting('SMS_GATEWAY_PASSWORD', '');
  if (!username || !password) {
    const id = logSend({ to, template, message, dealer_id, payment_id, invoice_id, status: 'failed', response: { error: 'gateway credentials missing' } });
    return { ok: false, error: 'SMS Gateway credentials are not configured. Set them in Settings → SMS Settings.', id };
  }
  const result = await gateway.send({ url, username, password, phone: to, message });
  const status = result.ok ? 'sent' : 'failed';
  const id = logSend({ to, template, message, dealer_id, payment_id, invoice_id, status, response: result });
  return { ok: result.ok, error: result.error, gateway_id: result.id, state: result.state, id };
}

// Replace placeholders like {dealer}, {amount}, {invoice_no} in a template.
function fillTemplate(tpl, vars) {
  if (!tpl) return '';
  return String(tpl).replace(/\{\{?\s*([a-zA-Z_]+)\s*\}?\}/g, (m, key) => (vars[key] != null ? String(vars[key]) : ''));
}

module.exports = { sendSMS, fillTemplate, setting };
