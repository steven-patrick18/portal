const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { nextCode } = require('../utils/codegen');
const router = express.Router();

const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'public', 'uploads', 'visits');
function monthDir() {
  const m = new Date().toISOString().slice(0, 7);
  const d = path.join(UPLOAD_ROOT, m);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, monthDir()),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg';
      const rnd = require('crypto').randomBytes(4).toString('hex');
      cb(null, 'v' + Date.now() + '_' + rnd + ext);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//i.test(file.mimetype)),
});

// Haversine distance in metres
function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sLat1 = Math.sin(toRad(a.lat));
  const sLat2 = Math.sin(toRad(b.lat));
  const cLat1 = Math.cos(toRad(a.lat));
  const cLat2 = Math.cos(toRad(b.lat));
  const x = Math.sin(dLat/2)**2 + cLat1*cLat2*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Salesperson can only see/edit their own visits. Admin/owner see everything.
// IMPORTANT: every caller queries the dealer_visits table aliased as `v` —
// we qualify the column name so a JOIN with `dealers` (which also has a
// salesperson_id column) doesn't trigger an "ambiguous column" error.
function scopeSql(req) {
  if (req.session.user.role === 'salesperson') {
    return { where: 'v.salesperson_id = ?', params: [req.session.user.id] };
  }
  return { where: '1=1', params: [] };
}

// ─── Factory In/Out (start/end of day GPS bookends) ──────────
const FACTORY_DIR = path.join(__dirname, '..', '..', 'public', 'uploads', 'factory_logs');
function factoryMonthDir() {
  const m = new Date().toISOString().slice(0, 7);
  const d = path.join(FACTORY_DIR, m);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}
const factoryUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, factoryMonthDir()),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg';
      const rnd = require('crypto').randomBytes(4).toString('hex');
      cb(null, 'f' + Date.now() + '_' + rnd + ext);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//i.test(file.mimetype)),
});

router.get('/factory/:type(in|out)', (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  const existing = db.prepare('SELECT id, photo_path, lat, lng, created_at FROM factory_logs WHERE salesperson_id=? AND log_date=? AND log_type=?')
    .get(req.session.user.id, today, req.params.type);
  res.render('visits/factory', { title: 'Factory ' + (req.params.type === 'in' ? 'In' : 'Out'), type: req.params.type, existing });
});

