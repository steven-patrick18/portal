// Catalogue module — standalone AI catalogue generator.
//
// Phase A scope (this file): list page + Settings → AI Catalogue
// (paste API key, set budgets, test connection for free, see usage).
// Phase B will add upload + generate.
//
// All settings live in app_settings under the AI_* prefix so dropping the
// module is a clean operation: rm route + rm tables + rm sidebar entry.

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db } = require('../db');
const { requireOwner, flash } = require('../middleware/auth');
const falai = require('../utils/falai');
const pipeline = require('../utils/cataloguePipeline');

const router = express.Router();

// Per-item upload dir created lazily; templates share one dir.
const UPLOADS_ROOT = path.join(__dirname, '..', '..', 'public', 'uploads', 'catalogue');
const TEMPLATES_DIR = path.join(UPLOADS_ROOT, 'templates');
fs.mkdirSync(TEMPLATES_DIR, { recursive: true });

// Multer with memoryStorage for new-item uploads — we need req.body.name
// to be parsed BEFORE we can decide what dir to write to (the dir is named
// after the new item id which doesn't exist until we INSERT). Writing files
// manually after the INSERT is simpler than juggling temp dirs.
const memUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g|webp)$/i.test(file.mimetype)),
});
const templateUpload = multer({
  storage: multer.diskStorage({
    destination: TEMPLATES_DIR,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname).toLowerCase().match(/\.(jpe?g|png|webp)$/) || ['.jpg'])[0];
      cb(null, 'template_' + Date.now() + ext);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g|webp)$/i.test(file.mimetype)),
});

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

// ── Catalogue list ────────────────────────────────────────────────
router.get('/', (req, res) => {
  const items = db.prepare(`
    SELECT i.id, i.name, i.status, i.total_cost_inr, i.created_at,
           (SELECT file_path FROM catalogue_assets WHERE item_id=i.id AND kind='original_front' LIMIT 1) AS thumb,
           (SELECT COUNT(*) FROM catalogue_assets WHERE item_id=i.id AND kind='angle' AND file_path != '') AS angle_count
    FROM catalogue_items i
    ORDER BY i.id DESC
    LIMIT 100
  `).all();
  const templateCount = db.prepare("SELECT COUNT(*) AS n FROM catalogue_templates WHERE active=1").get().n;
  res.render('catalogue/index', { title: 'Catalogue', items, templateCount });
});

// ── New item — upload front + back ────────────────────────────────
router.get('/new', requireOwner, (req, res) => {
  const templateCount = db.prepare("SELECT COUNT(*) AS n FROM catalogue_templates WHERE active=1").get().n;
  res.render('catalogue/new', { title: 'New Catalogue Item', templateCount });
});

router.post('/new', requireOwner,
  memUpload.fields([{ name: 'front', maxCount: 1 }, { name: 'back', maxCount: 1 }]),
  (req, res) => {
    const { name, description } = req.body;
    if (!name || !name.trim()) { flash(req, 'danger', 'Name is required.'); return res.redirect('/catalogue/new'); }
    const files = req.files || {};
    if (!files.front || !files.front[0]) {
      flash(req, 'danger', 'Front photo is required.'); return res.redirect('/catalogue/new');
    }
    const r = db.prepare('INSERT INTO catalogue_items (name, description, status, created_by) VALUES (?,?,?,?)')
      .run(name.trim(), description || null, 'draft', req.session.user.id);
    const itemId = r.lastInsertRowid;
    req.audit('create', 'catalogue_item', itemId, name);

    // Write the in-memory uploads to disk under public/uploads/catalogue/<id>/
    const itemDir = path.join(UPLOADS_ROOT, String(itemId));
    fs.mkdirSync(itemDir, { recursive: true });
    function saveFile(field, kind) {
      const f = files[field] && files[field][0];
      if (!f) return;
      const ext = (path.extname(f.originalname).toLowerCase().match(/\.(jpe?g|png|webp)$/) || ['.jpg'])[0];
      const filename = field + ext;
      fs.writeFileSync(path.join(itemDir, filename), f.buffer);
      db.prepare(`INSERT INTO catalogue_assets (item_id, kind, source, file_path) VALUES (?,?,?,?)`)
        .run(itemId, kind, 'upload', '/uploads/catalogue/' + itemId + '/' + filename);
    }
    saveFile('front', 'original_front');
    saveFile('back',  'original_back');

    flash(req, 'success', 'Item created. Click Generate to render it on your model templates.');
    res.redirect('/catalogue/' + itemId);
  });

