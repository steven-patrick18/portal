// Per-location stock writes (Phase 4).
// The rest of the app should never INSERT/UPDATE `ready_stock` directly —
// always go through these helpers. Reads of TOTAL (sum across locations)
// should query the `ready_stock_total` view; reads of a SPECIFIC location's
// pool query `ready_stock` directly with WHERE location_id = ?.

const { db } = require('../db');

// Default fulfillment location for legacy code paths that don't yet know
// about multi-office (production output, returns restock, etc.). Resolves
// to the first active factory; falls back to id=1 (the seeded LOC0001).
let _cachedDefault = null;
function defaultLocationId() {
  if (_cachedDefault) return _cachedDefault;
  const r = db.prepare("SELECT id FROM locations WHERE active=1 ORDER BY CASE type WHEN 'factory' THEN 1 ELSE 2 END, id LIMIT 1").get();
  _cachedDefault = r ? r.id : 1;
  return _cachedDefault;
}

// Create the per-(product, location) row if it doesn't exist, with qty 0.
// Used right after a product is created so /stock list shows it.
function ensureRow(product_id, location_id) {
  const loc = location_id || defaultLocationId();
  db.prepare('INSERT OR IGNORE INTO ready_stock (product_id, location_id, quantity) VALUES (?,?,0)').run(product_id, loc);
}

// SET the absolute quantity at this location (CSV import, manual adjust,
// bundle sync). UPSERT on the composite (product_id, location_id) key.
function setQty(product_id, qty, location_id) {
  const loc = location_id || defaultLocationId();
  db.prepare(`
    INSERT INTO ready_stock (product_id, location_id, quantity)
    VALUES (?, ?, ?)
    ON CONFLICT(product_id, location_id) DO UPDATE
      SET quantity = excluded.quantity, updated_at = datetime('now')
  `).run(product_id, loc, qty);
}

// ADD qty to this location's pool (production output, return restock,
// transfer-in). Creates the row at qty if it didn't exist.
function addQty(product_id, qty, location_id) {
  const loc = location_id || defaultLocationId();
  db.prepare(`
    INSERT INTO ready_stock (product_id, location_id, quantity)
    VALUES (?, ?, ?)
    ON CONFLICT(product_id, location_id) DO UPDATE
      SET quantity = quantity + excluded.quantity, updated_at = datetime('now')
  `).run(product_id, loc, qty);
}

// SUBTRACT qty from this location's pool (invoice sale, transfer-out,
// production packing-entry delete). Does NOT validate non-negative — the
// caller's transaction wrap handles overflow + the UI checks beforehand.
function removeQty(product_id, qty, location_id) {
  const loc = location_id || defaultLocationId();
  db.prepare(`UPDATE ready_stock SET quantity = quantity - ?, updated_at=datetime('now') WHERE product_id = ? AND location_id = ?`).run(qty, product_id, loc);
}

// Read total stock across all locations for one product.
function totalQty(product_id) {
  return db.prepare('SELECT COALESCE(SUM(quantity),0) AS v FROM ready_stock WHERE product_id=?').get(product_id).v;
}

// Read stock at a specific location.
function qtyAt(product_id, location_id) {
  const r = db.prepare('SELECT quantity FROM ready_stock WHERE product_id=? AND location_id=?').get(product_id, location_id);
  return r ? r.quantity : 0;
}

module.exports = {
  defaultLocationId,
  ensureRow,
  setQty,
  addQty,
  removeQty,
  totalQty,
  qtyAt,
};
