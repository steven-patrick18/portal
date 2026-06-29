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
  // Average order value — bigger typical orders score higher.
  avg_order_value(m, p) {
    const inv = +m.invCount || 0;
    if (inv <= 0) return null;
    const avg = (+m.billed || 0) / inv, full = +p.full_value || 20000;
    if (full <= 0) return 100;
    return clamp(Math.min(1, avg / full) * 100);
  },
  // Credit utilisation — how much of the SET limit is used up (lower better).
  // Only meaningful when a limit is set; otherwise skipped.
  credit_utilization(m) {
    const limit = +m.credit_limit || 0;
    if (limit <= 0) return null;
    const util = Math.max(0, +m.outstanding || 0) / limit;
    return clamp((1 - Math.min(1, util)) * 100);
  },
  // Recency — how recently they last ordered (active = better).
  recency(m, p) {
    if ((+m.invCount || 0) <= 0 || m.daysSinceLast == null) return null;
    const fresh = +p.fresh_days || 30, stale = +p.stale_days || 180;
    const days = +m.daysSinceLast || 0;
    if (days <= fresh) return 100;
    if (days >= stale) return 0;
    return clamp((1 - (days - fresh) / (stale - fresh)) * 100);
  },
  // Share of their invoices that are fully paid (higher better).
  cleared_invoice_ratio(m) {
    const inv = +m.invCount || 0;
    if (inv <= 0) return null;
    return clamp(((+m.paidInv || 0) / inv) * 100);
  },
  // Share of their invoices currently overdue / unpaid (lower better).
  overdue_invoice_ratio(m) {
    const inv = +m.invCount || 0;
    if (inv <= 0) return null;
    return clamp((1 - (+m.overdueInv || 0) / inv) * 100);
  },
  // Growth trend — last 90 days of buying vs the 90 days before.
  growth_trend(m, p) {
    const recent = +m.billedRecent || 0, prev = +m.billedPrev || 0;
    if (prev <= 0) return recent > 0 ? 100 : null;     // new momentum, or nothing to judge
    const full = +p.full_growth || 1;                  // +100% = full marks
    const growth = (recent - prev) / prev;             // -1 = collapsed, 0 = flat
    return clamp(((growth + 1) / (full + 1)) * 100);   // flat → ~50
  },
  // Buying consistency — months they ordered ÷ months on our books.
  purchase_consistency(m) {
    const mo = +m.monthsActive || 0;
    if (mo <= 0) return null;
    return clamp(Math.min(1, (+m.orderMonths || 0) / mo) * 100);
  },
};

// ── Shared metric SQL (correlated subqueries on dealers alias `d`) ────────
// BASIC_COLS: the core six (also computed bespoke by the dealers list /
// credit-risk report). EXTRA_COLS: the richer signals the newer factors need.
// MET_COLS = both, for fresh queries (credit module / profile). Legacy callers
// that already select the basics just append EXTRA_COLS. metricsFromRow() reads
// either alias set, so the SAME score comes out everywhere.
const BASIC_COLS = `
  COALESCE((SELECT SUM(total)  FROM invoices WHERE dealer_id=d.id AND status!='cancelled'),0) AS m_billed,
  COALESCE((SELECT SUM(amount) FROM payments WHERE dealer_id=d.id AND status='verified'),0) AS m_paid,
  COALESCE((SELECT SUM(total_amount) FROM returns WHERE dealer_id=d.id AND status IN ('approved','restocked')),0) AS m_returned,
  COALESCE((SELECT COUNT(*) FROM invoices WHERE dealer_id=d.id AND status!='cancelled'),0) AS m_inv,
  COALESCE((SELECT COUNT(*) FROM payments WHERE dealer_id=d.id AND status='verified'),0) AS m_pay,
  CAST(julianday('now')-julianday((SELECT MIN(invoice_date) FROM invoices WHERE dealer_id=d.id AND status IN ('unpaid','partial'))) AS INTEGER) AS m_oldest`;