// ── Show item: thumbs of originals + gallery of generated assets ──
router.get('/:id(\\d+)', (req, res) => {
  const item = db.prepare('SELECT * FROM catalogue_items WHERE id=?').get(req.params.id);
  if (!item) { flash(req, 'danger', 'Item not found.'); return res.redirect('/catalogue'); }
  const originals = db.prepare("SELECT * FROM catalogue_assets WHERE item_id=? AND kind LIKE 'original_%' ORDER BY id").all(item.id);
  const angles    = db.prepare("SELECT * FROM catalogue_assets WHERE item_id=? AND kind='angle' ORDER BY id").all(item.id);
  const cutout    = db.prepare("SELECT * FROM catalogue_assets WHERE item_id=? AND kind='cutout' ORDER BY id DESC LIMIT 1").get(item.id);
  const job       = db.prepare("SELECT * FROM catalogue_jobs WHERE item_id=? ORDER BY id DESC LIMIT 1").get(item.id);
  const templates = db.prepare("SELECT id, name, pose_label, gender, file_path FROM catalogue_templates WHERE active=1 ORDER BY sort_order, id").all();
  const counts = {
    all:    templates.length,
    female: templates.filter(t => t.gender === 'female' || t.gender === 'unisex').length,
    male:   templates.filter(t => t.gender === 'male'   || t.gender === 'unisex').length,
  };
  res.render('catalogue/show', { title: item.name, item, originals, angles, cutout, job, templates, counts });
});

// ── Trigger generation (async; returns immediately) ──────────────
router.post('/:id(\\d+)/generate', requireOwner, (req, res) => {
  const item = db.prepare('SELECT * FROM catalogue_items WHERE id=?').get(req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: 'item not found' });
  // Refuse if already running.
  const inflight = db.prepare("SELECT id FROM catalogue_jobs WHERE item_id=? AND status IN ('queued','running')").get(item.id);
  if (inflight) return res.json({ ok: false, error: 'A job is already running for this item.', jobId: inflight.id });
  const gender = ['male', 'female', 'all'].includes(req.body.gender) ? req.body.gender : 'all';
  const jobId = pipeline.startGeneration(item.id, { gender });
  req.audit('catalogue_generate', 'catalogue_jobs', jobId, `item ${item.id} gender=${gender}`);
  res.json({ ok: true, jobId });
});

// ── Job status (polled by the show page) ──────────────────────────
router.get('/:id(\\d+)/status', (req, res) => {
  const job = db.prepare("SELECT * FROM catalogue_jobs WHERE item_id=? ORDER BY id DESC LIMIT 1").get(req.params.id);
  const angles = db.prepare("SELECT id, file_path, variant, cost_inr, metadata FROM catalogue_assets WHERE item_id=? AND kind='angle' ORDER BY id").all(req.params.id);
  res.json({ job: job || null, angles });
});

// ── Templates: list + upload + activate/deactivate + delete ──────
router.get('/templates', requireOwner, (req, res) => {
  const templates = db.prepare('SELECT * FROM catalogue_templates ORDER BY sort_order, id').all();
  res.render('catalogue/templates', { title: 'Catalogue Templates', templates });
});

router.post('/templates', requireOwner, templateUpload.single('image'), (req, res) => {
  if (!req.file) { flash(req, 'danger', 'Please choose an image.'); return res.redirect('/catalogue/templates'); }
  const { name, pose_label, variant, gender } = req.body;
  const safeGender = ['female', 'male', 'unisex'].includes(gender) ? gender : 'unisex';
  db.prepare(`INSERT INTO catalogue_templates (name, kind, variant, pose_label, gender, file_path, created_by)
              VALUES (?, 'model_pose', ?, ?, ?, ?, ?)`)
    .run((name || 'Template').trim(), variant || null, pose_label || null, safeGender,
         '/uploads/catalogue/templates/' + req.file.filename, req.session.user.id);
  flash(req, 'success', 'Template added.');
  res.redirect('/catalogue/templates');
});

router.post('/templates/:id(\\d+)/toggle', requireOwner, (req, res) => {
  db.prepare("UPDATE catalogue_templates SET active = CASE active WHEN 1 THEN 0 ELSE 1 END WHERE id=?").run(req.params.id);
  res.redirect('/catalogue/templates');
});