router.post('/factory/:type(in|out)', factoryUpload.single('photo'), (req, res) => {
  const type = req.params.type;
  if (!req.file) {
    flash(req, 'danger', 'Photo is required (camera capture).');
    return res.redirect('/visits/factory/' + type);
  }
  const lat = parseFloat(req.body.lat);
  const lng = parseFloat(req.body.lng);
  const accuracy_m = parseFloat(req.body.accuracy_m || 0);
  if (!isFinite(lat) || !isFinite(lng)) {
    fs.unlinkSync(req.file.path);
    flash(req, 'danger', 'Live location is required. Allow location permission and try again.');
    return res.redirect('/visits/factory/' + type);
  }
  if (accuracy_m > 0 && accuracy_m > 500) {
    fs.unlinkSync(req.file.path);
    flash(req, 'danger', `GPS too weak (±${Math.round(accuracy_m)}m). Step outside and try again — accuracy must be 500m or better.`);
    return res.redirect('/visits/factory/' + type);
  }

  const today = new Date().toISOString().slice(0,10);
  const photo_path = '/uploads/factory_logs/' + path.relative(FACTORY_DIR, req.file.path).replace(/\\/g, '/');
  const existing = db.prepare('SELECT id, photo_path FROM factory_logs WHERE salesperson_id=? AND log_date=? AND log_type=?')
    .get(req.session.user.id, today, type);

  if (existing) {
    // Replace: delete old photo, update row
    if (existing.photo_path) {
      const abs = path.join(__dirname, '..', '..', 'public', existing.photo_path.replace(/^\//, ''));
      if (fs.existsSync(abs)) try { fs.unlinkSync(abs); } catch (_) {}
    }
    db.prepare(`UPDATE factory_logs SET photo_path=?, lat=?, lng=?, accuracy_m=?, device_info=?, ip=?, notes=?, created_at=datetime('now') WHERE id=?`)
      .run(photo_path, lat, lng, accuracy_m || null, req.headers['user-agent'] || null, req.ip, req.body.notes || null, existing.id);
    req.audit('update', 'factory_log', existing.id, `${type} ${today} (replaced)`);
    flash(req, 'success', `Factory ${type === 'in' ? 'In' : 'Out'} updated for today.`);
  } else {
    const r = db.prepare(`INSERT INTO factory_logs (salesperson_id, log_type, log_date, photo_path, lat, lng, accuracy_m, device_info, ip, notes) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(req.session.user.id, type, today, photo_path, lat, lng, accuracy_m || null, req.headers['user-agent'] || null, req.ip, req.body.notes || null);
    req.audit('create', 'factory_log', r.lastInsertRowid, `${type} ${today} ±${Math.round(accuracy_m)}m`);
    flash(req, 'success', `Factory ${type === 'in' ? 'In' : 'Out'} captured.`);
  }
  res.redirect('/visits');
});

// ─── KM Report ─────────────────────────────────────────────────
// Groups visits by salesperson × day and computes day's KM as the sum
// of haversine distance between consecutive visits.
router.get('/km/report', (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);  // YYYY-MM
  const { where, params } = scopeSql(req);

  const visits = db.prepare(`
    SELECT v.id, v.salesperson_id, u.name AS sp_name,
           date(v.created_at) AS visit_date,
           v.lat, v.lng, v.created_at, v.visit_no,
           CASE WHEN v.dealer_id IS NOT NULL THEN d.name
                ELSE COALESCE(v.prospect_shop, v.prospect_name) END AS where_name
    FROM dealer_visits v
    JOIN users u ON u.id=v.salesperson_id
    LEFT JOIN dealers d ON d.id=v.dealer_id
    WHERE strftime('%Y-%m', v.created_at)=? AND ${where}
    ORDER BY v.salesperson_id, v.created_at
  `).all(month, ...params);

  // Factory bookends for the same month/scope.
  const fScope = scopeSql(req);
  const factoryRows = db.prepare(`
    SELECT f.salesperson_id, u.name AS sp_name, f.log_date AS visit_date,
           f.log_type, f.lat, f.lng, f.created_at, f.photo_path
    FROM factory_logs f JOIN users u ON u.id=f.salesperson_id
    WHERE strftime('%Y-%m', f.log_date)=? AND ${fScope.where.replace(/v\./g, 'f.')}
  `).all(month, ...fScope.params);
  const factoryByKey = new Map();
  factoryRows.forEach(f => {
    const key = f.salesperson_id + '|' + f.visit_date;
    const slot = factoryByKey.get(key) || {};
    slot[f.log_type] = f;
    slot.sp_name = f.sp_name;
    factoryByKey.set(key, slot);
  });

  // Group → { spId: { date: { sp_name, points: [...] } } }
  const groups = {};
  visits.forEach(v => {
    groups[v.salesperson_id] = groups[v.salesperson_id] || {};
    groups[v.salesperson_id][v.visit_date] = groups[v.salesperson_id][v.visit_date] || { sp_name: v.sp_name, points: [] };
    groups[v.salesperson_id][v.visit_date].points.push(v);
  });
  // Days with only factory logs (no visits) still need a row so the owner can see them.
  factoryByKey.forEach((slot, key) => {
    const [spId, date] = key.split('|');
    groups[spId] = groups[spId] || {};
    if (!groups[spId][date]) groups[spId][date] = { sp_name: slot.sp_name, points: [] };
  });

  // Compute rows
  const rows = [];
  for (const spId of Object.keys(groups)) {
    for (const date of Object.keys(groups[spId])) {
      const g = groups[spId][date];
      const fSlot = factoryByKey.get(spId + '|' + date) || {};
      // Build the day's path: factory_in → visits in order → factory_out
      const path_ = [];
      if (fSlot.in)  path_.push({ kind: 'factory_in',  lat: fSlot.in.lat,  lng: fSlot.in.lng,  created_at: fSlot.in.created_at,  where_name: 'Factory (in)' });
      g.points.forEach(p => path_.push({ kind: 'visit', lat: p.lat, lng: p.lng, created_at: p.created_at, where_name: p.where_name }));
      if (fSlot.out) path_.push({ kind: 'factory_out', lat: fSlot.out.lat, lng: fSlot.out.lng, created_at: fSlot.out.created_at, where_name: 'Factory (out)' });
      let km = 0;
      for (let i = 1; i < path_.length; i++) {
        km += haversineMeters(path_[i - 1], path_[i]) / 1000;
      }
      // Already-synced check: an existing employee_km_log row that came
      // from this same (employee, date, "from-visits" note).
      const empRow = db.prepare('SELECT id, km_rate FROM employees WHERE user_id=? AND active=1').get(parseInt(spId));
      let already = null;
      if (empRow) {
        already = db.prepare("SELECT id, km, amount FROM employee_km_log WHERE employee_id=? AND log_date=? AND notes LIKE '%[auto from visits]%' ORDER BY id DESC LIMIT 1").get(empRow.id, date);
      }
      rows.push({
        salesperson_id: parseInt(spId), sp_name: g.sp_name, date,
        visits: g.points.length, km: km.toFixed(2),
        factory_in:  !!fSlot.in,
        factory_out: !!fSlot.out,
        first_visit: path_.length ? path_[0].created_at : null,
        last_visit:  path_.length ? path_[path_.length - 1].created_at : null,
        first_where: path_.length ? path_[0].where_name : '-',
        last_where:  path_.length ? path_[path_.length - 1].where_name : '-',
        employee_id: empRow ? empRow.id : null,
        km_rate: empRow ? empRow.km_rate : 0,
        already_synced: !!already,
        synced_amount: already ? already.amount : null,
      });
    }
  }
  rows.sort((a, b) => b.date.localeCompare(a.date) || a.sp_name.localeCompare(b.sp_name));

  // Totals per salesperson for the month (only rows that aren't synced yet)
  const totals = {};
  rows.forEach(r => {
    totals[r.sp_name] = totals[r.sp_name] || { km: 0, days: 0, visits: 0 };
    totals[r.sp_name].km     += parseFloat(r.km);
    totals[r.sp_name].days   += 1;
    totals[r.sp_name].visits += r.visits;
  });

  res.render('visits/km-report', { title: 'KM Report', rows, totals, month });
});

// Push one (salesperson × date) row into HR → Mileage log.
router.post('/km/sync', (req, res) => {
  const { salesperson_id, date, km } = req.body;
  const back = req.get('Referer') || '/visits/km/report';
  const emp = db.prepare('SELECT id, km_rate FROM employees WHERE user_id=? AND active=1').get(parseInt(salesperson_id));
  if (!emp) {
    flash(req, 'danger', 'No active employee record linked to this user. Add one in HR → Employees with this user as the linked account.');
    return res.redirect(back);
  }
  if (!emp.km_rate) {
    flash(req, 'danger', 'Employee has no KM rate set. Edit them in HR → Employees and set the per-km rate first.');
    return res.redirect(back);
  }
  const dup = db.prepare("SELECT id FROM employee_km_log WHERE employee_id=? AND log_date=? AND notes LIKE '%[auto from visits]%'").get(emp.id, date);
  if (dup) {
    flash(req, 'warning', 'Already synced for that day.');
    return res.redirect(back);
  }
  const km_n = parseFloat(km);
  const amount = km_n * emp.km_rate;
  db.prepare(`INSERT INTO employee_km_log (employee_id, log_date, km, rate_per_km, amount, notes, created_by) VALUES (?,?,?,?,?,?,?)`)
    .run(emp.id, date, km_n, emp.km_rate, amount, `[auto from visits]`, req.session.user.id);
  req.audit('sync_km', 'visit', null, `salesperson #${salesperson_id} date=${date} km=${km_n} amount=${amount}`);
  flash(req, 'success', `Synced ${km_n.toFixed(2)} km × ₹${emp.km_rate} = ₹${amount.toFixed(2)} to HR Mileage log.`);
  res.redirect(back);
});

// ─── List ──────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const { where, params } = scopeSql(req);
  const items = db.prepare(`
    SELECT v.*, u.name AS sp_name, d.code AS dealer_code, d.name AS dealer_name, d.city AS dealer_city
    FROM dealer_visits v
    JOIN users u ON u.id=v.salesperson_id
    LEFT JOIN dealers d ON d.id=v.dealer_id
    WHERE ${where}
    ORDER BY v.id DESC LIMIT 200
  `).all(...params);
  // Today's factory in/out for the logged-in user (banner at top of list)
  const today = new Date().toISOString().slice(0,10);
  const todayFactory = {
    in:  db.prepare('SELECT id, photo_path, created_at FROM factory_logs WHERE salesperson_id=? AND log_date=? AND log_type=?').get(req.session.user.id, today, 'in'),
    out: db.prepare('SELECT id, photo_path, created_at FROM factory_logs WHERE salesperson_id=? AND log_date=? AND log_type=?').get(req.session.user.id, today, 'out'),
  };
  res.render('visits/index', { title: 'Field Visits', items, todayFactory });
});

// ─── New visit form ────────────────────────────────────────────
router.get('/new', (req, res) => {
  // Salesperson sees only their assigned dealers; admin/owner see all.
  const dealersSql = req.session.user.role === 'salesperson'
    ? 'SELECT id, code, name, city, last_visit_lat, last_visit_lng FROM dealers WHERE active=1 AND salesperson_id=? ORDER BY name'
    : 'SELECT id, code, name, city, last_visit_lat, last_visit_lng FROM dealers WHERE active=1 ORDER BY name';
  const params = req.session.user.role === 'salesperson' ? [req.session.user.id] : [];
  const dealers = db.prepare(dealersSql).all(...params);
  res.render('visits/new', { title: 'New Visit', dealers });
});

// ─── Create ────────────────────────────────────────────────────
router.post('/', upload.single('photo'), async (req, res) => {
  if (!req.file) {
    flash(req, 'danger', 'Photo is required (camera capture).');
    return res.redirect('/visits/new');
  }
  const { visit_type, dealer_id, prospect_name, prospect_phone, prospect_shop, prospect_city, notes } = req.body;
  const lat = parseFloat(req.body.lat);
  const lng = parseFloat(req.body.lng);
  const accuracy_m = parseFloat(req.body.accuracy_m || 0);

  // Validate location
  if (!isFinite(lat) || !isFinite(lng)) {
    fs.unlinkSync(req.file.path);
    flash(req, 'danger', 'Live location is required. Allow location permission and try again.');
    return res.redirect('/visits/new');
  }
  if (accuracy_m > 0 && accuracy_m > 500) {
    fs.unlinkSync(req.file.path);
    flash(req, 'danger', `GPS too weak (±${Math.round(accuracy_m)}m). Step outside or near a window and try again — accuracy must be 500m or better.`);
    return res.redirect('/visits/new');
  }

  // Validate per-type fields
  if (visit_type === 'existing') {
    if (!dealer_id) { fs.unlinkSync(req.file.path); flash(req,'danger','Pick a dealer.'); return res.redirect('/visits/new'); }
  } else if (visit_type === 'prospect') {
    if (!prospect_name || !prospect_phone || !prospect_shop || !prospect_city) {
      fs.unlinkSync(req.file.path);
      flash(req, 'danger', 'Name, mobile, shop name, and city are all required for a new prospect.');
      return res.redirect('/visits/new');
    }
  } else {
    fs.unlinkSync(req.file.path);
    flash(req, 'danger', 'Pick visit type.');
    return res.redirect('/visits/new');
  }

  // Try to read EXIF DateTimeOriginal for the audit trail. If the file doesn't
  // have EXIF (e.g. WhatsApp re-encoded it), that's fine — we still capture the
  // upload time. exifr is async, so we await it.
  let taken_at = null;
  try {
    const exifr = require('exifr');
    const exif = await exifr.parse(req.file.path, ['DateTimeOriginal', 'CreateDate', 'GPSLatitude', 'GPSLongitude']).catch(() => null);
    if (exif && (exif.DateTimeOriginal || exif.CreateDate)) {
      taken_at = new Date(exif.DateTimeOriginal || exif.CreateDate).toISOString();
    }
  } catch (_) { /* exifr not available or parse failed — non-fatal */ }

  const visit_no = nextCode('dealer_visits', 'visit_no', 'VST');
  const photo_path = '/uploads/visits/' + path.relative(UPLOAD_ROOT, req.file.path).replace(/\\/g, '/');

  const trx = db.transaction(() => {
    const r = db.prepare(`INSERT INTO dealer_visits (visit_no, salesperson_id, visit_type, dealer_id, prospect_name, prospect_phone, prospect_shop, prospect_city, photo_path, lat, lng, accuracy_m, taken_at, device_info, ip, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(visit_no, req.session.user.id, visit_type,
           visit_type === 'existing' ? parseInt(dealer_id) : null,
           visit_type === 'prospect' ? prospect_name : null,
           visit_type === 'prospect' ? prospect_phone : null,
           visit_type === 'prospect' ? prospect_shop : null,
           visit_type === 'prospect' ? prospect_city : null,
           photo_path, lat, lng, accuracy_m || null, taken_at,
           req.headers['user-agent'] || null, req.ip, notes || null);
    // Cache the dealer's last-known location so the next visit can warn
    // if it's far from this one.
    if (visit_type === 'existing') {
      db.prepare(`UPDATE dealers SET last_visit_lat=?, last_visit_lng=?, last_visit_at=datetime('now') WHERE id=?`)
        .run(lat, lng, parseInt(dealer_id));
    }
    return r.lastInsertRowid;
  });
  const id = trx();
  req.audit('create', 'visit', id, `${visit_no} · ${visit_type === 'existing' ? 'dealer #' + dealer_id : 'new: ' + prospect_name + ' (' + prospect_phone + ')'} · ±${Math.round(accuracy_m)}m`);
  flash(req, 'success', 'Visit ' + visit_no + ' logged.');
  res.redirect('/visits/' + id);
});

// ─── Show ──────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const v = db.prepare(`
    SELECT v.*, u.name AS sp_name, d.code AS dealer_code, d.name AS dealer_name, d.city AS dealer_city, d.last_visit_lat, d.last_visit_lng,
      pd.name AS promoted_name
    FROM dealer_visits v
    JOIN users u ON u.id=v.salesperson_id
    LEFT JOIN dealers d ON d.id=v.dealer_id
    LEFT JOIN dealers pd ON pd.id=v.promoted_to_dealer_id
    WHERE v.id=?
  `).get(req.params.id);
  if (!v) return res.redirect('/visits');
  if (req.session.user.role === 'salesperson' && v.salesperson_id !== req.session.user.id) {
    flash(req,'danger','Not your visit'); return res.redirect('/visits');
  }
  res.render('visits/show', { title: 'Visit ' + v.visit_no, v });
});

// ─── Map view ──────────────────────────────────────────────────
router.get('/map/recent', (req, res) => {
  const { where, params } = scopeSql(req);
  const items = db.prepare(`
    SELECT v.id, v.visit_no, v.lat, v.lng, v.photo_path, v.created_at, v.visit_type,
      u.name AS sp_name, d.name AS dealer_name, v.prospect_name, v.prospect_shop
    FROM dealer_visits v
    JOIN users u ON u.id=v.salesperson_id
    LEFT JOIN dealers d ON d.id=v.dealer_id
    WHERE ${where} AND date(v.created_at) >= date('now','-7 days')
    ORDER BY v.id DESC
  `).all(...params);
  res.render('visits/map', { title: 'Visit Map (7 days)', items });
});

// ─── Prospects (visits without a real dealer yet) ──────────────
router.get('/prospects/list', (req, res) => {
  const { where, params } = scopeSql(req);
  const items = db.prepare(`
    SELECT v.*, u.name AS sp_name, pd.name AS promoted_name
    FROM dealer_visits v
    JOIN users u ON u.id=v.salesperson_id
    LEFT JOIN dealers pd ON pd.id=v.promoted_to_dealer_id
    WHERE v.visit_type='prospect' AND ${where}
    ORDER BY v.id DESC LIMIT 200
  `).all(...params);
  res.render('visits/prospects', { title: 'Prospects', items });
});

// ─── Promote a prospect → real dealer (owner/admin only) ───────
router.post('/:id/promote', (req, res) => {
  if (!['owner','admin'].includes(req.session.user.role)) {
    flash(req,'danger','Only owner/admin can convert a prospect to a dealer.');
    return res.redirect('/visits/' + req.params.id);
  }
  const v = db.prepare('SELECT * FROM dealer_visits WHERE id=?').get(req.params.id);
  if (!v || v.visit_type !== 'prospect') return res.redirect('/visits');
  if (v.promoted_to_dealer_id) {
    flash(req,'warning','Already promoted.');
    return res.redirect('/visits/' + v.id);
  }
  const code = nextCode('dealers', 'code', 'DLR');
  const trx = db.transaction(() => {
    const r = db.prepare(`INSERT INTO dealers (code, name, contact_person, phone, city, salesperson_id, last_visit_lat, last_visit_lng, last_visit_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))`)
      .run(code, v.prospect_shop || v.prospect_name, v.prospect_name, v.prospect_phone, v.prospect_city, v.salesperson_id, v.lat, v.lng);
    db.prepare('UPDATE dealer_visits SET promoted_to_dealer_id=? WHERE id=?').run(r.lastInsertRowid, v.id);
    return r.lastInsertRowid;
  });
  const dealerId = trx();
  req.audit('promote', 'visit', v.id, `${v.visit_no} → dealer ${code}`);
  flash(req, 'success', `Created dealer ${code} from prospect.`);
  res.redirect('/dealers/' + dealerId);
});

// ─── Delete (owner/admin only) ─────────────────────────────────
router.post('/:id/delete', (req, res) => {
  if (!['owner','admin'].includes(req.session.user.role)) {
    flash(req,'danger','Only owner/admin can delete a visit.');
    return res.redirect('/visits/' + req.params.id);
  }
  const v = db.prepare('SELECT photo_path FROM dealer_visits WHERE id=?').get(req.params.id);
  if (!v) return res.redirect('/visits');
  // Best-effort photo cleanup
  if (v.photo_path) {
    const abs = path.join(__dirname, '..', '..', 'public', v.photo_path.replace(/^\//, ''));
    if (fs.existsSync(abs)) try { fs.unlinkSync(abs); } catch (_) {}
  }
  db.prepare('DELETE FROM dealer_visits WHERE id=?').run(req.params.id);
  req.audit('delete', 'visit', req.params.id);
  flash(req,'success','Visit deleted.');
  res.redirect('/visits');
});

module.exports = router;
module.exports.haversineMeters = haversineMeters;
