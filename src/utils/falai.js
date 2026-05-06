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
  // fal.ai returns 403 for several distinct conditions; the message body
  // is the only reliable discriminator. We map each to its own actionable
  // hint so the owner doesn't waste time on the wrong fix.
  const looksLikeBalance = /exhaust|insufficient|top.?up/i.test(detail);
  const looksLikeAdminLock = /admin\s*lock|contact.*support|suspended/i.test(detail);
  const looksLikeAnyLock = /\block|locked\b/i.test(detail);

  if ((resp.status === 401 || resp.status === 403) && !looksLikeBalance && !looksLikeAnyLock) {
    logUsage({ endpoint: 'ping', ok: false, error: 'auth ' + resp.status + ': ' + detail });
    return { ok: false, status: resp.status, error: 'fal.ai rejected the key (' + (detail || 'HTTP ' + resp.status) + '). Verify it in your fal.ai dashboard → API Keys.' };
  }
  if (looksLikeAdminLock) {
    // Account is admin-locked at fal.ai's end. Balance + key are not the
    // problem — owner needs to email support to unlock.
    logUsage({ endpoint: 'ping', ok: true, error: 'admin_lock: ' + detail });
    return {
      ok: true,
      status: resp.status,
      note: 'Key is valid, but your fal.ai account is locked by their admin. Email support@fal.ai to request unlock — generation will fail until they review.',
      warning: detail,
    };
  }
  if (looksLikeBalance) {
    // Auth was fine — fal.ai recognised the user, just no balance.
    logUsage({ endpoint: 'ping', ok: true, error: 'balance: ' + detail });
    return {
      ok: true,
      status: resp.status,
      note: 'Key works, but your fal.ai balance is empty. Top up at fal.ai/dashboard/billing — generation will fail until then.',
      warning: detail,
    };
  }
  if (looksLikeAnyLock) {
    // Generic lock — same actionable result as admin lock, just less
    // specific. Fail-safe to "contact support" rather than guessing.
    logUsage({ endpoint: 'ping', ok: true, error: 'locked: ' + detail });
    return {
      ok: true,
      status: resp.status,
      note: 'Key is valid, but your fal.ai account is locked. Visit fal.ai/dashboard or email support@fal.ai to find out why.',
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

// ── Image upload helper ──────────────────────────────────────────
//
// fal.ai endpoints take an image_url, not a raw upload. The platform offers
// `https://rest.alpha.fal.ai/storage/upload` (auth required, returns a URL
// that fal models can fetch). Phase B uploads our local file there and
// hands the returned URL to the inference endpoint.
async function uploadFile({ apiKey, filePath, mimeType = 'image/jpeg' }) {
  const fs = require('fs');
  const path = require('path');
  const buf = fs.readFileSync(filePath);
  // Step 1: ask fal for a signed PUT URL
  const initResp = await fetch('https://rest.alpha.fal.ai/storage/upload/initiate', {
    method: 'POST',
    headers: { 'Authorization': authHeader(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({ content_type: mimeType, file_name: path.basename(filePath) }),
  });
  if (!initResp.ok) {
    const text = await initResp.text();
    throw new Error('fal upload-init failed: HTTP ' + initResp.status + ' ' + text.slice(0, 200));
  }
  const init = await initResp.json();
  const putUrl = init.upload_url || init.url;
  const fileUrl = init.file_url || init.public_url || init.url;
  if (!putUrl) throw new Error('fal upload-init returned no upload_url');
  // Step 2: PUT the bytes
  const putResp = await fetch(putUrl, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType },
    body: buf,
  });
  if (!putResp.ok) {
    throw new Error('fal upload PUT failed: HTTP ' + putResp.status);
  }
  return fileUrl;
}

// ── Background removal (BiRefNet) ────────────────────────────────
// Returns { ok, url, costUsd } or { ok: false, error }.
async function removeBackground({ apiKey, imageUrl, itemId = null, userId = null }) {
  const url = FAL_BASE + '/fal-ai/birefnet';
  const COST_USD = 0.01; // BiRefNet pricing (approx, fal.ai may adjust)
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': authHeader(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_url: imageUrl }),
    });
  } catch (e) {
    logUsage({ endpoint: 'birefnet', ok: false, error: 'network: ' + e.message, itemId, userId });
    return { ok: false, error: 'Network: ' + e.message };
  }
  const text = await resp.text();
  let body = null; try { body = JSON.parse(text); } catch {}
  if (!resp.ok) {
    logUsage({ endpoint: 'birefnet', ok: false, error: 'http ' + resp.status, itemId, userId });
    return { ok: false, error: (body && (body.detail || body.error)) || ('HTTP ' + resp.status), status: resp.status };
  }
  // BiRefNet returns { image: { url } } typically
  const outUrl = (body && body.image && body.image.url) || (body && body.url);
  logUsage({ endpoint: 'birefnet', ok: !!outUrl, costUsd: COST_USD, itemId, userId, error: outUrl ? null : 'no output url' });
  return { ok: !!outUrl, url: outUrl, costUsd: COST_USD, raw: body };
}

