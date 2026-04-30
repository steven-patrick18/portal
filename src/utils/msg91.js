// MSG91 SMS / WhatsApp wrapper. If MSG91_ENABLED=false, this is a stub that just logs.
const { db } = require('../db');

async function sendSMS({ to, message, template, dealer_id, payment_id, invoice_id }) {
  return _send('sms', { to, message, template, dealer_id, payment_id, invoice_id });
}

async function sendWhatsApp({ to, message, template, dealer_id, payment_id, invoice_id }) {
  return _send('whatsapp', { to, message, template, dealer_id, payment_id, invoice_id });
}

function setting(key, fallback) {
  const r = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  if (r && r.value !== null && r.value !== '') return r.value;
  return process.env[key] || fallback;
}

async function _send(channel, { to, message, template, dealer_id, payment_id, invoice_id }) {
  if (!to) return { ok: false, error: 'no recipient' };
  const enabled = setting('MSG91_ENABLED', 'false') === 'true';
  const auth = setting('MSG91_AUTH_KEY', '');
  const sender = setting('MSG91_SENDER_ID', 'PORTAL');
  const log = db.prepare(`INSERT INTO notifications_log (channel,to_phone,template,message,related_dealer_id,related_payment_id,related_invoice_id,status,provider_response) VALUES (?,?,?,?,?,?,?,?,?)`);
  if (!enabled || !auth) {
    const r = log.run(channel, to, template||null, message, dealer_id||null, payment_id||null, invoice_id||null, 'sent', JSON.stringify({ stub: true }));
    return { ok: true, stub: true, id: r.lastInsertRowid };
  }
  try {
    let url, body;
    if (channel === 'sms') {
      url = 'https://control.msg91.com/api/v5/flow';
      body = { template_id: template || setting('MSG91_DLT_TEMPLATE_PAYMENT', ''), sender, short_url: '0', mobiles: '91' + to.replace(/\D/g,'').slice(-10), VAR1: message };
    } else {
      url = 'https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/';
      body = { integrated_number: sender, content_type: 'template', payload: { messaging_product: 'whatsapp', type: 'text', text: { body: message }, to: '91' + to.replace(/\D/g,'').slice(-10) } };
    }
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', authkey: auth }, body: JSON.stringify(body) });
    const text = await res.text();
    const status = res.ok ? 'sent' : 'failed';
    const r = log.run(channel, to, template||null, message, dealer_id||null, payment_id||null, invoice_id||null, status, text);
    return { ok: res.ok, response: text, id: r.lastInsertRowid };
  } catch (e) {
    log.run(channel, to, template||null, message, dealer_id||null, payment_id||null, invoice_id||null, 'failed', String(e.message));
    return { ok: false, error: e.message };
  }
}

module.exports = { sendSMS, sendWhatsApp };
