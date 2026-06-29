// Credit Score module — dealer scores, configurable factors, suggested credit
// limits, and applying limits (single + bulk). Mounted with requireFeature
// ('credit') + requireWrite('credit') in app.js, so GET needs view+ and any
// POST needs the 'full' level.
const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { scopeWhere } = require('../middleware/scope');
const credit = require('../utils/creditScore');
const router = express.Router();

// Metric catalogue for the factor editor — what each scoring metric means and
// which tuning params it accepts. Keys must match METRICS in creditScore.js.
const METRIC_CATALOG = {
  pay_ratio:             { label: 'Payment record (paid ÷ total dues)',       params: [] },
  business_value:        { label: 'Business value (lifetime purchases)',      params: [{ key: 'full_value', label: '₹ lifetime for full marks', def: 500000 }] },
  overdue_age:           { label: 'Prompt payment (age of oldest unpaid bill)',params: [{ key: 'grace_days', label: 'Grace days', def: 30 }, { key: 'bad_days', label: 'Bad after (days)', def: 90 }] },
  outstanding_burden:    { label: 'Low outstanding burden (dues ÷ business)', params: [] },
  payment_consolidation: { label: 'Pays in full (few part-payments)',         params: [{ key: 'worst', label: 'Worst payments per invoice', def: 4 }] },
  returns_ratio:         { label: 'Low returns (returned ÷ billed)',          params: [{ key: 'bad', label: 'Bad ratio (e.g. 0.25)', def: 0.25 }] },
  tenure:                { label: 'Loyalty / tenure (months active)',         params: [{ key: 'full_months', label: 'Months for full marks', def: 24 }] },
  order_frequency:       { label: 'Order frequency (orders per month)',       params: [{ key: 'full_per_month', label: 'Orders/month for full marks', def: 4 }] },
};

function slugify(s) { return (s || '').toString().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'factor'; }

// Build the scored dealer list (team-scoped), newest-billing first.
function scoredDealers(req) {
  const sc = scopeWhere(req, 'd.salesperson_id');
  let sql = `SELECT d.id,d.code,d.name,d.phone,d.city,d.credit_limit,d.opening_balance,d.salesperson_id,
      u.name AS sp_name,
      COALESCE((SELECT SUM(total)  FROM invoices WHERE dealer_id=d.id AND status!='cancelled'),0) billed,
      COALESCE((SELECT SUM(amount) FROM payments WHERE dealer_id=d.id AND status='verified'),0) paid,
      COALESCE((SELECT SUM(total_amount) FROM returns  WHERE dealer_id=d.id AND status IN ('approved','restocked')),0) returned,
      COALESCE((SELECT COUNT(*) FROM invoices WHERE dealer_id=d.id AND status!='cancelled'),0) inv_count,
      COALESCE((SELECT COUNT(*) FROM payments WHERE dealer_id=d.id AND status='verified'),0) pay_count,
      CAST(julianday('now')-julianday((SELECT MIN(invoice_date) FROM invoices WHERE dealer_id=d.id AND status IN ('unpaid','partial'))) AS INTEGER) oldest,
      (SELECT MIN(invoice_date) FROM invoices WHERE dealer_id=d.id AND status!='cancelled') first_inv
    FROM dealers d LEFT JOIN users u ON u.id=d.salesperson_id WHERE d.active=1`;
  if (sc.where !== '1=1') sql += ' AND ' + sc.where;
  const rows = db.prepare(sql).all(...sc.params);
  const cfg = credit.loadConfig(true);    // fresh each request — picks up factor edits
  rows.forEach(d => {
    d.outstanding = Math.max(0, (d.opening_balance || 0) + d.billed - d.paid - d.returned);
    d.monthsActive = d.first_inv ? Math.max(1, Math.round((Date.now() - new Date(d.first_inv).getTime()) / (30 * 864e5))) : 0;
    const m = { opening: d.opening_balance, billed: d.billed, paid: d.paid, returned: d.returned, outstanding: d.outstanding, credit_limit: d.credit_limit, invCount: d.inv_count, payCount: d.pay_count, oldestUnpaidDays: d.oldest, monthsActive: d.monthsActive };
    const s = credit.scoreFrom(m, cfg);
    d.score = s.score; d.grade = s.grade; d.color = s.color; d.label = s.label; d.subs = s.subs;
    d.suggested = credit.suggestLimit(m, s, cfg.settings);
    d.gap = d.suggested - (d.credit_limit || 0);
  });
  return { rows, cfg };
}

