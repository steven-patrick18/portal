// Dealer Reward Offers — gift/trip campaigns on cleared payment.
// List/create schemes, define reward tiers, see eligible dealers for the
// window and mark rewards delivered. Salespeople (view) see only their dealers.
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { getUserLevel, LEVEL_ORDER } = require('../middleware/permissions');
const { getScopeUserIds } = require('../middleware/scope');
const off = require('../utils/offers');
const router = express.Router();

// Reward photo uploads → public/uploads/offers.
const UP_ROOT = path.join(__dirname, '..', '..', 'public', 'uploads', 'offers');
function upDir() { if (!fs.existsSync(UP_ROOT)) fs.mkdirSync(UP_ROOT, { recursive: true }); return UP_ROOT; }
const rel = (p) => '/uploads/offers/' + path.relative(UP_ROOT, p).replace(/\\/g, '/');
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, upDir()),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg';
      cb(null, 'rw_' + Date.now() + '_' + require('crypto').randomBytes(3).toString('hex') + ext);
    },
  }),
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//i.test(file.mimetype)),
});
const MAX_IMG = 4;
const tierImgs = (t) => { try { return JSON.parse(t.images_json || '[]') || []; } catch (_) { return []; } };
function saveTierImages(tierId, add) {
  const t = db.prepare('SELECT images_json FROM offer_tiers WHERE id=?').get(tierId);
  if (!t) return;
  const imgs = (tierImgs(t).concat(add)).slice(0, MAX_IMG);
  db.prepare('UPDATE offer_tiers SET images_json=? WHERE id=?').run(JSON.stringify(imgs), tierId);
}

const canManage = (req) => LEVEL_ORDER[getUserLevel(req.session.user, 'offers')] >= LEVEL_ORDER.full;
function requireManage(req, res, next) {
  if (canManage(req)) return next();
  flash(req, 'danger', 'You do not have permission to manage offers.');
  return res.redirect('/offers');
}
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const KINDS = new Set(['yearly', 'seasonal', 'festival']);

// ── Offers list ────────────────────────────────────────────────
router.get('/', (req, res) => {
  const scopeIds = getScopeUserIds(req);
  const list = off.schemes().map(s => {
    const t = off.tiers(s.id);
    const elig = off.eligibleDealers(s, t, scopeIds);
    const delivered = elig.filter(e => e.award).length;
    const running = (!s.from_date || s.from_date <= today()) && (!s.to_date || s.to_date >= today()) && s.active;
    return { ...s, tierCount: t.length, eligible: elig.length, delivered, pending: elig.length - delivered, running };
  });
  res.render('offers/index', { title: 'Dealer Offers', list, canManage: canManage(req), today: today() });
});

// ── Create / edit a scheme ─────────────────────────────────────
const FILTERS = new Set(['all', 'new', 'inactive', 'selected']);
router.post('/', requireManage, (req, res) => {
  const f = req.body;
  const name = (f.name || '').trim();
  if (!name) { flash(req, 'danger', 'Offer name is required.'); return res.redirect('/offers'); }
  const kind = KINDS.has(f.kind) ? f.kind : 'seasonal';
  const from = f.from_date || null, to = f.to_date || null;
  // Upgrade A/C fields. 'new' and 'inactive' need a From date to anchor on.
  let filterKind = FILTERS.has(f.filter_kind) ? f.filter_kind : 'all';
  const filterDays = Math.max(0, parseInt(f.filter_days, 10) || 0) || null;
  const ontimeDays = Math.max(0, parseInt(f.ontime_days, 10) || 0) || null;
  if ((filterKind === 'new' || filterKind === 'inactive') && !from) {
    flash(req, 'warning', 'The "' + filterKind + '" filter needs a From date — saved as All dealers. Set a From date and change the filter.');
    filterKind = 'all';
  }
  if (filterKind === 'inactive' && !filterDays) {
    flash(req, 'warning', 'The inactive filter needs a number of days — saved as All dealers.');
    filterKind = 'all';
  }
  let id = parseInt(f.id, 10) || null;
  if (id) {
    db.prepare('UPDATE offer_schemes SET name=?, kind=?, from_date=?, to_date=?, note=?, filter_kind=?, filter_days=?, ontime_days=?, active=? WHERE id=?')
      .run(name, kind, from, to, f.note || null, filterKind, filterDays, ontimeDays, f.active ? 1 : 0, id);
    flash(req, 'success', 'Offer updated.');
  } else {
    const r = db.prepare('INSERT INTO offer_schemes (name, kind, from_date, to_date, note, filter_kind, filter_days, ontime_days, active) VALUES (?,?,?,?,?,?,?,?,1)')
      .run(name, kind, from, to, f.note || null, filterKind, filterDays, ontimeDays);
    id = r.lastInsertRowid;
    flash(req, 'success', 'Offer created — now add reward tiers.');
  }
  // Hand-picked dealers (multi-select on the offer page).
  if (filterKind === 'selected' && f.dealer_ids !== undefined) {
    off.setSelectedDealers(id, Array.isArray(f.dealer_ids) ? f.dealer_ids : [f.dealer_ids]);
  }
  res.redirect('/offers/' + id);
});

