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
  const totals = rows.reduce((t, r) => {
    // Team rows repeat their subtree's combined figures — count only the
    // manager's OWN numbers here so month totals count each person once.
    // (Incentive is the exception: the manager's payout is real extra money.)
    const a = r.team ? perf.actuals(r.sp.id, period) : r.actual;
    const ownT = r.team ? perf.targetFor(r.sp.id, period) : r.target;
    const out = r.team ? perf.outstandingFor(r.sp.id) : r.outstanding;
    return {
      sales: t.sales + a.sales, collection: t.collection + a.collection,
      outstanding: t.outstanding + out, incentive: t.incentive + r.incentive,
      newDealers: t.newDealers + a.newDealers,
      tSales: t.tSales + (ownT ? ownT.sales_target : 0),
      tColl: t.tColl + (ownT ? ownT.collection_target : 0),
    };
  }, { sales: 0, collection: 0, outstanding: 0, incentive: 0, newDealers: 0, tSales: 0, tColl: 0 });
  // Drill-down links for the summary tiles — only where the viewer has access.
  const { from, to } = perf.monthRange(period);
  const lvl = (k) => LEVEL_ORDER[getUserLevel(req.session.user, k)] || 0;
  const links = {
    sales:       lvl('reports') >= LEVEL_ORDER.view ? `/reports/sales?from=${from}&to=${to}` : null,
    collection:  lvl('reports_finance') >= LEVEL_ORDER.view ? `/reports/collection?from=${from}&to=${to}` : null,
    outstanding: lvl('reports_finance') >= LEVEL_ORDER.view ? `/reports/outstanding?from=${from}&to=${to}` : null,
    dealers:     lvl('dealers') >= LEVEL_ORDER.view ? '/dealers' : null,
    incentive:   '/visits/team/schemes',
  };
  res.render('visits/team', {
    title: 'Team Performance', rows, totals, period, periods: periodOptions(), curPeriod: perf.currentPeriod(),
    schemes: perf.listSchemes(), teamSchemeId: perf.periodScheme(period), canManage: canManage(req), links,
  });
});

// ── Incentive schemes (manage) ─────────────────────────────────
const SCHEME_KINDS = new Set(['flat', 'volume', 'target', 'ontime', 'base_bonus']);
router.get('/schemes', (req, res) => {
  res.render('visits/teamSchemes', {
    title: 'Incentive Schemes', schemes: perf.listSchemes(),
    usage: perf.schemeUsage(), canManage: canManage(req),
  });
});
router.post('/schemes', requireManage, (req, res) => {
  const f = req.body;
  const name = (f.name || '').trim();
  if (!name) { flash(req, 'danger', 'Scheme name is required.'); return res.redirect('/visits/team/schemes'); }
  const basis = f.basis === 'sales' ? 'sales' : 'collection';
  const kind = SCHEME_KINDS.has(f.kind) ? f.kind : 'flat';
  const audience = f.audience === 'manager' ? 'manager' : 'sales';
  const pct = Math.max(0, parseFloat(f.pct) || 0);
  const bonus = Math.max(0, parseFloat(f.bonus_pct) || 0);
  const minAch = Math.max(0, parseFloat(f.min_achievement_pct) || 0);
  const penAmt = Math.max(0, parseFloat(f.penalty_amount) || 0);
  const penSal = Math.min(100, Math.max(0, parseFloat(f.penalty_salary_pct) || 0));
  // Slabs as "threshold:pct" pairs → [{min, pct}]. Meaning of threshold depends
  // on kind: amount (volume), achievement % (target), max days late (ontime).
  let slabs = null;
  if (f.slabs && f.slabs.trim()) {
    const arr = f.slabs.split(',').map(s => s.trim()).filter(Boolean).map(s => {
      const [min, p] = s.split(':').map(x => parseFloat(x));
      return { min: min || 0, pct: p || 0 };
    }).filter(x => x.pct > 0);
    if (arr.length) slabs = JSON.stringify(arr);
  }
  if (f.id) {
    db.prepare(`UPDATE incentive_schemes SET name=?, basis=?, kind=?, audience=?, pct=?, bonus_pct=?, slabs_json=?, min_achievement_pct=?, penalty_amount=?, penalty_salary_pct=?, active=? WHERE id=?`)
      .run(name, basis, kind, audience, pct, bonus, slabs, minAch, penAmt, penSal, f.active ? 1 : 0, f.id);
    flash(req, 'success', 'Scheme updated.');
  } else {
    db.prepare(`INSERT INTO incentive_schemes (name, basis, kind, audience, pct, bonus_pct, slabs_json, min_achievement_pct, penalty_amount, penalty_salary_pct, active) VALUES (?,?,?,?,?,?,?,?,?,?,1)`)
      .run(name, basis, kind, audience, pct, bonus, slabs, minAch, penAmt, penSal);
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
    // Month-wise scheme (sent by the target forms): set/clear for this period.
    if (f.scheme_id !== undefined) t.scheme_id = parseInt(f.scheme_id, 10) || null;
    for (let k = 0; k <= repeat; k++) perf.setTarget(spId, addMonths(period, k), t, req.session.user.id);
    flash(req, 'success', repeat ? `Target saved for ${period} + next ${repeat} month(s).` : 'Target saved.');
  }
  res.redirect('/visits/team' + (req.body.back === 'detail' ? ('/' + spId) : '') + '?period=' + period);
});

