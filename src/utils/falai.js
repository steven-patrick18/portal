// fal.ai client for the Catalogue module.
//
// Auth: fal.ai expects `Authorization: Key <id:secret>` (the literal word
// "Key" — NOT "Bearer"). The "id:secret" form comes from the dashboard.
//
// Keep this file deliberately small — only the calls Phase A actually
// needs: a free ping for key validation, and a usage logger. Phase B will
// add background-removal + try-on calls. Phase C may swap providers.

const { db } = require('../db');

const FAL_BASE = 'https://fal.run';

// ── Helpers ──────────────────────────────────────────────────────────

function authHeader(apiKey) {
  return 'Key ' + (apiKey || '').trim();
}

// Convert a USD cost to INR for the audit log. Rate is configurable via
// the USD_TO_INR_RATE app_setting (default 84 — close enough for the
// receipts on the settings page; tweak when the rupee moves).
function usdToInr(usd) {
  const r = db.prepare("SELECT value FROM app_settings WHERE key='USD_TO_INR_RATE'").get();
  const rate = r ? parseFloat(r.value) : 84;
  return +(usd * (isFinite(rate) ? rate : 84)).toFixed(4);
}

function logUsage({ endpoint, costUsd = 0, ok = true, error = null, itemId = null, userId = null }) {
  try {
    db.prepare(`INSERT INTO ai_usage_log
      (provider, endpoint, related_item_id, cost_usd, cost_inr, ok, error, created_by)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run('fal', endpoint, itemId, costUsd, usdToInr(costUsd), ok ? 1 : 0, error, userId);
  } catch (e) {
    // Never let logging fail the actual call.
    console.error('[falai] usage log failed:', e.message);
  }
}

// ── Key validation (FREE — no compute charged) ───────────────────────
//
// Strategy: POST a deliberately-malformed body to a real model endpoint.
// fal.ai authenticates BEFORE compute; bad input produces a 422 with no
// charge. Auth failures produce 401/403. So:
//   401/403 → key invalid
//   422/400 → key VALID (just rejected our garbage) — what we want
//   200     → also valid (rare, only if model is forgiving)
//   5xx/network → service hiccup, retry later
async function ping({ apiKey }) {
  if (!apiKey || !apiKey.includes(':')) {
    return { ok: false, error: 'API key looks malformed — should be "id:secret" from fal.ai dashboard.' };
  }
  const url = FAL_BASE + '/fal-ai/birefnet';
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': authHeader(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_url: 'about:blank' }),
    });
  } catch (e) {
    logUsage({ endpoint: 'ping', ok: false, error: 'network: ' + e.message });
    return { ok: false, error: 'Network error reaching fal.ai: ' + e.message };
  }
  const text = await resp.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON, fine */ }
  const detail = body && (body.detail || body.message || body.error) || '';
  // fal.ai uses 403 for two very different conditions:
  //   • "User is locked. Reason: Exhausted balance." — key is FINE, account
  //     just needs a top-up. We treat this as a successful auth check + a
  //     warning, not as an invalid key.
  //   • Plain auth failure — key really is wrong.
  // The detail string is our only reliable discriminator.
  const looksLikeBalance = /exhaust|balance|top.?up|locked/i.test(detail);
  if ((resp.status === 401 || resp.status === 403) && !looksLikeBalance) {
    logUsage({ endpoint: 'ping', ok: false, error: 'auth ' + resp.status + ': ' + detail });
    return { ok: false, status: resp.status, error: 'fal.ai rejected the key (' + (detail || 'HTTP ' + resp.status) + '). Verify it in your fal.ai dashboard → API Keys.' };
  }
  if (looksLikeBalance) {
    // Auth was fine — fal.ai recognised the user, just refused to spend.
    // Surface this clearly so the owner doesn't waste time rotating keys.
    logUsage({ endpoint: 'ping', ok: true, error: 'balance: ' + detail });
    return {
      ok: true,
      status: resp.status,
      note: 'Key works, but your fal.ai balance is empty. Top up at fal.ai/dashboard/billing — generation will fail until then.',
      warning: detail,
    };
  }
  // Anything else means the key was accepted (input validation failed, model
  // refused garbage URL, etc.) — and crucially, no compute was billed.
  logUsage({ endpoint: 'ping', ok: true });
  return {
    ok: true,
    status: resp.status,
    note: 'Key accepted by fal.ai (no compute charged for this test).',
    response: text.slice(0, 200),
  };
}

module.exports = { ping, logUsage, usdToInr, FAL_BASE };
