// Dealer credit score + suggested credit limit, from account history.
// scoreFrom() is a pure function of the supplied metrics so the SAME grade
// shows in the dealers list and on the profile. It rewards full + PROMPT
// payment and penalises slow (aged) balances and fragmented "dribble"
// payments (e.g. a 50K invoice paid 1000-at-a-time). fullScore() gathers
// those metrics + a (conservative) suggested limit + human factors.
const { db } = require('../db');

function grade(s) {
  if (s == null) return { grade: '–', label: 'No history', color: 'secondary' };
  if (s >= 80) return { grade: 'A', label: 'Excellent', color: 'success' };
  if (s >= 65) return { grade: 'B', label: 'Good', color: 'primary' };
  if (s >= 50) return { grade: 'C', label: 'Fair', color: 'info' };
  if (s >= 35) return { grade: 'D', label: 'Watch', color: 'warning' };
  return { grade: 'E', label: 'Risk', color: 'danger' };
}

// metrics: { opening, billed, paid, returned, outstanding, credit_limit,
//            invCount, payCount, oldestUnpaidDays }   (last three optional)
function scoreFrom(m) {
  const opening = +m.opening || 0, billed = +m.billed || 0, paid = +m.paid || 0;
  const returned = +m.returned || 0, outstanding = +m.outstanding || 0, limit = +m.credit_limit || 0;
  const business = opening + billed;                 // total they've ever owed us
  if (business <= 0) return Object.assign({ score: null }, grade(null));
  let score = 60;

  // 1. How much of dues are actually paid.
  const payRatio = Math.min(1, paid / business);
  if (payRatio >= 0.95) score += 18;
  else if (payRatio >= 0.85) score += 11;
  else if (payRatio >= 0.70) score += 4;
  else if (payRatio >= 0.50) score -= 8;
  else score -= 20;

  // 2. Current outstanding burden.
  const burden = Math.max(0, outstanding) / business;
  if (burden <= 0.10) score += 10;
  else if (burden <= 0.30) score += 5;
  else if (burden >= 0.60) score -= 12;
  if (limit > 0 && outstanding > limit) score -= 15;     // over the set limit

  // 3. SLOW payment — age of the oldest unpaid/partial invoice (overdue).
  const age = +m.oldestUnpaidDays || 0;
  if (outstanding > 0 && age > 0) {
    if (age > 90) score -= 22;
    else if (age > 60) score -= 14;
    else if (age > 30) score -= 6;
  }

  // 4. FRAGMENTED / "dribble" payments — many tiny payments per invoice
  //    (e.g. a 50K invoice settled 1000-at-a-time = poor behaviour).
  const invCount = +m.invCount || 0, payCount = +m.payCount || 0;
  if (invCount > 0 && payCount > 0) {
    const perInv = payCount / invCount;
    if (perInv >= 4) score -= 14;
    else if (perInv >= 2.5) score -= 7;
    const avgInv = billed / invCount, avgPay = paid / payCount;
    if (avgInv > 0 && (avgPay / avgInv) < 0.15) score -= 8;  // tiny part-payments
  }

  // 5. Heavy returns.
  if (billed > 0 && returned / billed > 0.15) score -= 5;

  score = Math.max(5, Math.min(100, Math.round(score)));
  return Object.assign({ score, payRatio }, grade(score));
}

function round500(x) { return Math.max(0, Math.round(x / 500) * 500); }

// Full score for the profile — adds suggested limit + factors.
function fullScore(dealerId) {
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
  const base = scoreFrom({ opening, billed, paid, returned, outstanding, credit_limit: d.credit_limit, invCount, payCount, oldestUnpaidDays });

  const firstInv = db.prepare("SELECT MIN(invoice_date) dd FROM invoices WHERE dealer_id=? AND status!='cancelled'").get(dealerId).dd;
  let monthsActive = 0;
  if (firstInv) monthsActive = Math.max(1, Math.round((Date.now() - new Date(firstInv).getTime()) / (30 * 864e5)));

  // Suggested limit — CONSERVATIVE (thin margins): months of average purchase
  // by grade, damped for short history, zero for risky dealers.
  const factorByGrade = { A: 1.5, B: 1, C: 0.5, D: 0.25, E: 0 };
  let suggested = 0;
  if (invCount > 0 && monthsActive > 0) {
    const monthlyAvg = billed / monthsActive;
    let raw = monthlyAvg * (factorByGrade[base.grade] || 0);
    if (monthsActive < 3) raw *= 0.5;                 // limited track record
    suggested = round500(raw);
    const avgOrder = billed / Math.max(1, invCount);
    if (['A', 'B'].includes(base.grade)) suggested = Math.max(suggested, round500(avgOrder)); // at least one order
  }

  const factors = [];
  if (base.payRatio != null) factors.push(`Pays ${Math.round(base.payRatio * 100)}% of dues`);
  if (outstanding > 0 && oldestUnpaidDays > 30) factors.push(`Oldest due ${oldestUnpaidDays} days`);
  if (invCount > 0 && payCount / invCount >= 2.5) factors.push('Pays in many small parts');
  if (invCount) factors.push(`${invCount} invoice${invCount > 1 ? 's' : ''} over ${monthsActive} mo`);
  if (d.credit_limit > 0 && outstanding > d.credit_limit) factors.push('Currently over limit');
  else if (outstanding <= 0) factors.push('Fully cleared');

  return Object.assign({}, base, { suggested, invCount, payCount, monthsActive, oldestUnpaidDays, outstanding, factors });
}

module.exports = { scoreFrom, fullScore };