router.get('/', (req, res) => {
  const { rows, cfg } = scoredDealers(req);
  const scored = rows.filter(d => d.score != null);
  const buckets = { A: 0, B: 0, C: 0, D: 0, E: 0 }, exposure = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  scored.forEach(d => { buckets[d.grade]++; exposure[d.grade] += d.outstanding; });
  const gradeFilter = ['A', 'B', 'C', 'D', 'E'].includes((req.query.grade || '').toUpperCase()) ? req.query.grade.toUpperCase() : null;
  const q = (req.query.q || '').trim().toLowerCase();
  let list = scored.slice();
  if (gradeFilter) list = list.filter(d => d.grade === gradeFilter);
  if (q) list = list.filter(d => (d.name || '').toLowerCase().includes(q) || (d.code || '').toLowerCase().includes(q));
  // Sort: biggest "raise suggested" opportunity first (grow sales), then score.
  const sort = req.query.sort || 'score';
  list.sort((a, b) => sort === 'opportunity' ? b.gap - a.gap : (sort === 'name' ? String(a.name).localeCompare(String(b.name)) : b.score - a.score));
  const CAP = 400; const total = list.length; if (total > CAP) list = list.slice(0, CAP);
  res.render('credit/index', {
    title: 'Credit Score', rows: list, buckets, exposure, gradeFilter, q, sort,
    scoredCount: scored.length, noHistory: rows.length - scored.length, total, cap: CAP,
    factorCount: cfg.factors.length, canWrite: res.locals.canWrite('credit'),
  });
});

// ── Apply a credit limit to one dealer ──────────────────────────────────
router.post('/dealer/:id/limit', (req, res) => {
  const d = db.prepare('SELECT id, code, name, credit_limit FROM dealers WHERE id=?').get(req.params.id);
  if (!d) { flash(req, 'danger', 'Dealer not found.'); return res.redirect('/credit'); }
  const limit = Math.max(0, Math.round(parseFloat(req.body.credit_limit) || 0));
  db.prepare("UPDATE dealers SET credit_limit=?, updated_at=datetime('now') WHERE id=?").run(limit, d.id);
  req.audit('update', 'dealer', d.id, `credit limit ${d.credit_limit || 0} → ${limit} (Credit module)`);
  flash(req, 'success', `Credit limit for ${d.name} set to ₹${limit.toLocaleString('en-IN')}.`);
  res.redirect('/credit' + (req.body.back_q ? '?q=' + encodeURIComponent(req.body.back_q) : ''));
});

// ── Bulk apply the SUGGESTED limit (optionally only one grade) ───────────
router.post('/apply-suggested', (req, res) => {
  const { rows } = scoredDealers(req);
  const onlyGrade = ['A', 'B', 'C', 'D', 'E'].includes((req.body.grade || '').toUpperCase()) ? req.body.grade.toUpperCase() : null;
  const raiseOnly = req.body.raise_only === '1';   // never lower an existing limit
  const upd = db.prepare("UPDATE dealers SET credit_limit=?, updated_at=datetime('now') WHERE id=?");
  let n = 0;
  const tx = db.transaction(() => {
    rows.forEach(d => {
      if (d.score == null || d.suggested <= 0) return;
      if (onlyGrade && d.grade !== onlyGrade) return;
      if (raiseOnly && d.suggested <= (d.credit_limit || 0)) return;
      upd.run(d.suggested, d.id); n++;
    });
  });
  tx();
  req.audit('bulk_update', 'dealer', null, `applied suggested credit limits to ${n} dealer(s)${onlyGrade ? ' (grade ' + onlyGrade + ')' : ''}${raiseOnly ? ', raise-only' : ''}`);
  flash(req, 'success', `Applied suggested credit limit to ${n} dealer${n !== 1 ? 's' : ''}.`);
  res.redirect('/credit' + (onlyGrade ? '?grade=' + onlyGrade : ''));
});

// ── Factor management ────────────────────────────────────────────────────
router.get('/factors', (req, res) => {
  const factors = db.prepare('SELECT * FROM credit_factors ORDER BY sort_order, id').all()
    .map(f => ({ ...f, params: f.params ? JSON.parse(f.params) : {} }));
  let settings = {};
  try { const r = db.prepare("SELECT value FROM app_settings WHERE key='CREDIT_SETTINGS'").get(); if (r) settings = JSON.parse(r.value); } catch (_) {}
  const totalWeight = factors.filter(f => f.active).reduce((s, f) => s + (+f.weight || 0), 0);
  res.render('credit/factors', { title: 'Credit Factors', factors, catalog: METRIC_CATALOG, settings, totalWeight });
});

function paramsFromBody(metricType, body) {
  const out = {};
  (METRIC_CATALOG[metricType] ? METRIC_CATALOG[metricType].params : []).forEach(p => {
    const v = parseFloat(body['param_' + p.key]);
    out[p.key] = isNaN(v) ? p.def : v;
  });
  return out;
}

