// Field → Team : Salesperson management cockpit.
// Targets & scorecard · auto incentive on collection · collections &
// outstanding · profile + manager hierarchy. Scoped: owner/admin/accountant
// see everyone; an area_manager sees self + reports; a salesperson sees only
// their own scorecard. 'full' on visits_team can set targets & schemes.
const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { getUserLevel, LEVEL_ORDER } = require('../middleware/permissions');
const { getScopeUserIds } = require('../middleware/scope');
const perf = require('../utils/salesPerf');
const router = express.Router();

const canManage = (req) => LEVEL_ORDER[getUserLevel(req.session.user, 'visits_team')] >= LEVEL_ORDER.full;
function requireManage(req, res, next) {
  if (canManage(req)) return next();
  flash(req, 'danger', 'You do not have permission to change targets or schemes.');
  return res.redirect('/visits/team');
}
// Period dropdown — 6 months ahead (to pre-set targets) down to 9 back,
// newest/future first.
function periodOptions() {
  const out = [];
  const now = new Date();
  for (let i = 6; i >= -9; i--) out.push(perf.periodOf(new Date(now.getFullYear(), now.getMonth() + i, 1)));
  return out;
}
// 'YYYY-MM' + k months.
function addMonths(period, k) {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(y, (m - 1) + k, 1);
  return perf.periodOf(d);
}
// Is this salesperson id visible to the current user?
function inScope(req, id) {
  const ids = getScopeUserIds(req);
  return ids === null || ids.includes(Number(id));
}

// ── Team cockpit (leaderboard) ─────────────────────────────────
router.get('/', (req, res) => {
  const period = /^\d{4}-\d{2}$/.test(req.query.period) ? req.query.period : perf.currentPeriod();
  const rows = perf.teamPerf(getScopeUserIds(req), period);
  // Rank by score (then collection) for the leaderboard medals.
  rows.sort((a, b) => (b.score || 0) - (a.score || 0) || b.actual.collection - a.actual.collection);
  const totals = rows.reduce((t, r) => ({
    sales: t.sales + r.actual.sales, collection: t.collection + r.actual.collection,
    outstanding: t.outstanding + r.outstanding, incentive: t.incentive + r.incentive,
    newDealers: t.newDealers + r.actual.newDealers,
    tSales: t.tSales + (r.target ? r.target.sales_target : 0),
    tColl: t.tColl + (r.target ? r.target.collection_target : 0),
  }), { sales: 0, collection: 0, outstanding: 0, incentive: 0, newDealers: 0, tSales: 0, tColl: 0 });
  res.render('visits/team', {
    title: 'Team Performance', rows, totals, period, periods: periodOptions(), curPeriod: perf.currentPeriod(),
    schemes: perf.listSchemes(), canManage: canManage(req),
  });
});

// ── Incentive schemes (manage) ─────────────────────────────────
router.get('/schemes', (req, res) => {
  res.render('visits/teamSchemes', { title: 'Incentive Schemes', schemes: perf.listSchemes(), canManage: canManage(req) });
});
router.post('/schemes', requireManage, (req, res) => {
  const f = req.body;
  const name = (f.name || '').trim();
  if (!name) { flash(req, 'danger', 'Scheme name is required.'); return res.redirect('/visits/team/schemes'); }
  const basis = f.basis === 'sales' ? 'sales' : 'collection';
  const pct = Math.max(0, parseFloat(f.pct) || 0);
  const minAch = Math.max(0, parseFloat(f.min_achievement_pct) || 0);
  // Optional slabs: "min:pct, min:pct" → JSON.
  let slabs = null;
  if (f.slabs && f.slabs.trim()) {
    const arr = f.slabs.split(',').map(s => s.trim()).filter(Boolean).map(s => {
      const [min, p] = s.split(':').map(x => parseFloat(x));
      return { min: min || 0, pct: p || 0 };
    }).filter(x => x.pct > 0);
    if (arr.length) slabs = JSON.stringify(arr);
  }
  if (f.id) {
    db.prepare(`UPDATE incentive_schemes SET name=?, basis=?, pct=?, slabs_json=?, min_achievement_pct=?, active=? WHERE id=?`)
      .run(name, basis, pct, slabs, minAch, f.active ? 1 : 0, f.id);
    flash(req, 'success', 'Scheme updated.');
  } else {
    db.prepare(`INSERT INTO incentive_schemes (name, basis, pct, slabs_json, min_achievement_pct, active) VALUES (?,?,?,?,?,1)`)
      .run(name, basis, pct, slabs, minAch);
    flash(req, 'success', 'Scheme added.');
  }
  res.redirect('/visits/team/schemes');
});
router.post('/schemes/:id/delete', requireManage, (req, res) => {
  db.prepare('UPDATE users SET incentive_scheme_id=NULL WHERE incentive_scheme_id=?').run(req.params.id);
  db.prepare('DELETE FROM incentive_schemes WHERE id=?').run(req.params.id);
  flash(req, 'success', 'Scheme removed.');
  res.redirect('/visits/team/schemes');
});

// ── Set a salesperson's monthly target ─────────────────────────
router.post('/targets', requireManage, (req, res) => {
  const f = req.body;
  const spId = parseInt(f.salesperson_id, 10);
  const period = /^\d{4}-\d{2}$/.test(f.period) ? f.period : perf.currentPeriod();
  // Optionally copy the same target to the next N months (pre-set ahead).
  const repeat = Math.min(11, Math.max(0, parseInt(f.repeat, 10) || 0));
  if (spId) {
    const t = {
      sales_target: parseFloat(f.sales_target) || 0,
      collection_target: parseFloat(f.collection_target) || 0,
      new_dealer_target: parseInt(f.new_dealer_target, 10) || 0,
      note: f.note,
    };
    for (let k = 0; k <= repeat; k++) perf.setTarget(spId, addMonths(period, k), t, req.session.user.id);
    flash(req, 'success', repeat ? `Target saved for ${period} + next ${repeat} month(s).` : 'Target saved.');
  }
  res.redirect('/visits/team' + (req.body.back === 'detail' ? ('/' + spId) : '') + '?period=' + period);
});

// Assign an incentive scheme to a salesperson.
router.post('/assign-scheme', requireManage, (req, res) => {
  const spId = parseInt(req.body.salesperson_id, 10);
  const schemeId = parseInt(req.body.scheme_id, 10) || null;
  if (spId) db.prepare('UPDATE users SET incentive_scheme_id=? WHERE id=?').run(schemeId, spId);
  flash(req, 'success', 'Scheme assigned.');
  res.redirect('/visits/team/' + spId);
});

// ── One salesperson's detail / scorecard ───────────────────────
router.get('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || !inScope(req, id)) { flash(req, 'warning', 'Not allowed.'); return res.redirect('/visits/team'); }
  const sp = perf.salespersons().find(s => s.id === id);
  if (!sp) return res.redirect('/visits/team');
  const period = /^\d{4}-\d{2}$/.test(req.query.period) ? req.query.period : perf.currentPeriod();
  const p = perf.perfFor(sp, period);
  res.render('visits/teamDetail', {
    title: sp.name + ' — Scorecard', sp, p, period, periods: periodOptions(), curPeriod: perf.currentPeriod(),
    dealers: perf.dealerOutstanding(id), trend: perf.trend(id, period),
    schemes: perf.listSchemes(), canManage: canManage(req),
  });
});

module.exports = router;
