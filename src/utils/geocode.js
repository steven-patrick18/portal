// Reverse-geocode captured GPS → authoritative town/state (OpenStreetMap
// Nominatim). Results are cached by rounded coordinates (~110 m) so we re-use
// nearby lookups and respect Nominatim's 1-request/second fair-use policy.
// Everything fails soft: on any error the dealer's geo_city simply stays empty
// and the typed city is used instead — nothing breaks.
const { db } = require('../db');

const UA = process.env.GEOCODE_UA || 'SharvExportsERP/1.0 (portal.sharvexports.com)';
const ENDPOINT = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/reverse';

function key(lat, lng) { return (Math.round(lat * 1000) / 1000) + ',' + (Math.round(lng * 1000) / 1000); }

async function reverseGeocode(lat, lng) {
  lat = parseFloat(lat); lng = parseFloat(lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const k = key(lat, lng);
  const cached = db.prepare('SELECT city, state FROM geocode_cache WHERE key=?').get(k);
  if (cached) return { city: cached.city || null, state: cached.state || null, cached: true };
  try {
    const url = `${ENDPOINT}?format=jsonv2&lat=${lat}&lon=${lng}&zoom=12&addressdetails=1`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const j = await res.json();
    const a = j.address || {};
    const city = a.city || a.town || a.village || a.municipality || a.suburb || a.city_district || a.county || a.state_district || null;
    const state = a.state || null;
    db.prepare("INSERT INTO geocode_cache (key, city, state, fetched_at) VALUES (?,?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET city=excluded.city, state=excluded.state, fetched_at=datetime('now')").run(k, city, state);
    return { city, state };
  } catch (_) { return null; }
}

// Reverse-geocode one dealer's last captured location and store geo_city.
async function stampDealer(dealerId, lat, lng) {
  const g = await reverseGeocode(lat, lng);
  if (g && g.city) db.prepare("UPDATE dealers SET geo_city=?, geo_state=?, geo_at=datetime('now') WHERE id=?").run(g.city, g.state || null, dealerId);
  return g;
}

// Background backfill — fill geo_city for located dealers that don't have one,
// throttled to 1 lookup/sec (cached coords are instant). Returns the count it
// will work through; runs to completion in the background.
let _running = false;
function pendingCount() {
  return db.prepare("SELECT COUNT(*) n FROM dealers WHERE active=1 AND last_visit_lat IS NOT NULL AND (geo_city IS NULL OR geo_city='')").get().n;
}
async function backfillDealers() {
  if (_running) return { already: true };
  _running = true;
  const rows = db.prepare("SELECT id, last_visit_lat lat, last_visit_lng lng FROM dealers WHERE active=1 AND last_visit_lat IS NOT NULL AND (geo_city IS NULL OR geo_city='') ORDER BY id").all();
  (async () => {
    try {
      for (const d of rows) {
        const before = !!db.prepare('SELECT 1 FROM geocode_cache WHERE key=?').get(key(d.lat, d.lng));
        await stampDealer(d.id, d.lat, d.lng);
        if (!before) await new Promise(r => setTimeout(r, 1100)); // pace uncached lookups
      }
    } catch (e) { console.error('[geocode backfill]', e.message); }
    finally { _running = false; }
  })();
  return { started: rows.length };
}

module.exports = { reverseGeocode, stampDealer, backfillDealers, pendingCount, key };