router.post('/factors', (req, res) => {           // add a new factor
  const metric_type = req.body.metric_type;
  if (!METRIC_CATALOG[metric_type]) { flash(req, 'danger', 'Pick a valid factor type.'); return res.redirect('/credit/factors'); }
  const label = (req.body.label || '').trim() || METRIC_CATALOG[metric_type].label;
  let key = slugify(req.body.key || label);
  while (db.prepare('SELECT 1 FROM credit_factors WHERE key=?').get(key)) key += '_x';
  const weight = Math.max(0, parseFloat(req.body.weight) || 0);
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order),0) m FROM credit_factors').get().m;
  db.prepare('INSERT INTO credit_factors (key,label,description,metric_type,weight,params,active,builtin,sort_order) VALUES (?,?,?,?,?,?,1,0,?)')
    .run(key, label, (req.body.description || '').trim() || null, metric_type, weight, JSON.stringify(paramsFromBody(metric_type, req.body)), maxSort + 1);
  credit.invalidate();
  req.audit('create', 'credit_factor', null, `added factor "${label}" (${metric_type}, weight ${weight})`);
  flash(req, 'success', `Factor "${label}" added.`);
  res.redirect('/credit/factors');
});

router.post('/factors/:id', (req, res) => {       // edit weight / params / active / label
  const f = db.prepare('SELECT * FROM credit_factors WHERE id=?').get(req.params.id);
  if (!f) { flash(req, 'danger', 'Factor not found.'); return res.redirect('/credit/factors'); }
  const weight = Math.max(0, parseFloat(req.body.weight) || 0);
  const active = req.body.active === '0' ? 0 : (req.body.active === '1' ? 1 : f.active);
  const label = (req.body.label || '').trim() || f.label;
  const params = JSON.stringify(paramsFromBody(f.metric_type, req.body));
  db.prepare("UPDATE credit_factors SET label=?, weight=?, active=?, params=?, description=?, updated_at=datetime('now') WHERE id=?")
    .run(label, weight, active, params, (req.body.description || '').trim() || f.description, f.id);
  credit.invalidate();
  req.audit('update', 'credit_factor', f.id, `factor "${label}" weight=${weight} active=${active}`);
  flash(req, 'success', `Factor "${label}" updated.`);
  res.redirect('/credit/factors');
});

router.post('/factors/:id/delete', (req, res) => {
  const f = db.prepare('SELECT * FROM credit_factors WHERE id=?').get(req.params.id);
  if (!f) { flash(req, 'danger', 'Factor not found.'); return res.redirect('/credit/factors'); }
  if (f.builtin) { flash(req, 'warning', 'Built-in factors can\'t be deleted — switch them off instead.'); return res.redirect('/credit/factors'); }
  db.prepare('DELETE FROM credit_factors WHERE id=?').run(f.id);
  credit.invalidate();
  req.audit('delete', 'credit_factor', f.id, `removed factor "${f.label}"`);
  flash(req, 'success', `Factor "${f.label}" removed.`);
  res.redirect('/credit/factors');
});

router.post('/settings', (req, res) => {          // suggested-limit tuning
  let s = {};
  try { const r = db.prepare("SELECT value FROM app_settings WHERE key='CREDIT_SETTINGS'").get(); if (r) s = JSON.parse(r.value); } catch (_) {}
  const num = (v, d) => { const n = parseFloat(v); return isNaN(n) ? d : n; };
  s.monthsByGrade = {
    A: num(req.body.months_A, 1.5), B: num(req.body.months_B, 1), C: num(req.body.months_C, 0.5),
    D: num(req.body.months_D, 0.25), E: num(req.body.months_E, 0),
  };
  s.businessBoost = Math.max(0, num(req.body.businessBoost, 0.5));
  s.businessBoostRef = Math.max(1, num(req.body.businessBoostRef, 500000));
  s.shortHistoryMonths = Math.max(0, num(req.body.shortHistoryMonths, 3));
  s.shortHistoryDamp = Math.max(0, Math.min(1, num(req.body.shortHistoryDamp, 0.5)));
  s.round = Math.max(1, num(req.body.round, 500));
  db.prepare("INSERT INTO app_settings (key,value) VALUES ('CREDIT_SETTINGS',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')").run(JSON.stringify(s));
  credit.invalidate();
  req.audit('update', 'credit_settings', null, 'updated suggested-limit settings');
  flash(req, 'success', 'Suggested-limit settings saved.');
  res.redirect('/credit/factors');
});

module.exports = router;
