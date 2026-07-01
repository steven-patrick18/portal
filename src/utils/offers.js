// Dealer reward offers — gift/trip campaigns rewarded on cleared payment
// (verified collection) inside an offer window. A dealer earns the HIGHEST
// tier their period collection reaches; awards track delivery.
const { db } = require('../db');

const KIND_LABEL = { yearly: 'Whole-year', seasonal: 'Seasonal', festival: 'Festival' };

function schemes() { return db.prepare('SELECT * FROM offer_schemes ORDER BY active DESC, id DESC').all(); }
function scheme(id) { return db.prepare('SELECT * FROM offer_schemes WHERE id=?').get(id) || null; }
function tiers(schemeId) { return db.prepare('SELECT * FROM offer_tiers WHERE scheme_id=? ORDER BY min_amount ASC, sort').all(schemeId); }

// Verified collection for one dealer inside a scheme window.
function collectedFor(dealerId, s) {
  const from = s.from_date || '0000-01-01', to = s.to_date || '9999-12-31';
  return db.prepare("SELECT COALESCE(SUM(amount),0) AS v FROM payments WHERE dealer_id=? AND status='verified' AND payment_date BETWEEN ? AND ?").get(dealerId, from, to).v;
}

// Every dealer's standing for a scheme — collection, the reward tier reached
// (if any) and the delivery award. scopeIds = null → all dealers.
function eligibleDealers(s, tierList, scopeIds) {
  const from = s.from_date || '0000-01-01', to = s.to_date || '9999-12-31';
  let where = 'd.active=1';
  const params = [from, to];
  if (Array.isArray(scopeIds)) {
    if (!scopeIds.length) return [];
    where += ` AND d.salesperson_id IN (${scopeIds.map(() => '?').join(',')})`;
    params.push(...scopeIds);
  }
  const rows = db.prepare(`SELECT d.id, d.name, d.code, d.city, d.salesperson_id, u.name AS sp_name,
      COALESCE((SELECT SUM(amount) FROM payments WHERE dealer_id=d.id AND status='verified' AND payment_date BETWEEN ? AND ?),0) AS collected
    FROM dealers d LEFT JOIN users u ON u.id=d.salesperson_id
    WHERE ${where} ORDER BY collected DESC`).all(...params);
  const desc = tierList.slice().sort((a, b) => b.min_amount - a.min_amount);
  const awards = {};
  db.prepare('SELECT * FROM offer_awards WHERE scheme_id=?').all(s.id).forEach(a => { awards[a.dealer_id] = a; });
  const out = [];
  for (const r of rows) {
    const tier = desc.find(t => r.collected >= t.min_amount);
    if (!tier) continue;               // hasn't reached any reward tier
    const above = tierList.filter(t => t.min_amount > r.collected).sort((a, b) => a.min_amount - b.min_amount)[0] || null;
    out.push({ ...r, tier, reward: tier.reward, nextTier: above, award: awards[r.id] || null });
  }
  return out;
}

// For a dealer's profile page — their standing across every scheme.
function dealerOffers(dealerId) {
  const out = [];
  for (const s of schemes()) {
    const t = tiers(s.id);
    if (!t.length) continue;
    const collected = collectedFor(dealerId, s);
    const desc = t.slice().sort((a, b) => b.min_amount - a.min_amount);
    const tier = desc.find(x => collected >= x.min_amount) || null;
    const award = db.prepare('SELECT * FROM offer_awards WHERE scheme_id=? AND dealer_id=?').get(s.id, dealerId);
    if (!tier && !award) continue;     // nothing earned or delivered
    const nextTier = t.filter(x => x.min_amount > collected).sort((a, b) => a.min_amount - b.min_amount)[0] || null;
    out.push({ scheme: s, collected, tier, reward: tier ? tier.reward : (award ? award.reward : null), nextTier, award });
  }
  return out;
}

module.exports = { KIND_LABEL, schemes, scheme, tiers, collectedFor, eligibleDealers, dealerOffers };
