// Dealer credit score + suggested credit limit.
//
// The score is a WEIGHTED blend of configurable factors stored in the
// `credit_factors` table (managed from the Credit Score module). Each factor
// names a `metric_type` below, which turns the dealer's account history into a
// 0–100 sub-score; the factor's weight sets how much it matters. This rewards
// PROMPT, full payment AND business value (big, loyal buyers) — so the limit
// suggestion can be generous to dealers who grow our sales — while penalising
// slow/aged balances and fragmented "dribble" payments.
//
// scoreFrom(metrics, cfg?) stays a pure function (cfg defaults to the live
// config, cached). The existing callers (dealers list, credit-risk report,
// profile) keep working unchanged — the returned keys are preserved.
const { db } = require('../db');

function grade(s) {
  if (s == null) return { grade: '–', label: 'No history', color: 'secondary' };
  if (s >= 80) return { grade: 'A', label: 'Excellent', color: 'success' };
  if (s >= 65) return { grade: 'B', label: 'Good', color: 'primary' };
  if (s >= 50) return { grade: 'C', label: 'Fair', color: 'info' };
  if (s >= 35) return { grade: 'D', label: 'Watch', color: 'warning' };
  return { grade: 'E', label: 'Risk', color: 'danger' };
}

const clamp = (x) => Math.max(0, Math.min(100, Math.round(x)));

// metric_type → (metrics, params) → 0..100 sub-score (higher = better dealer),
// or null when not applicable (factor skipped, weight not counted).
const METRICS = {
  // Share of total dues actually paid.
  pay_ratio(m) {
    const business = (+m.opening || 0) + (+m.billed || 0);
    if (business <= 0) return null;
    return clamp(Math.min(1, (+m.paid || 0) / business) * 100);
  },
  // Lower current outstanding vs total business = better.
  outstanding_burden(m) {
    const business = (+m.opening || 0) + (+m.billed || 0);
    if (business <= 0) return null;
    const burden = Math.max(0, +m.outstanding || 0) / business;
    return clamp((1 - Math.min(1, burden)) * 100);
  },
  // Age of the oldest unpaid/partial bill. Nothing overdue = full marks.
  overdue_age(m, p) {
    if ((+m.outstanding || 0) <= 0) return 100;
    const age = +m.oldestUnpaidDays || 0;
    const grace = +p.grace_days || 30, bad = +p.bad_days || 90;
    if (age <= grace) return 100;
    if (age >= bad) return 0;
    return clamp((1 - (age - grace) / (bad - grace)) * 100);
  },
  // Few payments per invoice (not paid 1000-at-a-time).
  payment_consolidation(m, p) {
    const inv = +m.invCount || 0, pay = +m.payCount || 0;
    if (inv <= 0 || pay <= 0) return 100;
    const perInv = pay / inv, worst = +p.worst || 4;
    if (perInv <= 1) return 100;
    if (perInv >= worst) return 0;
    return clamp((1 - (perInv - 1) / (worst - 1)) * 100);
  },
  // Few goods returned vs billed.
  returns_ratio(m, p) {
    const billed = +m.billed || 0;
    if (billed <= 0) return 100;
    const bad = +p.bad || 0.25;
    return clamp((1 - Math.min(1, (+m.returned || 0) / billed / bad)) * 100);
  },
  // Business value — bigger lifetime buyers score higher (grow our sales).
  business_value(m, p) {
    const v = (+m.opening || 0) + (+m.billed || 0);
    const full = +p.full_value || 500000;
    if (full <= 0) return 100;
    return clamp(Math.min(1, v / full) * 100);
  },
  // Tenure / loyalty — longer relationship counts in their favour.
  tenure(m, p) {
    const mo = +m.monthsActive || 0, full = +p.full_months || 24;
    if (full <= 0) return 100;
    return clamp(Math.min(1, mo / full) * 100);
  },
  // How often they order (orders per active month).
  order_frequency(m, p) {
    const mo = Math.max(1, +m.monthsActive || 0), inv = +m.invCount || 0;
    const full = +p.full_per_month || 4;
    if (full <= 0) return 100;
    return clamp(Math.min(1, (inv / mo) / full) * 100);
  },
};

// ── live config (factors + suggestion settings), cached until invalidate() ──
let _cache = null;
function loadConfig(force) {
  if (_cache && !force) return _cache;
  let factors = [];
  try {
    factors = db.prepare('SELECT * FROM credit_factors WHERE active=1 ORDER BY sort_order, id').all()
      .map(f => ({ ...f, params: f.params ? JSON.parse(f.params) : {} }))
      .filter(f => METRICS[f.metric_type] && (+f.weight || 0) > 0);
  } catch (_) { factors = []; }
  let settings = {};
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE key='CREDIT_SETTINGS'").get();
    if (row) settings = JSON.parse(row.value);
  } catch (_) {}
  settings = Object.assign({
    monthsByGrade: { A: 1.5, B: 1, C: 0.5, D: 0.25, E: 0 },
    businessBoost: 0.5, businessBoostRef: 500000,
    shortHistoryMonths: 3, shortHistoryDamp: 0.5, round: 500,
  }, settings);
  _cache = { factors, settings };
  return _cache;
}
function invalidate() { _cache = null; }

