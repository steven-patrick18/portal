// Capcom "SMS Gateway for Android" client (https://sms-gate.app).
// Cloud relay mode: app on phone connects to sms-gate.app, our server POSTs
// to api.sms-gate.app/3rdparty/v1, the relay forwards to the phone.
//
// No DLT, no sender header registration — sender is just the phone's SIM.

const DEFAULT_BASE = 'https://api.sms-gate.app/3rdparty/v1';

// Normalize an Indian-style phone to E.164 (+91XXXXXXXXXX).
// Accepts: 9876543210, 09876543210, 919876543210, +919876543210, 91-9876-54-3210, etc.
function normalize(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) digits = '91' + digits;            // local Indian → +91
  else if (digits.length === 11 && digits.startsWith('0')) digits = '91' + digits.slice(1);
  else if (digits.length === 12 && digits.startsWith('91')) { /* already in country form */ }
  else if (digits.length > 10 && !digits.startsWith('91') && !digits.startsWith('+')) digits = digits;  // foreign — pass through
  return '+' + digits;
}

async function send({ url, username, password, phone, message }) {
  const e164 = normalize(phone);
  if (!e164) return { ok: false, error: 'invalid phone number' };
  const base = (url || DEFAULT_BASE).replace(/\/+$/, '');
  const auth = 'Basic ' + Buffer.from((username || '') + ':' + (password || '')).toString('base64');
  try {
    const res = await fetch(base + '/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': auth },
      body: JSON.stringify({ message, phoneNumbers: [e164] }),
    });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
    if (!res.ok) return { ok: false, status: res.status, response: text, error: body.error || body.message || res.statusText };
    return { ok: true, id: body.id, state: body.state, response: text };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Optional: query the status of a previously-sent message.
async function getStatus({ url, username, password, id }) {
  const base = (url || DEFAULT_BASE).replace(/\/+$/, '');
  const auth = 'Basic ' + Buffer.from((username || '') + ':' + (password || '')).toString('base64');
  try {
    const res = await fetch(base + '/message/' + encodeURIComponent(id), {
      headers: { 'Authorization': auth },
    });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
    if (!res.ok) return { ok: false, status: res.status, response: text };
    return { ok: true, state: body.state, recipients: body.recipients, response: text };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { send, getStatus, normalize, DEFAULT_BASE };