const EXTRA_COLS = `
  (SELECT MIN(invoice_date) FROM invoices WHERE dealer_id=d.id AND status!='cancelled') AS m_first,
  CAST(julianday('now')-julianday((SELECT MAX(invoice_date) FROM invoices WHERE dealer_id=d.id AND status!='cancelled')) AS INTEGER) AS m_recency_days,
  COALESCE((SELECT COUNT(*) FROM invoices WHERE dealer_id=d.id AND status='paid'),0) AS m_paid_inv,
  COALESCE((SELECT COUNT(*) FROM invoices WHERE dealer_id=d.id AND status IN ('unpaid','partial')),0) AS m_overdue_inv,
  COALESCE((SELECT SUM(total) FROM invoices WHERE dealer_id=d.id AND status!='cancelled' AND invoice_date>=date('now','-90 day')),0) AS m_recent,
  COALESCE((SELECT SUM(total) FROM invoices WHERE dealer_id=d.id AND status!='cancelled' AND invoice_date>=date('now','-180 day') AND invoice_date<date('now','-90 day')),0) AS m_prev,
  COALESCE((SELECT COUNT(DISTINCT substr(invoice_date,1,7)) FROM invoices WHERE dealer_id=d.id AND status!='cancelled'),0) AS m_order_months`;
const MET_COLS = BASIC_COLS + ',' + EXTRA_COLS;

// Turn a query row into the metrics object the engine expects. Accepts the m_*
// aliases (fresh queries) OR the legacy aliases used by the dealers list /
// credit-risk report (billed, paid, inv_count, oldest_unpaid_days, …).
function metricsFromRow(d) {
  const pick = (...keys) => { for (const k of keys) if (d[k] != null) return d[k]; return undefined; };
  const opening = +(pick('opening_balance') || 0);
  const billed = +(pick('m_billed', 'billed') || 0);
  const paid = +(pick('m_paid', 'paid') || 0);
  const returned = +(pick('m_returned', 'returned') || 0);
  const outstanding = d.outstanding != null ? Math.max(0, +d.outstanding) : Math.max(0, opening + billed - paid - returned);
  const first = pick('m_first', 'first_inv');
  const monthsActive = first ? Math.max(1, Math.round((Date.now() - new Date(first).getTime()) / (30 * 864e5))) : +(pick('monthsActive') || 0);
  const recencyRaw = pick('m_recency_days');
  return {
    opening, billed, paid, returned, outstanding, credit_limit: +(pick('credit_limit') || 0),
    invCount: +(pick('m_inv', 'inv_count') || 0), payCount: +(pick('m_pay', 'pay_count') || 0),
    oldestUnpaidDays: +(pick('m_oldest', 'oldest_unpaid_days', 'oldest') || 0), monthsActive,
    daysSinceLast: recencyRaw == null ? null : +recencyRaw,
    paidInv: +(pick('m_paid_inv') || 0), overdueInv: +(pick('m_overdue_inv') || 0),
    billedRecent: +(pick('m_recent') || 0), billedPrev: +(pick('m_prev') || 0), orderMonths: +(pick('m_order_months') || 0),
  };
}

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
  const d = db.prepare(`SELECT d.opening_balance, d.credit_limit, ${MET_COLS} FROM dealers d WHERE d.id=?`).get(dealerId);
  if (!d) return Object.assign({ suggested: 0, factors: [] }, scoreFrom({}, cfg));
  const m = metricsFromRow(d);
  const base = scoreFrom(m, cfg);
  const suggested = suggestLimit(m, base, cfg.settings);

  const factors = [];
  if (base.payRatio != null) factors.push(`Pays ${Math.round(base.payRatio * 100)}% of dues`);
  if ((m.opening + m.billed) >= (cfg.settings.businessBoostRef || 500000)) factors.push('Top buyer (high business value)');
  if (m.outstanding > 0 && m.oldestUnpaidDays > 30) factors.push(`Oldest due ${m.oldestUnpaidDays} days`);
  if (m.invCount > 0 && m.payCount / m.invCount >= 2.5) factors.push('Pays in many small parts');
  if (m.invCount && m.daysSinceLast != null && m.daysSinceLast > 120) factors.push(`No order in ${m.daysSinceLast} days`);
  if (m.billedPrev > 0 && m.billedRecent > m.billedPrev * 1.2) factors.push('Buying is growing');
  if (m.invCount) factors.push(`${m.invCount} invoice${m.invCount > 1 ? 's' : ''} over ${m.monthsActive} mo`);
  if (m.credit_limit > 0 && m.outstanding > m.credit_limit) factors.push('Currently over limit');
  else if (m.outstanding <= 0) factors.push('Fully cleared');

  const lifetime = m.opening + m.billed;
  return Object.assign({}, base, { suggested, billed: m.billed, paid: m.paid, lifetime, invCount: m.invCount, payCount: m.payCount, monthsActive: m.monthsActive, oldestUnpaidDays: m.oldestUnpaidDays, outstanding: m.outstanding, factors });
}

module.exports = { scoreFrom, fullScore, suggestLimit, loadConfig, invalidate, grade, METRICS, metricsFromRow, MET_COLS, EXTRA_COLS };
