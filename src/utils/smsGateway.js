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

// Query the current state of a previously-sent message.
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
    // Capcom returns an array of recipients each with their own state.
    // Roll them up to a single overall state for display.
    const states = (body.recipients || []).map(r => r.state).filter(Boolean);
    const overall = body.state || states[0] || 'Unknown';
    return { ok: true, state: overall, recipients: body.recipients || [] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Health probe — does the relay respond? Are our credentials valid?
// We use GET /health which doesn't require auth (returns server status),
// then GET /device which DOES require auth (so we can detect bad creds).
async function health({ url, username, password }) {
  const base = (url || DEFAULT_BASE).replace(/\/+$/, '');
  const auth = 'Basic ' + Buffer.from((username || '') + ':' + (password || '')).toString('base64');
  const out = { reachable: false, authenticated: false, devices: [] };
  // 1. Reachability
  try {
    const r = await fetch(base + '/health', { method: 'GET' });
    out.reachable = r.ok || r.status === 401 || r.status === 403; // any HTTP response means reachable
    if (r.ok) {
      try { out.health = await r.json(); } catch { /* not JSON, that's fine */ }
    }
  } catch (e) {
    out.error = 'Cannot reach ' + base + ': ' + e.message;
    return out;
  }
  // 2. Auth check via /device
  if (!username || !password) {
    out.error = 'No credentials configured';
    return out;
  }
  try {
    const r = await fetch(base + '/device', { headers: { 'Authorization': auth } });
    if (r.status === 401 || r.status === 403) {
      out.error = 'Authentication failed (HTTP ' + r.status + ') — check the username and password from your phone.';
      return out;
    }
    if (!r.ok) {
      out.error = 'Device list failed: HTTP ' + r.status;
      return out;
    }
    out.authenticated = true;
    try {
      const data = await r.json();
      // Capcom returns { devices: [...] } or [...] depending on version.
      out.devices = Array.isArray(data) ? data : (data.devices || data.items || []);
    } catch { /* tolerate empty body */ }
  } catch (e) {
    out.error = 'Device list error: ' + e.message;
  }
  return out;
}

module.exports = { send, getStatus, health, normalize, DEFAULT_BASE };
