// Fast2SMS transport (DLT route). Sends a DLT-approved template by its
// template id + pipe-separated variable values. Uses global fetch — no
// dependency. Docs: https://docs.fast2sms.com/  (Bulk SMS API v2, route=dlt)
const BULK_URL = 'https://www.fast2sms.com/dev/bulkV2';
const WALLET_URL = 'https://www.fast2sms.com/dev/wallet';

// Fast2SMS wants bare 10-digit Indian numbers (no +91 / spaces).
function normalizeNumbers(to) {
  return [].concat(to)
    .map((n) => String(n).replace(/\D/g, ''))
    .map((n) => (n.length > 10 ? n.slice(-10) : n))
    .filter((n) => n.length === 10)
    .join(',');
}

async function send({ apiKey, senderId, route, templateId, variablesValues, numbers, flash }) {
  const nums = normalizeNumbers(numbers);
  if (!nums) return { ok: false, error: 'No valid 10-digit mobile number', response: {} };
  const body = new URLSearchParams({
    authorization: apiKey,
    route: route || 'dlt',
    sender_id: senderId || '',
    message: String(templateId || ''),     // DLT route: message = DLT template id
    variables_values: variablesValues || '',
    flash: flash ? '1' : '0',
    numbers: nums,
  });
  let res, j;
  try {
    res = await fetch(BULK_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    j = await res.json().catch(() => ({}));
  } catch (e) {
    return { ok: false, error: 'Network error reaching Fast2SMS: ' + e.message, response: {} };
  }
  // Fast2SMS success shape: { return:true, request_id, message:[...] }
  const ok = j && j.return === true;
  return { ok, request_id: j && j.request_id, response: j, error: ok ? null : (j && j.message ? (Array.isArray(j.message) ? j.message.join('; ') : j.message) : 'HTTP ' + (res ? res.status : '?')) };
}

// Wallet balance — used by the settings status panel to confirm the key works.
async function wallet({ apiKey }) {
  try {
    const res = await fetch(WALLET_URL + '?authorization=' + encodeURIComponent(apiKey));
    const j = await res.json().catch(() => ({}));
    if (j && j.return === true) return { ok: true, balance: j.wallet };
    return { ok: false, error: (j && j.message) ? (Array.isArray(j.message) ? j.message.join('; ') : j.message) : 'Invalid API key / HTTP ' + res.status };
  } catch (e) {
    return { ok: false, error: 'Network error: ' + e.message };
  }
}

module.exports = { send, wallet, normalizeNumbers };
