// Shared duplicate-dealer guard. A dealer is a duplicate when its phone
// (last 10 digits) or GSTIN already belongs to another ACTIVE dealer.
// Returns a human error string, or null when unique. `excludeId` skips the
// row being edited. Used by every create path (manual form, field visit,
// website enquiry conversion) so the same customer can't be added twice.
const { db } = require('../db');

function duplicateDealerError(phone, gstin, excludeId) {
  const ex = excludeId ? Number(excludeId) : 0;
  const ph = String(phone || '').replace(/\D+/g, '');
  const ph10 = ph.length > 10 ? ph.slice(-10) : ph;
  if (ph10.length >= 10) {
    const hit = db.prepare(
      "SELECT code, name FROM dealers WHERE active=1 AND id<>? AND replace(replace(replace(replace(phone,' ',''),'-',''),'+',''),'(','') LIKE ?"
    ).get(ex, '%' + ph10);
    if (hit) return `A dealer with this phone number already exists: ${hit.code} — ${hit.name}. Duplicate not created.`;
  }
  const gst = String(gstin || '').trim().toUpperCase();
  if (gst) {
    const hit = db.prepare('SELECT code, name FROM dealers WHERE active=1 AND id<>? AND UPPER(TRIM(gstin))=?').get(ex, gst);
    if (hit) return `A dealer with this GST number already exists: ${hit.code} — ${hit.name}. Duplicate not created.`;
  }
  return null;
}

module.exports = { duplicateDealerError };
