// Dealer credit score + suggested credit limit, from account history.
// scoreFrom() is a pure function of the ledger aggregates so the SAME grade
// shows in the dealers list and on the profile. fullScore() adds the
// suggested limit + human-readable factors (needs a couple of queries).
const { db } = require('../db');

function grade(s) {
  if (s == null) return { grade: '–', label: 'No history', color: 'secondary' };
  if (s >= 80) return { grade: 'A', label: 'Excellent', color: 'success' };
  if (s >= 65) return { grade: 'B', label: 'Good', color: 'primary' };
  if (s >= 50) return { grade: 'C', label: 'Fair', color: 'info' };
  if (s >= 35) return { grade: 'D', label: 'Watch', color: 'warning' };
  return { grade: 'E', label: 'Risk', color: 'danger' };
}

// metrics: { opening, billed, paid, returned, outstanding, credit_limit }
function scoreFrom(m) {
  const opening = +m.opening || 0, billed = +m.billed || 0, paid = +m.paid || 0;
  const returned = +m.returned || 0, outstanding = +m.outstanding || 0, limit = +m.credit_limit || 0;
  const business = opening + billed;                 // total they've ever owed us
  if (business <= 0) return Object.assign({ score: null }, grade(null));
  let score = 60;
  const payRatio = Math.min(1, paid / business);     // share of dues actually paid
  if (payRatio >= 0.95) score += 22;
  else if (payRatio >= 0.85) score += 14;
  else if (payRatio >= 0.70) score += 6;
  else if (payRatio >= 0.50) score -= 6;
  else score -= 18;
  const burden = Math.max(0, outstanding) / business; // how much is still owed
  if (burden <= 0.10) score += 12;
  else if (burden <= 0.30) score += 6;
  else if (burden >= 0.60) score -= 12;
  if (limit > 0 && outstanding > limit) score -= 15;  // over the set limit
  if (billed > 0 && returned / billed > 0.15) score -= 5; // heavy returns
  score = Math.max(5, Math.min(100, Math.round(score)));
  return Object.assign({ score, payRatio }, grade(score));
}

function round500(x) { return Math.max(0, Math.round(x / 500) * 500); }

// Full score for the profile page — adds suggested limit + factors.
function fullScore(dealerId) {
  const d = db.prepare('SELECT opening_balance, credit_limit FROM dealers WHERE id=?').get(dealerId) || {};
  const billed = db.prepare("SELECT COALESCE(SUM(total),0) v FROM invoices WHERE dealer_id=? AND status!='cancelled'").get(dealerId).v;
  const paid = db.prepare("SELECT COALESCE(SUM(amount),0) v FROM payments WHERE dealer_id=? AND status='verified'").get(dealerId).v;
  const returned = db.prepare("SELECT COALESCE(SUM(total_amount),0) v FROM returns WHERE dealer_id=? AND status IN ('approved','restocked')").get(dealerId).v;
  const opening = d.opening_balance || 0;
  const outstanding = Math.max(0, opening + billed - paid - returned);
  const base = scoreFrom({ opening, billed, paid, returned, outstanding, credit_limit: d.credit_limit });

  const invCount = db.prepare("SELECT COUNT(*) n FROM invoices WHERE dealer_id=? AND status!='cancelled'").get(dealerId).n;
  const firstInv = db.prepare("SELECT MIN(invoice_date) dd FROM invoices WHERE dealer_id=? AND status!='cancelled'").get(dealerId).dd;
  let monthsActive = 0;
  if (firstInv) monthsActive = Math.max(1, Math.round((Date.now() - new Date(firstInv).getTime()) / (30 * 864e5)));

  // Suggested limit ≈ (avg monthly purchase) × (trust factor by grade).
  const factorByGrade = { A: 2, B: 1.5, C: 1, D: 0.5, E: 0 };
  let suggested = 0;
  if (invCount > 0 && monthsActive > 0) {
    const monthlyAvg = billed / monthsActive;
    suggested = round500(monthlyAvg * (factorByGrade[base.grade] || 0));
    const avgOrder = billed / Math.max(1, invCount);
    if (['A', 'B', 'C'].includes(base.grade)) suggested = Math.max(suggested, round500(avgOrder));
  }

  const factors = [];
  if (base.payRatio != null) factors.push(`Pays ${Math.round(base.payRatio * 100)}% of dues`);
  if (invCount) factors.push(`${invCount} invoice${invCount > 1 ? 's' : ''} over ${monthsActive} mo`);
  if (d.credit_limit > 0 && outstanding > d.credit_limit) factors.push('Currently over limit');
  else if (outstanding <= 0) factors.push('Fully cleared');

  return Object.assign({}, base, { suggested, invCount, monthsActive, outstanding, factors });
}

module.exports = { scoreFrom, fullScore };
