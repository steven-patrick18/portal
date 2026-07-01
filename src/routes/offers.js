// Dealer Reward Offers — gift/trip campaigns on cleared payment.
// List/create schemes, define reward tiers, see eligible dealers for the
// window and mark rewards delivered. Salespeople (view) see only their dealers.
const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { getUserLevel, LEVEL_ORDER } = require('../middleware/permissions');
const { getScopeUserIds } = require('../middleware/scope');
const off = require('../utils/offers');
const router = express.Router();

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
router.post('/', requireManage, (req, res) => {
  const f = req.body;
  const name = (f.name || '').trim();
  if (!name) { flash(req, 'danger', 'Offer name is required.'); return res.redirect('/offers'); }
  const kind = KINDS.has(f.kind) ? f.kind : 'seasonal';
  const from = f.from_date || null, to = f.to_date || null;
  if (f.id) {
    db.prepare('UPDATE offer_schemes SET name=?, kind=?, from_date=?, to_date=?, note=?, active=? WHERE id=?')
      .run(name, kind, from, to, f.note || null, f.active ? 1 : 0, f.id);
    flash(req, 'success', 'Offer updated.');
    return res.redirect('/offers/' + f.id);
  }
  const r = db.prepare('INSERT INTO offer_schemes (name, kind, from_date, to_date, note, active) VALUES (?,?,?,?,?,1)')
    .run(name, kind, from, to, f.note || null);
  flash(req, 'success', 'Offer created — now add reward tiers.');
  res.redirect('/offers/' + r.lastInsertRowid);
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
router.post('/:id/tier', requireManage, (req, res) => {
  const min = Math.max(0, parseFloat(req.body.min_amount) || 0);
  const reward = (req.body.reward || '').trim();
  if (reward) db.prepare('INSERT INTO offer_tiers (scheme_id, min_amount, reward) VALUES (?,?,?)').run(req.params.id, min, reward);
  else flash(req, 'danger', 'Reward name is required.');
  res.redirect('/offers/' + req.params.id);
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
  res.render('offers/show', {
    title: s.name, s, tiers: t, eligible,
    stats: { eligible: eligible.length, delivered, pending: eligible.length - delivered },
    canManage: canManage(req), today: today(),
  });
});

module.exports = router;
