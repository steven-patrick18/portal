// Salesperson performance & incentive engine (Field → Team).
// Pulls real numbers from invoices (sales), payments (collection), dealers
// (new accounts + outstanding) and applies the configured incentive scheme.
// Everything is read-only/derived — nothing here mutates ledgers.
const { db } = require('../db');

// 'YYYY-MM' for a Date (local).
function periodOf(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function currentPeriod() { return periodOf(new Date()); }

// First & last calendar day of a 'YYYY-MM' period → ['YYYY-MM-01','YYYY-MM-31'].
function monthRange(period) {
  const [y, m] = String(period || currentPeriod()).split('-').map(Number);
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const last = new Date(y, m, 0).getDate(); // day 0 of next month = last day
  const to = `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
  return { from, to };
}

// List salespeople (anyone who owns dealers or has the salesperson/area_manager
// role), optionally restricted to a set of ids (team scope).
function salespersons(ids) {
  let sql = `SELECT u.id, u.name, u.role, u.reports_to, m.name AS manager_name, u.incentive_scheme_id
             FROM users u LEFT JOIN users m ON m.id = u.reports_to
             WHERE u.active = 1 AND (u.role IN ('salesperson','area_manager')
               OR EXISTS (SELECT 1 FROM dealers d WHERE d.salesperson_id = u.id))`;
  const params = [];
  if (Array.isArray(ids)) {
    if (!ids.length) return [];
    sql += ` AND u.id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  }
  return db.prepare(sql + ' ORDER BY u.name').all(...params);
}

const num = (v) => (v && typeof v.v === 'number' ? v.v : (v ? v.v : 0)) || 0;

// Current outstanding owned by a salesperson (across all their dealers):
// opening + lifetime billed − verified paid − approved returns. Mirrors the
// finance report's reconciliation exactly.
function outstandingFor(spId) {
  return db.prepare(`
    SELECT COALESCE(SUM(
      COALESCE(d.opening_balance,0)
      + COALESCE((SELECT SUM(total)  FROM invoices WHERE dealer_id=d.id AND status!='cancelled'),0)
      - COALESCE((SELECT SUM(amount) FROM payments WHERE dealer_id=d.id AND status='verified'),0)
      - COALESCE((SELECT SUM(total_amount) FROM returns WHERE dealer_id=d.id AND status IN ('approved','restocked')),0)
    ),0) AS v FROM dealers d WHERE d.salesperson_id=?`).get(spId).v;
}

