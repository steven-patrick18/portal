// Catalogue module — standalone AI catalogue generator.
//
// Phase A scope (this file): list page + Settings → AI Catalogue
// (paste API key, set budgets, test connection for free, see usage).
// Phase B will add upload + generate.
//
// All settings live in app_settings under the AI_* prefix so dropping the
// module is a clean operation: rm route + rm tables + rm sidebar entry.

const express = require('express');
const { db } = require('../db');
const { requireOwner, flash } = require('../middleware/auth');
const falai = require('../utils/falai');

const router = express.Router();

// Helpers — reuse the same get/set pattern as src/routes/settings.js so
// the keys live in one place and the existing System & Updates page can
// inspect them too.
function getSetting(key, fallback = '') {
  const r = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  return r ? r.value : (process.env[key] || fallback);
}
function setSetting(key, value, userId) {
  db.prepare(`INSERT INTO app_settings (key, value, updated_by) VALUES (?,?,?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now'), updated_by=excluded.updated_by`)
    .run(key, value || '', userId || null);
}

// Mask an API key for display: show first 8 + last 4, hide the middle.
function maskKey(k) {
  if (!k) return '';
  if (k.length <= 14) return k.slice(0, 4) + '…';
  return k.slice(0, 8) + '…' + k.slice(-4);
}

// Sum INR cost for a given window. Defaults to "this calendar month" so
// the user has a budget anchor that matches how they think about spend.
function spendThisMonth() {
  const r = db.prepare(`
    SELECT COALESCE(SUM(cost_inr), 0) AS total, COUNT(*) AS calls
    FROM ai_usage_log
    WHERE created_at >= strftime('%Y-%m-01', 'now')
  `).get();
  return { totalInr: r.total, calls: r.calls };
}

// ── Catalogue list (skeleton — Phase A renders empty + a CTA card) ──
router.get('/', (req, res) => {
  const items = db.prepare(`
    SELECT id, name, status, total_cost_inr, created_at
    FROM catalogue_items
    ORDER BY id DESC
    LIMIT 50
  `).all();
  res.render('catalogue/index', { title: 'Catalogue', items });
});

// ── Settings page — owner-only ────────────────────────────────────
// Even though the mount-level guard already gates `catalogue` at a high
// level, the Settings sub-page that lets you paste the key + change
// budgets is owner-only. Admins who get `catalogue` access can browse
// and (later) trigger generation, but cannot rotate the API key.
router.get('/settings', requireOwner, (req, res) => {
  const cfg = {
    provider:        getSetting('AI_PROVIDER', 'off'),
    apiKey:          getSetting('FAL_API_KEY', ''),
    budgetPerItem:   getSetting('AI_BUDGET_PER_ITEM_INR', '40'),
    budgetMonthly:   getSetting('AI_BUDGET_MONTHLY_INR', '2000'),
    usdInr:          getSetting('USD_TO_INR_RATE', '84'),
  };
  res.render('catalogue/settings', {
    title: 'AI Catalogue Settings',
    cfg,
    apiKeyMasked: maskKey(cfg.apiKey),
    spend: spendThisMonth(),
  });
});

router.post('/settings', requireOwner, (req, res) => {
  const u = req.session.user.id;
  const { provider, api_key, budget_per_item, budget_monthly, usd_inr, clear_key } = req.body;

  if (clear_key === '1') {
    setSetting('FAL_API_KEY', '', u);
  } else if (api_key && api_key.trim() && !api_key.includes('…')) {
    // Only update the key if user typed a fresh value — the masked
    // version (`abcd…wxyz`) is a display-only placeholder; ignore it.
    setSetting('FAL_API_KEY', api_key.trim(), u);
  }
  setSetting('AI_PROVIDER',          (provider === 'fal' ? 'fal' : 'off'), u);
  setSetting('AI_BUDGET_PER_ITEM_INR', String(parseFloat(budget_per_item) || 40), u);
  setSetting('AI_BUDGET_MONTHLY_INR',  String(parseFloat(budget_monthly) || 2000), u);
  setSetting('USD_TO_INR_RATE',        String(parseFloat(usd_inr) || 84), u);

  req.audit('settings_save', 'ai_catalogue', null,
    `provider=${provider} per_item=${budget_per_item} monthly=${budget_monthly}${clear_key === '1' ? ' (key cleared)' : (api_key && !api_key.includes('…') ? ' (key updated)' : '')}`);
  flash(req, 'success', 'AI Catalogue settings saved.');
  res.redirect('/catalogue/settings');
});

// ── Free key validation — JSON, called by the "Test Connection" button ──
router.post('/settings/test', requireOwner, async (req, res) => {
  const apiKey = getSetting('FAL_API_KEY', '');
  if (!apiKey) return res.json({ ok: false, error: 'No API key saved yet — paste one and click Save first.' });
  const result = await falai.ping({ apiKey });
  res.json(result);
});

// ── Usage / spend JSON for live UI ────────────────────────────────
router.get('/settings/usage', requireOwner, (req, res) => {
  const recent = db.prepare(`
    SELECT id, endpoint, cost_usd, cost_inr, ok, error, created_at
    FROM ai_usage_log
    ORDER BY id DESC
    LIMIT 20
  `).all();
  res.json({ spend: spendThisMonth(), recent });
});

module.exports = router;
