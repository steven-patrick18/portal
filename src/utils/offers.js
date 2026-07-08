// Dealer reward offers — gift/trip campaigns rewarded on cleared payment
// (verified collection) inside an offer window. A dealer earns the HIGHEST
// tier their period collection reaches; awards track delivery.
//
// Upgrade A — filter_kind: 'all' | 'new' (created on/after From) |
//   'inactive' (no verified payment in filter_days before From) |
//   'selected' (hand-picked rows in offer_dealers).
// Upgrade B — checkAndNotify()/notifyEligible(): one congratulation SMS per
//   dealer per tier (offer_notices), using the 'offer' SMS template.
// Upgrade C — ontime_days: only payments made within N days of their invoice
//   date count toward tiers (invoice-linked payments only).
const { db } = require('../db');

const KIND_LABEL = { yearly: 'Whole-year', seasonal: 'Seasonal', festival: 'Festival' };
const FILTER_LABEL = {
  all: 'All dealers', new: 'New dealers (joined after From)',
  inactive: 'Inactive dealers', selected: 'Selected dealers',
};

function schemes() { return db.prepare('SELECT * FROM offer_schemes ORDER BY active DESC, id DESC').all(); }
function scheme(id) { return db.prepare('SELECT * FROM offer_schemes WHERE id=?').get(id) || null; }
function tiers(schemeId) { return db.prepare('SELECT * FROM offer_tiers WHERE scheme_id=? ORDER BY min_amount ASC, sort').all(schemeId); }
function selectedDealerIds(schemeId) { return db.prepare('SELECT dealer_id FROM offer_dealers WHERE scheme_id=?').all(schemeId).map(r => r.dealer_id); }
function setSelectedDealers(schemeId, ids) {
  db.prepare('DELETE FROM offer_dealers WHERE scheme_id=?').run(schemeId);
  const ins = db.prepare('INSERT OR IGNORE INTO offer_dealers (scheme_id, dealer_id) VALUES (?,?)');
  (ids || []).forEach(id => { if (parseInt(id, 10)) ins.run(schemeId, parseInt(id, 10)); });
}

// SQL fragment: cleared payment for dealer alias `d` inside the scheme window,
// honouring the on-time condition when set. Params are inlined via helper.
function paidSelect(s) {
  const from = s.from_date || '0000-01-01', to = s.to_date || '9999-12-31';
  if (s.ontime_days > 0) {
    return {
      sql: `COALESCE((SELECT SUM(p.amount) FROM payments p JOIN invoices i ON i.id = p.invoice_id
             WHERE p.dealer_id = d.id AND p.status='verified' AND p.payment_date BETWEEN ? AND ?
               AND julianday(p.payment_date) - julianday(i.invoice_date) <= ?),0)`,
      params: [from, to, s.ontime_days],
    };
  }
  return {
    sql: `COALESCE((SELECT SUM(amount) FROM payments WHERE dealer_id = d.id AND status='verified' AND payment_date BETWEEN ? AND ?),0)`,
    params: [from, to],
  };
}

// WHERE fragment applying the campaign's dealer filter (Upgrade A).
function filterWhere(s) {
  if (s.filter_kind === 'new' && s.from_date) {
    return { sql: ' AND date(d.created_at) >= ?', params: [s.from_date] };
  }
  if (s.filter_kind === 'inactive' && s.from_date && s.filter_days > 0) {
    return {
      sql: ` AND NOT EXISTS (SELECT 1 FROM payments px WHERE px.dealer_id = d.id AND px.status='verified'
              AND px.payment_date >= date(?, '-' || ? || ' day') AND px.payment_date < ?)`,
      params: [s.from_date, s.filter_days, s.from_date],
    };
  }
  if (s.filter_kind === 'selected') {
    return { sql: ' AND d.id IN (SELECT dealer_id FROM offer_dealers WHERE scheme_id=?)', params: [s.id] };
  }
  return { sql: '', params: [] };
}

// Verified collection for one dealer inside a scheme window (filters/on-time honoured).
function collectedFor(dealerId, s) {
  const paid = paidSelect(s);
  const row = db.prepare(`SELECT ${paid.sql} AS v FROM dealers d WHERE d.id=?`).get(...paid.params, dealerId);
  return row ? row.v : 0;
}

// Is this dealer inside the campaign's filter?
function dealerInFilter(dealerId, s) {
  const fw = filterWhere(s);
  if (!fw.sql) return true;
  return !!db.prepare(`SELECT 1 FROM dealers d WHERE d.id=?${fw.sql}`).get(dealerId, ...fw.params);
}

// Every dealer's standing for a scheme — collection, the reward tier reached
// (if any), the delivery award and whether the congrats SMS went out.
function eligibleDealers(s, tierList, scopeIds) {
  const paid = paidSelect(s);
  const fw = filterWhere(s);
  let where = 'd.active=1' + fw.sql;
  const params = [...paid.params, ...fw.params];
  if (Array.isArray(scopeIds)) {
    if (!scopeIds.length) return [];
    where += ` AND d.salesperson_id IN (${scopeIds.map(() => '?').join(',')})`;
    params.push(...scopeIds);
  }
  const rows = db.prepare(`SELECT d.id, d.name, d.code, d.city, d.salesperson_id, u.name AS sp_name,
      ${paid.sql} AS collected
    FROM dealers d LEFT JOIN users u ON u.id=d.salesperson_id
    WHERE ${where} ORDER BY collected DESC`).all(...params);
  const desc = tierList.slice().sort((a, b) => b.min_amount - a.min_amount);
  const awards = {}, notices = {};
  db.prepare('SELECT * FROM offer_awards WHERE scheme_id=?').all(s.id).forEach(a => { awards[a.dealer_id] = a; });
  db.prepare('SELECT dealer_id, tier_id, sms_status FROM offer_notices WHERE scheme_id=?').all(s.id)
    .forEach(n => { notices[n.dealer_id + ':' + n.tier_id] = n; });
  const out = [];
  for (const r of rows) {
    const tier = desc.find(t => r.collected >= t.min_amount);
    if (!tier) continue;               // hasn't reached any reward tier
    const above = tierList.filter(t => t.min_amount > r.collected).sort((a, b) => a.min_amount - b.min_amount)[0] || null;
    out.push({ ...r, tier, reward: tier.reward, nextTier: above, award: awards[r.id] || null, notice: notices[r.id + ':' + tier.id] || null });
  }
  return out;
}