// Period figures for one salesperson.
function actuals(spId, period) {
  const { from, to } = monthRange(period);
  const sales = db.prepare(`SELECT COALESCE(SUM(total),0) AS v FROM invoices
    WHERE salesperson_id=? AND status!='cancelled' AND invoice_date BETWEEN ? AND ?`).get(spId, from, to).v;
  const collection = db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM payments
    WHERE salesperson_id=? AND status='verified' AND payment_date BETWEEN ? AND ?`).get(spId, from, to).v;
  const newDealers = db.prepare(`SELECT COUNT(*) AS v FROM dealers
    WHERE salesperson_id=? AND date(created_at) BETWEEN ? AND ?`).get(spId, from, to).v;
  return { sales, collection, newDealers };
}

function targetFor(spId, period) {
  return db.prepare('SELECT * FROM sales_targets WHERE salesperson_id=? AND period=?').get(spId, period) || null;
}
function setTarget(spId, period, t, userId) {
  db.prepare(`INSERT INTO sales_targets (salesperson_id, period, sales_target, collection_target, new_dealer_target, note, updated_by, updated_at)
    VALUES (?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(salesperson_id, period) DO UPDATE SET
      sales_target=excluded.sales_target, collection_target=excluded.collection_target,
      new_dealer_target=excluded.new_dealer_target, note=excluded.note,
      updated_by=excluded.updated_by, updated_at=datetime('now')`)
    .run(spId, period, t.sales_target || 0, t.collection_target || 0, t.new_dealer_target || 0, t.note || null, userId || null);
}

// Scheme for a salesperson: their assigned one, else the default active scheme.
function schemeFor(spId, schemeId) {
  if (schemeId) {
    const s = db.prepare('SELECT * FROM incentive_schemes WHERE id=?').get(schemeId);
    if (s) return s;
  }
  return db.prepare('SELECT * FROM incentive_schemes WHERE active=1 ORDER BY id LIMIT 1').get() || null;
}

function schemeKind(scheme) { return scheme ? (scheme.kind || (scheme.slabs_json ? 'volume' : 'flat')) : 'flat'; }
// Highest slab whose min ≤ value → its pct (for volume/target tiers).
function slabRate(slabsJson, value) {
  try {
    const s = JSON.parse(slabsJson) || [];
    const hit = s.filter(x => value >= (Number(x.min) || 0)).sort((a, b) => (Number(b.min) || 0) - (Number(a.min) || 0))[0];
    return hit ? (Number(hit.pct) || 0) : 0;
  } catch (_) { return 0; }
}
// Apply a scheme to a basis amount (flat / volume / target / base_bonus).
// achPct is achievement vs the matching target (0-100+). On-time is computed
// separately by ontimeIncentive() because it needs the individual payments.
function computeIncentive(scheme, basisAmount, achPct) {
  if (!scheme || !scheme.active) return 0;
  const kind = schemeKind(scheme);
  const a = achPct == null ? null : achPct;
  if (kind === 'target') {
    const pct = scheme.slabs_json ? slabRate(scheme.slabs_json, a == null ? 0 : a) : (scheme.pct || 0);
    return Math.round(basisAmount * pct / 100);
  }
  if (kind === 'base_bonus') {
    const gate = scheme.min_achievement_pct || 0;
    const bonusApplies = gate <= 0 ? true : (a != null && a >= gate);
    const pct = (scheme.pct || 0) + (bonusApplies ? (scheme.bonus_pct || 0) : 0);
    return Math.round(basisAmount * pct / 100);
  }
  // flat / volume — gated by min achievement
  if (scheme.min_achievement_pct && (a == null || a < scheme.min_achievement_pct)) return 0;
  const pct = scheme.slabs_json ? slabRate(scheme.slabs_json, basisAmount) : (scheme.pct || 0);
  return Math.round(basisAmount * pct / 100);
}
// On-time scheme: rate each verified payment by how late it was vs its invoice.
// slabs = [{min:maxDays, pct}] — smallest maxDays ≥ daysLate applies.
function ontimeIncentive(spId, period, scheme) {
  let tiers = [];
  try { tiers = (JSON.parse(scheme.slabs_json || '[]') || []).map(t => ({ min: Number(t.min) || 0, pct: Number(t.pct) || 0 })).sort((a, b) => a.min - b.min); } catch (_) {}
  if (!tiers.length) return 0;
  const { from, to } = monthRange(period);
  const pays = db.prepare(`SELECT p.amount, p.payment_date, i.invoice_date
     FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id
     WHERE p.salesperson_id=? AND p.status='verified' AND p.payment_date BETWEEN ? AND ?`).all(spId, from, to);
  let total = 0;
  for (const p of pays) {
    let daysLate = 0;
    if (p.invoice_date) { const d = (new Date(p.payment_date) - new Date(p.invoice_date)) / 86400000; daysLate = Math.max(0, Math.round(d)); }
    const tier = tiers.find(t => daysLate <= t.min) || tiers[tiers.length - 1];
    total += p.amount * (tier ? tier.pct : 0) / 100;
  }
  return Math.round(total);
}

const pctOf = (actual, target) => (target > 0 ? Math.round((actual / target) * 100) : null);

// Full scorecard row for one salesperson in a period.
function perfFor(sp, period) {
  const a = actuals(sp.id, period);
  const t = targetFor(sp.id, period);
  const ach = {
    sales: t ? pctOf(a.sales, t.sales_target) : null,
    collection: t ? pctOf(a.collection, t.collection_target) : null,
    newDealers: t ? pctOf(a.newDealers, t.new_dealer_target) : null,
  };
  const scheme = schemeFor(sp.id, sp.incentive_scheme_id);
  const basisAmount = scheme && scheme.basis === 'sales' ? a.sales : a.collection;
  const gateAch = scheme && scheme.basis === 'sales' ? ach.sales : ach.collection;
  const incentive = scheme
    ? (schemeKind(scheme) === 'ontime' ? ontimeIncentive(sp.id, period, scheme) : computeIncentive(scheme, basisAmount, gateAch))
    : 0;
  // Score = average of the achievement %s that have a target (capped 100 each).
  const parts = [ach.collection, ach.sales, ach.newDealers].filter(v => v != null).map(v => Math.min(v, 100));
  const score = parts.length ? Math.round(parts.reduce((s, v) => s + v, 0) / parts.length) : null;
  const rating = score == null ? '—' : (score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : 'D');
  return {
    sp, period, actual: a, target: t, ach, incentive, scheme,
    outstanding: outstandingFor(sp.id), score, rating,
    dealers: db.prepare('SELECT COUNT(*) AS v FROM dealers WHERE salesperson_id=? AND active=1').get(sp.id).v,
  };
}

// Whole team for a period (ids = scope; undefined/null = everyone).
function teamPerf(ids, period) {
  return salespersons(ids).map(sp => perfFor(sp, period));
}

// Dealers of a salesperson with their current outstanding (for the detail page).
function dealerOutstanding(spId) {
  return db.prepare(`
    SELECT d.id, d.name, d.code, d.city, d.credit_limit,
      (COALESCE(d.opening_balance,0)
       + COALESCE((SELECT SUM(total)  FROM invoices WHERE dealer_id=d.id AND status!='cancelled'),0)
       - COALESCE((SELECT SUM(amount) FROM payments WHERE dealer_id=d.id AND status='verified'),0)
       - COALESCE((SELECT SUM(total_amount) FROM returns WHERE dealer_id=d.id AND status IN ('approved','restocked')),0)
      ) AS outstanding
    FROM dealers d WHERE d.salesperson_id=? AND d.active=1
    ORDER BY outstanding DESC`).all(spId);
}

function listSchemes() { return db.prepare('SELECT * FROM incentive_schemes ORDER BY active DESC, id').all(); }

// Who is on which scheme: explicit assignment counts, the "running default"
// scheme id (used by anyone unassigned), and how many salespeople are unassigned.
function schemeUsage() {
  const assigned = {};
  db.prepare(`SELECT incentive_scheme_id AS id, COUNT(*) AS n FROM users
              WHERE incentive_scheme_id IS NOT NULL AND active=1 GROUP BY incentive_scheme_id`)
    .all().forEach(r => { assigned[r.id] = r.n; });
  const def = db.prepare('SELECT id FROM incentive_schemes WHERE active=1 ORDER BY id LIMIT 1').get();
  const unassigned = db.prepare(`SELECT COUNT(*) AS n FROM users u
     WHERE u.active=1 AND u.incentive_scheme_id IS NULL
       AND (u.role IN ('salesperson','area_manager') OR EXISTS(SELECT 1 FROM dealers d WHERE d.salesperson_id=u.id))`).get().n;
  return { assigned, defaultId: def ? def.id : null, unassigned };
}

// Last 6 periods of collection+sales for a trend on the detail page.
function trend(spId, period, months = 6) {
  const [y, m] = String(period).split('-').map(Number);
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(y, m - 1 - i, 1);
    const p = periodOf(d);
    const a = actuals(spId, p);
    out.push({ period: p, sales: a.sales, collection: a.collection });
  }
  return out;
}

module.exports = {
  currentPeriod, periodOf, monthRange, salespersons,
  actuals, targetFor, setTarget, schemeFor, computeIncentive, ontimeIncentive, schemeKind,
  perfFor, teamPerf, outstandingFor, dealerOutstanding, listSchemes, schemeUsage, trend,
};
