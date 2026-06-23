// Dealer credit-limit guard, shared by direct invoicing and the
// sales-order → invoice conversion so neither path can bypass it.
const { db } = require('../db');

const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Returns a human-readable error string if billing `newTotal` to this dealer
// would push their outstanding past the credit limit; null if it's fine.
// Convention (matches the reports): credit_limit 0 = no limit, so skip.
// Outstanding is the single source of truth used everywhere:
//   opening + billed(non-cancelled) − verified payments − approved returns
function creditLimitError(dealerId, newTotal) {
  const c = db.prepare(`SELECT credit_limit,
        COALESCE(opening_balance,0)
        + COALESCE((SELECT SUM(total)        FROM invoices WHERE dealer_id=dealers.id AND status!='cancelled'),0)
        - COALESCE((SELECT SUM(amount)       FROM payments WHERE dealer_id=dealers.id AND status='verified'),0)
        - COALESCE((SELECT SUM(total_amount) FROM returns  WHERE dealer_id=dealers.id AND status IN ('approved','restocked')),0) AS outstanding
      FROM dealers WHERE id=?`).get(dealerId);
  if (!c || !(c.credit_limit > 0)) return null;                       // no limit set
  if ((c.outstanding + newTotal) <= c.credit_limit + 0.01) return null; // within limit
  const collect = (c.outstanding + newTotal) - c.credit_limit;
  return `Credit limit exceeded — invoice not created. Limit ${inr(c.credit_limit)}, ` +
         `current outstanding ${inr(c.outstanding)}, this invoice ${inr(newTotal)}. ` +
         `Please clear at least ${inr(collect)} of outstanding (or raise the credit limit on the dealer) before billing.`;
}

module.exports = { creditLimitError };
