// Unified SMS sender. Picks the active provider based on app_settings:
//   SMS_PROVIDER = 'gateway' (Android phone via Capcom relay)
//                | 'msg91'   (DLT-registered SMS through MSG91)
//                | 'off'     (stub — only logs, doesn't send)
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
  if (provider === 'off') {
    const id = logSend({ to, template, message, dealer_id, payment_id, invoice_id, status: 'sent', response: { stub: true } });
    return { ok: true, stub: true, id };
  }

  // Capcom Android phone gateway.
  if (provider === 'gateway') {
    const url      = setting('SMS_GATEWAY_URL', gateway.DEFAULT_BASE);
    const username = setting('SMS_GATEWAY_USERNAME', '');
    const password = setting('SMS_GATEWAY_PASSWORD', '');
    if (!username || !password) {
      const id = logSend({ to, template, message, dealer_id, payment_id, invoice_id, status: 'failed', response: { error: 'gateway credentials missing' } });
      return { ok: false, error: 'SMS Gateway credentials are not configured. Set them in Settings → SMS Gateway.', id };
    }
    const result = await gateway.send({ url, username, password, phone: to, message });
    const status = result.ok ? 'sent' : 'failed';
    const id = logSend({ to, template, message, dealer_id, payment_id, invoice_id, status, response: result });
    return { ok: result.ok, error: result.error, gateway_id: result.id, state: result.state, id };
  }

  // MSG91 — same code path as before, kept here so notifications.js doesn't need to know.
  if (provider === 'msg91') {
    const auth = setting('MSG91_AUTH_KEY', '');
    const sender = setting('MSG91_SENDER_ID', 'PORTAL');
    if (!auth) {
      const id = logSend({ to, template, message, dealer_id, payment_id, invoice_id, status: 'failed', response: { error: 'msg91 auth_key missing' } });
      return { ok: false, error: 'MSG91 is selected but no auth key is configured.', id };
    }
    try {
      const body = {
        template_id: template || setting('MSG91_DLT_TEMPLATE_PAYMENT', ''),
        sender,
        short_url: '0',
        mobiles: '91' + String(to).replace(/\D/g, '').slice(-10),
        VAR1: message,
      };
      const res = await fetch('https://control.msg91.com/api/v5/flow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authkey: auth },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      const status = res.ok ? 'sent' : 'failed';
      const id = logSend({ to, template, message, dealer_id, payment_id, invoice_id, status, response: text });
      return { ok: res.ok, response: text, id };
    } catch (e) {
      const id = logSend({ to, template, message, dealer_id, payment_id, invoice_id, status: 'failed', response: { error: e.message } });
      return { ok: false, error: e.message, id };
    }
  }

  // Unknown provider — fail loud.
  const id = logSend({ to, template, message, dealer_id, payment_id, invoice_id, status: 'failed', response: { error: 'unknown SMS_PROVIDER: ' + provider } });
  return { ok: false, error: 'Unknown SMS provider: ' + provider, id };
}

// Replace placeholders like {dealer}, {amount}, {invoice_no} in a template string.
function fillTemplate(tpl, vars) {
  if (!tpl) return '';
  return String(tpl).replace(/\{\{?\s*([a-zA-Z_]+)\s*\}?\}/g, (m, key) => (vars[key] != null ? String(vars[key]) : ''));
}

module.exports = { sendSMS, fillTemplate, setting };