// ── Seed default AI models (text-to-image via FLUX schnell) ──────
//
// Generates 4 female + 4 male standard poses (front, side, 3-quarter,
// back) once, saves them as templates so the owner doesn't have to
// upload real model photos. Cost: ~₹2.50 (8 × ~₹0.30 each).
const DEFAULT_POSES = [
  { gender: 'female', pose: 'front',     prompt: 'full-body photograph of a young Indian woman wearing a plain white T-shirt and plain blue jeans, standing facing camera, neutral expression, arms relaxed, plain white studio background, soft even lighting, fashion catalog photography, hyper-realistic, sharp focus' },
  { gender: 'female', pose: '3-quarter', prompt: 'full-body photograph of a young Indian woman wearing a plain white T-shirt and plain blue jeans, three-quarter view, neutral expression, arms relaxed, plain white studio background, soft even lighting, fashion catalog photography, hyper-realistic, sharp focus' },
  { gender: 'female', pose: 'side',      prompt: 'full-body photograph of a young Indian woman wearing a plain white T-shirt and plain blue jeans, side profile view, neutral expression, arms relaxed, plain white studio background, soft even lighting, fashion catalog photography, hyper-realistic, sharp focus' },
  { gender: 'female', pose: 'back',      prompt: 'full-body photograph of a young Indian woman wearing a plain white T-shirt and plain blue jeans, back view facing away from camera, arms relaxed, plain white studio background, soft even lighting, fashion catalog photography, hyper-realistic, sharp focus' },
  { gender: 'male',   pose: 'front',     prompt: 'full-body photograph of a young Indian man wearing a plain white T-shirt and plain blue jeans, standing facing camera, neutral expression, arms relaxed, plain white studio background, soft even lighting, fashion catalog photography, hyper-realistic, sharp focus' },
  { gender: 'male',   pose: '3-quarter', prompt: 'full-body photograph of a young Indian man wearing a plain white T-shirt and plain blue jeans, three-quarter view, neutral expression, arms relaxed, plain white studio background, soft even lighting, fashion catalog photography, hyper-realistic, sharp focus' },
  { gender: 'male',   pose: 'side',      prompt: 'full-body photograph of a young Indian man wearing a plain white T-shirt and plain blue jeans, side profile view, neutral expression, arms relaxed, plain white studio background, soft even lighting, fashion catalog photography, hyper-realistic, sharp focus' },
  { gender: 'male',   pose: 'back',      prompt: 'full-body photograph of a young Indian man wearing a plain white T-shirt and plain blue jeans, back view facing away from camera, arms relaxed, plain white studio background, soft even lighting, fashion catalog photography, hyper-realistic, sharp focus' },
];

// Long-running — generates all 8 poses sequentially. Returns immediately
// with a "started" indicator; the templates page polls /templates/seed/status.
router.post('/templates/seed', requireOwner, (req, res) => {
  const apiKey = getSetting('FAL_API_KEY', '');
  const provider = getSetting('AI_PROVIDER', 'off');
  if (provider !== 'fal' || !apiKey) {
    return res.status(400).json({ ok: false, error: 'AI provider not configured. Save the fal.ai key under AI Settings first.' });
  }
  // Refuse if a seed run is already in flight.
  if (seedState.running) return res.json({ ok: false, error: 'A seed run is already in progress.' });

  const userId = req.session.user.id;
  seedState = { running: true, total: DEFAULT_POSES.length, done: 0, costInr: 0, error: null, startedAt: new Date().toISOString() };

  setImmediate(async () => {
    try {
      for (const pose of DEFAULT_POSES) {
        const r = await falai.generateModel({ apiKey, prompt: pose.prompt, userId });
        if (!r.ok) { seedState.error = r.error; continue; }
        seedState.costInr += falai.usdToInr(r.costUsd || 0);
        // Save to disk + insert template row.
        const filename = `default_${pose.gender}_${pose.pose}_${Date.now()}.jpg`;
        const dest = path.join(TEMPLATES_DIR, filename);
        try {
          await falai.downloadTo(r.url, dest);
          db.prepare(`INSERT INTO catalogue_templates (name, kind, variant, pose_label, gender, file_path, sort_order, created_by)
                      VALUES (?, 'model_pose', 'ai-default', ?, ?, ?, ?, ?)`)
            .run(`AI ${pose.gender} – ${pose.pose}`, pose.pose, pose.gender,
                 '/uploads/catalogue/templates/' + filename,
                 pose.gender === 'female' ? 10 : 20, userId);
        } catch (e) {
          seedState.error = 'save failed: ' + e.message;
          continue;
        }
        seedState.done++;
      }
    } catch (e) {
      seedState.error = e.message;
    } finally {
      seedState.running = false;
      seedState.finishedAt = new Date().toISOString();
    }
  });

  res.json({ ok: true, started: true });
});

// Module-scoped progress tracker (single seed run at a time, in memory).
let seedState = { running: false, total: 0, done: 0, costInr: 0, error: null };

router.get('/templates/seed/status', requireOwner, (req, res) => {
  res.json(seedState);
});

router.post('/templates/:id(\\d+)/delete', requireOwner, (req, res) => {
  const t = db.prepare('SELECT file_path FROM catalogue_templates WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM catalogue_templates WHERE id=?').run(req.params.id);
  if (t && t.file_path) {
    const abs = path.join(__dirname, '..', '..', 'public', t.file_path.replace(/^\//, ''));
    if (fs.existsSync(abs)) { try { fs.unlinkSync(abs); } catch (_) {} }
  }
  flash(req, 'success', 'Template removed.');
  res.redirect('/catalogue/templates');
});

// ── Delete an item (cleanup files + DB) ──────────────────────────
router.post('/:id(\\d+)/delete', requireOwner, (req, res) => {
  const itemDir = path.join(UPLOADS_ROOT, String(req.params.id));
  db.prepare('DELETE FROM catalogue_items WHERE id=?').run(req.params.id);
  if (fs.existsSync(itemDir)) {
    try { fs.rmSync(itemDir, { recursive: true, force: true }); } catch (_) {}
  }
  flash(req, 'success', 'Item deleted.');
  res.redirect('/catalogue');
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