// ── Virtual try-on (IDM-VTON — primary, gold-standard) ───────────
//
// IDM-VTON is the academic state-of-the-art for virtual try-on (Choi et
// al. 2024). Higher fidelity than CAT-VTON, especially for fine fabric
// detail and lower-body garments (jeans, skirts, sarees). Uses a free-
// form `description` instead of a rigid cloth_type enum — we synthesise
// it from the item name + cloth-type hint so the AI gets natural-
// language context like "Blue denim jeans, lower-body garment".
//
// Schema verified from fal.ai's OpenAPI:
//   human_image_url   (required)
//   garment_image_url (required)
//   description       (required, free text)
//   num_inference_steps (default 30) — bumped to 35 for crisper detail
//   seed              (default 42)
async function tryOn({ apiKey, modelImageUrl, garmentImageUrl, description, clothType = 'upper', itemId = null, userId = null }) {
  // Synthesise a sensible description if the caller didn't pass one.
  // IDM-VTON uses this to understand "what am I dressing the model in".
  const fallbackDesc =
    clothType === 'lower'   ? 'lower-body garment, trousers or jeans or skirt'
  : clothType === 'overall' ? 'full-length garment, dress or saree or one-piece outfit'
                            : 'upper-body garment, shirt or kurti or blouse or top';
  const desc = (description && String(description).trim()) || fallbackDesc;

  const url = FAL_BASE + '/fal-ai/idm-vton';
  const COST_USD = 0.04;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': authHeader(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        human_image_url:   modelImageUrl,
        garment_image_url: garmentImageUrl,
        description:       desc,
        num_inference_steps: 35,
      }),
    });
  } catch (e) {
    logUsage({ endpoint: 'idm-vton', ok: false, error: 'network: ' + e.message, itemId, userId });
    return { ok: false, error: 'Network: ' + e.message };
  }
  const text = await resp.text();
  let body = null; try { body = JSON.parse(text); } catch {}
  if (!resp.ok) {
    logUsage({ endpoint: 'idm-vton', ok: false, error: 'http ' + resp.status, itemId, userId });
    return { ok: false, error: (body && (body.detail || body.error)) || ('HTTP ' + resp.status), status: resp.status };
  }
  const outUrl = (body && body.image && body.image.url) || (body && body.url);
  logUsage({ endpoint: 'idm-vton', ok: !!outUrl, costUsd: COST_USD, itemId, userId, error: outUrl ? null : 'no output url' });
  return { ok: !!outUrl, url: outUrl, costUsd: COST_USD, raw: body };
}

// CAT-VTON kept as fallback only — used by the pipeline when IDM-VTON
// errors out for any reason. Cheaper but less faithful.
async function tryOnFallback({ apiKey, modelImageUrl, garmentImageUrl, clothType = 'upper', itemId = null, userId = null }) {
  const url = FAL_BASE + '/fal-ai/cat-vton';
  const COST_USD = 0.03;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': authHeader(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        human_image_url:   modelImageUrl,
        garment_image_url: garmentImageUrl,
        cloth_type:        ['upper', 'lower', 'overall'].includes(clothType) ? clothType : 'upper',
      }),
    });
  } catch (e) {
    logUsage({ endpoint: 'cat-vton-fallback', ok: false, error: 'network: ' + e.message, itemId, userId });
    return { ok: false, error: 'Network: ' + e.message };
  }
  const text = await resp.text();
  let body = null; try { body = JSON.parse(text); } catch {}
  if (!resp.ok) {
    logUsage({ endpoint: 'cat-vton-fallback', ok: false, error: 'http ' + resp.status, itemId, userId });
    return { ok: false, error: (body && (body.detail || body.error)) || ('HTTP ' + resp.status), status: resp.status };
  }
  const outUrl = (body && body.image && body.image.url) || (body && body.url);
  logUsage({ endpoint: 'cat-vton-fallback', ok: !!outUrl, costUsd: COST_USD, itemId, userId, error: outUrl ? null : 'no output url' });
  return { ok: !!outUrl, url: outUrl, costUsd: COST_USD, raw: body };
}

// ── Text-to-image (FLUX schnell) — used to generate default AI models ──
//
// FLUX schnell is fal.ai's fastest text-to-image model (~3s per image,
// ~$0.003 per call). We use it to create the standard model templates
// (front/side/3-quarter/back × male/female) so the owner doesn't have to
// upload real photos. Output is a portrait suitable for CAT-VTON input.
async function generateModel({ apiKey, prompt, itemId = null, userId = null }) {
  const url = FAL_BASE + '/fal-ai/flux/schnell';
  const COST_USD = 0.003;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': authHeader(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        image_size: 'portrait_4_3',  // tall, suits a person standing
        num_inference_steps: 4,
        num_images: 1,
        enable_safety_checker: true,
      }),
    });
  } catch (e) {
    logUsage({ endpoint: 'flux-schnell', ok: false, error: 'network: ' + e.message, itemId, userId });
    return { ok: false, error: 'Network: ' + e.message };
  }
  const text = await resp.text();
  let body = null; try { body = JSON.parse(text); } catch {}
  if (!resp.ok) {
    logUsage({ endpoint: 'flux-schnell', ok: false, error: 'http ' + resp.status, itemId, userId });
    return { ok: false, error: (body && (body.detail || body.error)) || ('HTTP ' + resp.status), status: resp.status };
  }
  // FLUX returns { images: [{ url, ... }] }
  const outUrl = body && body.images && body.images[0] && body.images[0].url;
  logUsage({ endpoint: 'flux-schnell', ok: !!outUrl, costUsd: COST_USD, itemId, userId, error: outUrl ? null : 'no output url' });
  return { ok: !!outUrl, url: outUrl, costUsd: COST_USD, raw: body };
}