// metrics: { opening, billed, paid, returned, outstanding, credit_limit,
//            invCount, payCount, oldestUnpaidDays, monthsActive }  (last optional)
function scoreFrom(m, cfg) {
  const business = (+m.opening || 0) + (+m.billed || 0);
  if (business <= 0) return Object.assign({ score: null, payRatio: null, subs: [] }, grade(null));
  cfg = cfg || loadConfig();
  const subs = [];
  let wsum = 0, acc = 0;
  for (const f of cfg.factors) {
    const sub = METRICS[f.metric_type](m, f.params || {});
    if (sub == null) continue;
    const w = +f.weight || 0;
    wsum += w; acc += w * sub;
    subs.push({ key: f.key, label: f.label, weight: w, sub });
  }
  let score = wsum > 0 ? acc / wsum : null;
  // Hard guardrail: already over the set credit limit drags the score down.
  if (score != null) {
    const limit = +m.credit_limit || 0;
    if (limit > 0 && (+m.outstanding || 0) > limit) score -= 12;
    score = Math.max(5, Math.min(100, Math.round(score)));
  }
  const payRatio = METRICS.pay_ratio(m) == null ? null : METRICS.pay_ratio(m) / 100;
  return Object.assign({ score, payRatio, subs }, grade(score));
}

function roundTo(x, step) { step = step || 500; return Math.max(0, Math.round(x / step) * step); }

// Suggested credit limit — months of average purchase by grade, BOOSTED for
// high business value (so big buyers get room to grow), damped for thin
// history, zero for risky dealers.
function suggestLimit(m, scoreObj, settings) {
  settings = settings || loadConfig().settings;
  const billed = +m.billed || 0, invCount = +m.invCount || 0, monthsActive = +m.monthsActive || 0;
  if (invCount <= 0 || monthsActive <= 0 || !scoreObj || scoreObj.score == null) return 0;
  const monthsFactor = (settings.monthsByGrade || {})[scoreObj.grade] || 0;
  if (monthsFactor <= 0) return 0;
  const monthlyAvg = billed / monthsActive;
  const lifetime = (+m.opening || 0) + billed;
  const boost = 1 + (+settings.businessBoost || 0) * Math.min(1, lifetime / (+settings.businessBoostRef || 500000));
  let raw = monthlyAvg * monthsFactor * boost;
  if (monthsActive < (+settings.shortHistoryMonths || 3)) raw *= (+settings.shortHistoryDamp || 0.5);
  let suggested = roundTo(raw, settings.round);
  // A/B dealers should get at least one average order of headroom.
  if (['A', 'B'].includes(scoreObj.grade)) suggested = Math.max(suggested, roundTo(billed / Math.max(1, invCount), settings.round));
  return suggested;
}

// Full score for the profile/module — adds suggested limit + readable factors.
function fullScore(dealerId, cfg) {
  cfg = cfg || loadConfig();
  const d = db.prepare('SELECT opening_balance, credit_limit FROM dealers WHERE id=?').get(dealerId) || {};
  const billed = db.prepare("SELECT COALESCE(SUM(total),0) v FROM invoices WHERE dealer_id=? AND status!='cancelled'").get(dealerId).v;
  const paid = db.prepare("SELECT COALESCE(SUM(amount),0) v FROM payments WHERE dealer_id=? AND status='verified'").get(dealerId).v;
  const returned = db.prepare("SELECT COALESCE(SUM(total_amount),0) v FROM returns WHERE dealer_id=? AND status IN ('approved','restocked')").get(dealerId).v;
  const invCount = db.prepare("SELECT COUNT(*) n FROM invoices WHERE dealer_id=? AND status!='cancelled'").get(dealerId).n;
  const payCount = db.prepare("SELECT COUNT(*) n FROM payments WHERE dealer_id=? AND status='verified'").get(dealerId).n;
  const oldUnpaid = db.prepare("SELECT MIN(invoice_date) dd FROM invoices WHERE dealer_id=? AND status IN ('unpaid','partial')").get(dealerId).dd;
  const oldestUnpaidDays = oldUnpaid ? Math.round((Date.now() - new Date(oldUnpaid).getTime()) / 864e5) : 0;
  const opening = d.opening_balance || 0;
  const outstanding = Math.max(0, opening + billed - paid - returned);
  const firstInv = db.prepare("SELECT MIN(invoice_date) dd FROM invoices WHERE dealer_id=? AND status!='cancelled'").get(dealerId).dd;
  let monthsActive = 0;
  if (firstInv) monthsActive = Math.max(1, Math.round((Date.now() - new Date(firstInv).getTime()) / (30 * 864e5)));

  const m = { opening, billed, paid, returned, outstanding, credit_limit: d.credit_limit, invCount, payCount, oldestUnpaidDays, monthsActive };
  const base = scoreFrom(m, cfg);
  const suggested = suggestLimit(m, base, cfg.settings);

  const lifetime = opening + billed;
  const factors = [];
  if (base.payRatio != null) factors.push(`Pays ${Math.round(base.payRatio * 100)}% of dues`);
  if (lifetime >= (cfg.settings.businessBoostRef || 500000)) factors.push('Top buyer (high business value)');
  if (outstanding > 0 && oldestUnpaidDays > 30) factors.push(`Oldest due ${oldestUnpaidDays} days`);
  if (invCount > 0 && payCount / invCount >= 2.5) factors.push('Pays in many small parts');
  if (invCount) factors.push(`${invCount} invoice${invCount > 1 ? 's' : ''} over ${monthsActive} mo`);
  if (d.credit_limit > 0 && outstanding > d.credit_limit) factors.push('Currently over limit');
  else if (outstanding <= 0) factors.push('Fully cleared');

  return Object.assign({}, base, { suggested, billed, paid, lifetime, invCount, payCount, monthsActive, oldestUnpaidDays, outstanding, factors });
}

module.exports = { scoreFrom, fullScore, suggestLimit, loadConfig, invalidate, grade, METRICS };