// Set ONE scheme for the whole team for a month (blank = clear).
router.post('/team-scheme', requireManage, (req, res) => {
  const period = /^\d{4}-\d{2}$/.test(req.body.period) ? req.body.period : perf.currentPeriod();
  const schemeId = parseInt(req.body.scheme_id, 10) || null;
  perf.setPeriodScheme(period, schemeId);
  flash(req, 'success', schemeId ? `Whole-team scheme set for ${period}.` : `Whole-team scheme cleared for ${period}.`);
  res.redirect('/visits/team?period=' + period);
});

// Assign an incentive scheme to a salesperson.
router.post('/assign-scheme', requireManage, (req, res) => {
  const spId = parseInt(req.body.salesperson_id, 10);
  const schemeId = parseInt(req.body.scheme_id, 10) || null;
  if (spId) db.prepare('UPDATE users SET incentive_scheme_id=? WHERE id=?').run(schemeId, spId);
  flash(req, 'success', 'Scheme assigned.');
  res.redirect('/visits/team/' + spId);
});

// ── Auto-grow: project growing targets into future months ──────
// Base each salesperson on either this month's target or their recent
// average actuals, then compound a monthly growth % across the next N months.
function recentAvgActual(spId, period, months) {
  let c = 0, s = 0, n = 0;
  for (let i = 1; i <= months; i++) { const a = perf.actuals(spId, addMonths(period, -i)); c += a.collection; s += a.sales; n += a.newDealers; }
  return { collection: c / months, sales: s / months, newDealers: n / months };
}
const roundMoney = (x) => x >= 1000 ? Math.round(x / 1000) * 1000 : Math.round(x / 100) * 100;
router.post('/autogrow', requireManage, (req, res) => {
  const f = req.body;
  const period = /^\d{4}-\d{2}$/.test(f.period) ? f.period : perf.currentPeriod();
  const growth = Math.max(0, Math.min(200, parseFloat(f.growth) || 0)) / 100;
  const months = Math.min(12, Math.max(1, parseInt(f.months, 10) || 3));
  const base = f.base === 'target' ? 'target' : 'actual';
  // Scope: one salesperson (from the detail page) or the whole team in view.
  const ids = getScopeUserIds(req);
  let people = perf.salespersons(ids);
  if (f.salesperson_id) { const one = parseInt(f.salesperson_id, 10); if (inScope(req, one)) people = people.filter(p => p.id === one); }
  let touched = 0;
  for (const sp of people) {
    let bc, bs, bn;
    if (base === 'target') {
      const t = perf.targetFor(sp.id, period);
      if (t && (t.collection_target || t.sales_target)) { bc = t.collection_target; bs = t.sales_target; bn = t.new_dealer_target; }
    }
    if (bc == null) { const a = recentAvgActual(sp.id, period, 3); bc = a.collection; bs = a.sales; bn = a.newDealers; }
    if (!bc && !bs && !bn) continue; // nothing to grow from — skip
    for (let k = 1; k <= months; k++) {
      const factor = Math.pow(1 + growth, k);
      perf.setTarget(sp.id, addMonths(period, k), {
        collection_target: roundMoney((bc || 0) * factor),
        sales_target: roundMoney((bs || 0) * factor),
        new_dealer_target: Math.round((bn || 0) * factor),
        note: `auto-grow +${(growth * 100).toFixed(0)}%/mo from ${period} (${base})`,
      }, req.session.user.id);
    }
    touched++;
  }
  flash(req, 'success', `Auto-grew targets for ${touched} salesperson(s) across the next ${months} month(s) at +${(growth * 100).toFixed(0)}%/month.`);
  res.redirect('/visits/team' + (f.salesperson_id ? ('/' + parseInt(f.salesperson_id, 10)) : '') + '?period=' + addMonths(period, 1));
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