// Send the congratulation SMS to every eligible dealer not yet notified.
router.post('/:id/notify', requireManage, async (req, res) => {
  try {
    const r = await off.notifyEligible(req.params.id);
    flash(req, r.sent ? 'success' : 'info', `SMS: ${r.sent} sent · ${r.failed} failed · ${r.skipped} already notified.`);
  } catch (e) { flash(req, 'danger', 'Could not send: ' + e.message); }
  res.redirect('/offers/' + req.params.id);
});
router.post('/:id/toggle', requireManage, (req, res) => {
  db.prepare('UPDATE offer_schemes SET active = CASE active WHEN 1 THEN 0 ELSE 1 END WHERE id=?').run(req.params.id);
  res.redirect('/offers/' + req.params.id);
});
router.post('/:id/delete', requireManage, (req, res) => {
  db.prepare('DELETE FROM offer_tiers WHERE scheme_id=?').run(req.params.id);
  db.prepare('DELETE FROM offer_awards WHERE scheme_id=?').run(req.params.id);
  db.prepare('DELETE FROM offer_schemes WHERE id=?').run(req.params.id);
  flash(req, 'success', 'Offer deleted.');
  res.redirect('/offers');
});

// ── Reward tiers ───────────────────────────────────────────────
router.post('/:id/tier', requireManage, upload.array('photos', MAX_IMG), (req, res) => {
  const min = Math.max(0, parseFloat(req.body.min_amount) || 0);
  const reward = (req.body.reward || '').trim();
  if (reward) {
    const imgs = (req.files || []).map(f => rel(f.path));
    db.prepare('INSERT INTO offer_tiers (scheme_id, min_amount, reward, images_json) VALUES (?,?,?,?)')
      .run(req.params.id, min, reward, imgs.length ? JSON.stringify(imgs) : null);
  } else flash(req, 'danger', 'Reward name is required.');
  res.redirect('/offers/' + req.params.id);
});
// Add more photos to an existing tier (up to MAX_IMG total).
router.post('/tier/:tid/photos', requireManage, upload.array('photos', MAX_IMG), (req, res) => {
  const t = db.prepare('SELECT scheme_id FROM offer_tiers WHERE id=?').get(req.params.tid);
  if (t && req.files && req.files.length) saveTierImages(req.params.tid, req.files.map(f => rel(f.path)));
  res.redirect('/offers/' + (t ? t.scheme_id : ''));
});
// Remove one photo from a tier by its path.
router.post('/tier/:tid/photo/delete', requireManage, (req, res) => {
  const t = db.prepare('SELECT scheme_id, images_json FROM offer_tiers WHERE id=?').get(req.params.tid);
  if (t) {
    const imgs = tierImgs(t).filter(p => p !== req.body.path);
    db.prepare('UPDATE offer_tiers SET images_json=? WHERE id=?').run(imgs.length ? JSON.stringify(imgs) : null, req.params.tid);
  }
  res.redirect('/offers/' + (t ? t.scheme_id : ''));
});
router.post('/tier/:tid/delete', requireManage, (req, res) => {
  const t = db.prepare('SELECT scheme_id FROM offer_tiers WHERE id=?').get(req.params.tid);
  db.prepare('DELETE FROM offer_tiers WHERE id=?').run(req.params.tid);
  res.redirect('/offers/' + (t ? t.scheme_id : ''));
});

// ── Deliver / un-deliver a reward to a dealer ──────────────────
router.post('/:id/deliver', requireManage, (req, res) => {
  const f = req.body;
  const dealerId = parseInt(f.dealer_id, 10);
  if (dealerId) {
    db.prepare(`INSERT INTO offer_awards (scheme_id, dealer_id, tier_id, reward, amount, delivered_date, note, created_by)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(scheme_id, dealer_id) DO UPDATE SET tier_id=excluded.tier_id, reward=excluded.reward,
        amount=excluded.amount, delivered_date=excluded.delivered_date, note=excluded.note`)
      .run(req.params.id, dealerId, parseInt(f.tier_id, 10) || null, f.reward || null,
           parseFloat(f.amount) || 0, f.delivered_date || today(), f.note || null, req.session.user.id);
    flash(req, 'success', 'Marked delivered.');
  }
  res.redirect('/offers/' + req.params.id);
});
router.post('/:id/undeliver', requireManage, (req, res) => {
  db.prepare('DELETE FROM offer_awards WHERE scheme_id=? AND dealer_id=?').run(req.params.id, parseInt(req.body.dealer_id, 10) || 0);
  flash(req, 'success', 'Marked pending again.');
  res.redirect('/offers/' + req.params.id);
});

// ── Scheme detail (tiers + eligible dealers) ───────────────────
router.get('/:id', (req, res) => {
  const s = off.scheme(req.params.id);
  if (!s) return res.redirect('/offers');
  const t = off.tiers(s.id);
  const eligible = off.eligibleDealers(s, t, getScopeUserIds(req));
  const delivered = eligible.filter(e => e.award).length;
  // For the filter editor: dealer picker + current selection; SMS template state.
  const allDealers = db.prepare('SELECT id, name, code, city FROM dealers WHERE active=1 ORDER BY name').all();
  const selectedIds = off.selectedDealerIds(s.id);
  let smsReady = false;
  try { smsReady = !!require('../utils/notify').templateFor('offer'); } catch (_) {}
  res.render('offers/show', {
    title: s.name, s, tiers: t, eligible,
    stats: { eligible: eligible.length, delivered, pending: eligible.length - delivered },
    allDealers, selectedIds, smsReady, filterLabels: off.FILTER_LABEL,
    canManage: canManage(req), today: today(),
  });
});

module.exports = router;