// ── Relight + background swap (IC-Light v2) ─────────────────────
//
// Takes the model+garment composite from CAT-VTON and re-renders it
// against a luxury-style scene (studio noir, marble gallery, rooftop dusk).
// Same subject, new lighting + background based on the prompt.
// ~$0.04 per call.
async function relightScene({ apiKey, imageUrl, prompt, itemId = null, userId = null }) {
  const url = FAL_BASE + '/fal-ai/iclight-v2';
  const COST_USD = 0.04;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': authHeader(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_url: imageUrl,
        prompt,
        // Conservative tuning — early tests showed iclight at the
        // default guidance was redrawing fine fabric detail (denim
        // weave, kurti embroidery) to "match" the scene prompt. Lower
        // guidance + slightly fewer steps preserve the actual garment
        // far more faithfully while still doing the lighting swap.
        num_inference_steps: 20,
        guidance_scale: 3,
      }),
    });
  } catch (e) {
    logUsage({ endpoint: 'iclight-v2', ok: false, error: 'network: ' + e.message, itemId, userId });
    return { ok: false, error: 'Network: ' + e.message };
  }
  const text = await resp.text();
  let body = null; try { body = JSON.parse(text); } catch {}
  if (!resp.ok) {
    logUsage({ endpoint: 'iclight-v2', ok: false, error: 'http ' + resp.status, itemId, userId });
    return { ok: false, error: (body && (body.detail || body.error)) || ('HTTP ' + resp.status), status: resp.status };
  }
  const outUrl = (body && body.images && body.images[0] && body.images[0].url)
              || (body && body.image && body.image.url)
              || (body && body.url);
  logUsage({ endpoint: 'iclight-v2', ok: !!outUrl, costUsd: COST_USD, itemId, userId, error: outUrl ? null : 'no output url' });
  return { ok: !!outUrl, url: outUrl, costUsd: COST_USD, raw: body };
}

// ── Editorial copy (LLM via fal-ai/any-llm) ──────────────────────
//
// Generates a 2-line luxury-voice product blurb. Cheap (~$0.0005 per
// call). Falls back to the item name if the LLM call fails so the
// pipeline never blocks on a small text generation.
async function editorialCopy({ apiKey, name, garmentType = 'upper', notes = '', itemId = null, userId = null }) {
  const url = FAL_BASE + '/fal-ai/any-llm';
  const COST_USD = 0.0005;
  const garmentLabel = garmentType === 'lower' ? 'trouser/skirt' : garmentType === 'overall' ? 'full outfit' : 'top/shirt';
  const system = 'You write in the voice of a luxury fashion house. Two sentences max, total under 30 words. Sparse, sensory, never markety. No exclamation marks. No quotes around the output.';
  const user = `Write a 2-line catalogue blurb for an Indian garment-manufacturer item called "${name}" (${garmentLabel}${notes ? ', notes: ' + notes : ''}). Editorial tone — like Prada or Hermès would write. Don't mention India or the brand name.`;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': authHeader(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic/claude-3-5-haiku',
        prompt: user,
        system_prompt: system,
      }),
    });
  } catch (e) {
    logUsage({ endpoint: 'any-llm', ok: false, error: 'network: ' + e.message, itemId, userId });
    return { ok: false, error: 'Network: ' + e.message };
  }
  const text = await resp.text();
  let body = null; try { body = JSON.parse(text); } catch {}
  if (!resp.ok) {
    logUsage({ endpoint: 'any-llm', ok: false, error: 'http ' + resp.status, itemId, userId });
    return { ok: false, error: (body && (body.detail || body.error)) || ('HTTP ' + resp.status), status: resp.status };
  }
  const out = (body && (body.output || body.text || body.completion || body.content)) || '';
  const trimmed = String(out).trim().replace(/^["']+|["']+$/g, '').slice(0, 280);
  logUsage({ endpoint: 'any-llm', ok: !!trimmed, costUsd: COST_USD, itemId, userId, error: trimmed ? null : 'empty output' });
  return { ok: !!trimmed, copy: trimmed, costUsd: COST_USD };
}

// Download a remote URL (e.g. fal.ai output) to a local file path.
async function downloadTo(url, destPath) {
  const fs = require('fs');
  const r = await fetch(url);
  if (!r.ok) throw new Error('Download failed: HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return destPath;
}

module.exports = { ping, logUsage, usdToInr, uploadFile, removeBackground, tryOn, tryOnFallback, generateModel, relightScene, editorialCopy, downloadTo, FAL_BASE };