// For a dealer's profile page — their standing across every scheme they're in.
function dealerOffers(dealerId) {
  const out = [];
  for (const s of schemes()) {
    const t = tiers(s.id);
    if (!t.length) continue;
    const award = db.prepare('SELECT * FROM offer_awards WHERE scheme_id=? AND dealer_id=?').get(s.id, dealerId);
    if (!dealerInFilter(dealerId, s) && !award) continue;   // campaign not for them
    const collected = collectedFor(dealerId, s);
    const desc = t.slice().sort((a, b) => b.min_amount - a.min_amount);
    const tier = desc.find(x => collected >= x.min_amount) || null;
    if (!tier && !award) continue;     // nothing earned or delivered
    const nextTier = t.filter(x => x.min_amount > collected).sort((a, b) => a.min_amount - b.min_amount)[0] || null;
    out.push({ scheme: s, collected, tier, reward: tier ? tier.reward : (award ? award.reward : null), nextTier, award });
  }
  return out;
}

// ── Upgrade B: congratulation SMS, once per dealer per tier ─────
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
function runningSchemes() {
  const t = today();
  return schemes().filter(s => s.active && (!s.from_date || s.from_date <= t) && (!s.to_date || s.to_date >= t));
}
// Send the congrats SMS for one dealer+scheme+tier. Records the notice only
// when the SMS actually went out, so failures retry on the next trigger.
async function sendCongrats(s, dealer, tier, collected, nextTier) {
  const notify = require('./notify');
  const t = notify.templateFor('offer');
  if (!t) return { ok: false, error: 'offer SMS template inactive' };
  if (!dealer.phone) return { ok: false, error: 'no phone' };
  const vars = {
    dealer: dealer.name, reward: tier.reward, offer: s.name,
    more: nextTier ? Math.max(0, Math.round(nextTier.min_amount - collected)).toString() : '0',
    next: nextTier ? nextTier.reward : 'the top reward (already yours!)',
    company: require('./sms').setting('COMPANY_NAME', 'Sharv Enterprises'),
  };
  const c = notify.compose('offer', vars);
  const r = await require('./sms').sendSMS({ to: dealer.phone, ...c, template: 'offer', dealer_id: dealer.id });
  if (r && r.ok) {
    db.prepare(`INSERT INTO offer_notices (scheme_id, dealer_id, tier_id, reward, sms_status)
                VALUES (?,?,?,?, 'sent') ON CONFLICT(scheme_id, dealer_id, tier_id) DO NOTHING`)
      .run(s.id, dealer.id, tier.id, tier.reward);
  }
  return r || { ok: false };
}

// Called after a payment is verified — checks every running campaign this
// dealer is inside and congratulates newly-reached tiers. Fail-soft.
async function checkAndNotify(dealerId) {
  const dealer = db.prepare('SELECT id, name, phone FROM dealers WHERE id=? AND active=1').get(dealerId);
  if (!dealer) return { checked: 0, sent: 0 };
  let sent = 0, checked = 0;
  for (const s of runningSchemes()) {
    const t = tiers(s.id);
    if (!t.length || !dealerInFilter(dealerId, s)) continue;
    checked++;
    const collected = collectedFor(dealerId, s);
    const tier = t.slice().sort((a, b) => b.min_amount - a.min_amount).find(x => collected >= x.min_amount);
    if (!tier) continue;
    const already = db.prepare('SELECT 1 FROM offer_notices WHERE scheme_id=? AND dealer_id=? AND tier_id=?').get(s.id, dealerId, tier.id);
    if (already) continue;
    const nextTier = t.filter(x => x.min_amount > collected).sort((a, b) => a.min_amount - b.min_amount)[0] || null;
    const r = await sendCongrats(s, dealer, tier, collected, nextTier);
    if (r.ok) sent++;
  }
  return { checked, sent };
}

// Page button: SMS every eligible dealer of one scheme who hasn't been told yet.
async function notifyEligible(schemeId) {
  const s = scheme(schemeId);
  if (!s) return { sent: 0, failed: 0, skipped: 0 };
  const t = tiers(s.id);
  const rows = eligibleDealers(s, t, null);
  let sent = 0, failed = 0, skipped = 0;
  for (const r of rows) {
    if (r.notice) { skipped++; continue; }
    const dealer = db.prepare('SELECT id, name, phone FROM dealers WHERE id=?').get(r.id);
    const res = await sendCongrats(s, dealer, r.tier, r.collected, r.nextTier);
    if (res.ok) sent++; else failed++;
  }
  return { sent, failed, skipped };
}

module.exports = {
  KIND_LABEL, FILTER_LABEL, schemes, scheme, tiers, collectedFor, eligibleDealers, dealerOffers,
  selectedDealerIds, setSelectedDealers, dealerInFilter, checkAndNotify, notifyEligible,
};
