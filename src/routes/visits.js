const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { nextCode } = require('../utils/codegen');
const { fmtDateTime } = require('../utils/format');
const { getUserLevel, requireFeature } = require('../middleware/permissions');
const router = express.Router();

// Field sub-pages that can be granted independently of Field Visits. They
// inherit the `visits` level by default (so nothing changes unless the owner
// tweaks them in Access & Roles): Map = the recent-visits map, KM = the
// travel/mileage report.
router.use('/map',       requireFeature('visits_map'));
router.use('/km',        requireFeature('visits_km'));
router.use('/prospects', requireFeature('visits_prospects'));
router.use('/plan',      requireFeature('visits_plan'));

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
  // Wraps the central team-scope helper. Owner/admin/accountant get
  // unfiltered; salesperson sees only own; area_manager sees own +
  // direct reports' visits.
  return require('../middleware/scope').scopeWhere(req, 'v.salesperson_id');
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

// ─── Team Factory Log (owner/admin) ──────────────────────────
// Shows every salesperson's Factory In + Factory Out for a selected day
// (or month) with photos, GPS, and working hours computed from in/out
// timestamps. Useful as a GPS-verified attendance reference — the
// HR manual-attendance page still works independently.
router.get('/factory/log', (req, res) => {
  // 'full' on factory_log = sees the whole team (owner/admin/accountant by default).
  // 'limited' = sees only their own rows. The route mount already rejected 'none'.
  const isLimited = getUserLevel(req.session.user, 'factory_log') !== 'full';
  const mode = req.query.mode === 'month' ? 'month' : 'day';
  const today = new Date().toISOString().slice(0, 10);
  const date = (req.query.date || today);
  const month = (req.query.month || today.slice(0, 7)); // YYYY-MM

  let sql, params;
  if (mode === 'month') {
    sql = `SELECT f.salesperson_id, u.name AS sp_name, f.log_date, f.log_type,
                  f.photo_path, f.created_at, f.lat, f.lng, f.accuracy_m
           FROM factory_logs f JOIN users u ON u.id = f.salesperson_id
           WHERE strftime('%Y-%m', f.log_date) = ?`;
    params = [month];
  } else {
    sql = `SELECT f.salesperson_id, u.name AS sp_name, f.log_date, f.log_type,
                  f.photo_path, f.created_at, f.lat, f.lng, f.accuracy_m
           FROM factory_logs f JOIN users u ON u.id = f.salesperson_id
           WHERE f.log_date = ?`;
    params = [date];
  }
  if (isLimited) {
    // Team scope: salesperson sees own day; area_manager sees own + team.
    const sc = require('../middleware/scope').scopeWhere(req, 'f.salesperson_id');
    if (sc.where !== '1=1') { sql += ' AND ' + sc.where; params.push(...sc.params); }
  }
  sql += ' ORDER BY u.name, f.log_date DESC, f.log_type';
  const logs = db.prepare(sql).all(...params);

  // Group by (salesperson, date) → { in, out, working_hours }
  const groups = new Map();
  for (const r of logs) {
    const key = r.salesperson_id + '|' + r.log_date;
    let g = groups.get(key);
    if (!g) {
      g = { salesperson_id: r.salesperson_id, sp_name: r.sp_name, date: r.log_date, in: null, out: null };
      groups.set(key, g);
    }
    g[r.log_type] = r;
  }
  // Working hours = (out - in). Both are UTC strings; just take the time diff.
  const rows = [];
  for (const g of groups.values()) {
    let hours = null, mins = null;
    if (g.in && g.out) {
      const diffMs = new Date(g.out.created_at) - new Date(g.in.created_at);
      if (diffMs > 0) {
        const totalMin = Math.round(diffMs / 60000);
        hours = Math.floor(totalMin / 60);
        mins = totalMin % 60;
      }
    }
    rows.push({ ...g, hours, mins });
  }
  // Sort: most recent date first, then name.
  rows.sort((a, b) => b.date.localeCompare(a.date) || a.sp_name.localeCompare(b.sp_name));

  // Today's own status for the punch-in/out buttons at the top of the page.
  const todayStr = new Date().toISOString().slice(0, 10);
  const myToday = {
    in:  db.prepare('SELECT id, created_at FROM factory_logs WHERE salesperson_id=? AND log_date=? AND log_type=?').get(req.session.user.id, todayStr, 'in'),
    out: db.prepare('SELECT id, created_at FROM factory_logs WHERE salesperson_id=? AND log_date=? AND log_type=?').get(req.session.user.id, todayStr, 'out'),
  };

  res.render('visits/factory-log', {
    title: 'Factory In/Out',
    rows, mode, date, month,
    isLimited, myToday,
  });
});

// ─── KM Report ─────────────────────────────────────────────────
// Groups visits by salesperson × day and computes day's KM as the sum
// of haversine distance between consecutive visits.
router.get('/km/report', (req, res) => {
  // Date range filter — `from` / `to` are YYYY-MM-DD. For backwards
  // compatibility with older bookmarks the `month=YYYY-MM` param is
  // expanded into the first/last day of that month if from/to aren't
  // explicitly passed. Default: first day of current month → today.
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + '-01';
  let from = req.query.from;
  let to   = req.query.to;
  if (!from && !to && req.query.month) {
    // Legacy: month=YYYY-MM → expand to whole-month range.
    const m = String(req.query.month).slice(0, 7);
    from = m + '-01';
    // Last day of month: cheap trick — first of next month minus 1 day.
    const [y, mm] = m.split('-').map(Number);
    const last = new Date(Date.UTC(y, mm, 0));  // month=mm means 0-indexed next, so 0 = last day of mm
    to = last.toISOString().slice(0, 10);
  }
  if (!from) from = monthStart;
  if (!to)   to   = today;
  // Guard: from > to → swap.
  if (from > to) { [from, to] = [to, from]; }

  const { where, params } = scopeSql(req);
  const scopeMod = require('../middleware/scope');
  const officeFilter = req.query.office ? parseInt(req.query.office) : null;
  const officeUserIds = officeFilter ? scopeMod.userIdsForOffice(officeFilter) : null;
  const officeIdsClause = (alias) => {
    if (officeUserIds === null) return '';
    if (officeUserIds.length === 0) return ' AND 0=1';
    return ` AND ${alias}.salesperson_id IN (${officeUserIds.map(() => '?').join(',')})`;
  };

  const visits = db.prepare(`
    SELECT v.id, v.salesperson_id, u.name AS sp_name,
           date(v.created_at) AS visit_date,
           v.lat, v.lng, v.created_at, v.visit_no,
           CASE WHEN v.dealer_id IS NOT NULL THEN d.name
                ELSE COALESCE(v.prospect_shop, v.prospect_name) END AS where_name
    FROM dealer_visits v
    JOIN users u ON u.id=v.salesperson_id
    LEFT JOIN dealers d ON d.id=v.dealer_id
    WHERE date(v.created_at) BETWEEN ? AND ? AND ${where}${officeIdsClause('v')}
    ORDER BY v.salesperson_id, v.created_at
  `).all(from, to, ...params, ...(officeUserIds || []));

  // Factory bookends for the same range/scope.
  const fScope = scopeSql(req);
  const factoryRows = db.prepare(`
    SELECT f.salesperson_id, u.name AS sp_name, f.log_date AS visit_date,
           f.log_type, f.lat, f.lng, f.created_at, f.photo_path
    FROM factory_logs f JOIN users u ON u.id=f.salesperson_id
    WHERE f.log_date BETWEEN ? AND ? AND ${fScope.where.replace(/v\./g, 'f.')}${officeIdsClause('f')}
  `).all(from, to, ...fScope.params, ...(officeUserIds || []));
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

  const visibleOffices = scopeMod.visibleOffices(req);
  const officeName = officeFilter ? (visibleOffices.find(o => o.id === officeFilter)?.name || null) : null;
  res.render('visits/km-report', { title: 'KM Report', rows, totals, from, to, visibleOffices, officeFilter, officeName });
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
  // Dealer dropdown is scoped to the user's team: salesperson sees own,
  // area_manager sees own + reports, owner/admin/accountant see all.
  const sc = require('../middleware/scope').scopeWhere(req, 'salesperson_id');
  let dealersSql = 'SELECT id, code, name, city, last_visit_lat, last_visit_lng FROM dealers WHERE active=1';
  if (sc.where !== '1=1') dealersSql += ' AND ' + sc.where;
  dealersSql += ' ORDER BY name';
  const dealers = db.prepare(dealersSql).all(...sc.params);
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

// ─── Route Planning ────────────────────────────────────────────
// Salesperson picks which assigned dealers to visit today, system orders
// them by nearest-neighbour starting from the factory (median of recent
// factory_in logs) so the salesperson doesn't crisscross the city.
// Registered BEFORE /:id so Express doesn't treat "plan" as a visit id.
function nearestNeighbour(start, points) {
  const remaining = points.slice();
  const order = [];
  let cur = start;
  while (remaining.length) {
    let bestIdx = 0;
    let best = haversineMeters(cur, remaining[0]);
    for (let i = 1; i < remaining.length; i++) {
      const d = haversineMeters(cur, remaining[i]);
      if (d < best) { best = d; bestIdx = i; }
    }
    const p = remaining.splice(bestIdx, 1)[0];
    order.push(p);
    cur = p;
  }
  return order;
}

router.get('/plan', (req, res) => {
  const scope = require('../middleware/scope');
  // Two modes:
  //   sp       → plan one salesperson's assigned dealers (default)
  //   dispatch → a delivery/dispatch run across ANY dealers you can see
  //              (owner/admin = all salespersons; salesperson = own, scoped).
  const mode = req.query.mode === 'dispatch' ? 'dispatch' : 'sp';
  const isOwn = req.session.user.role === 'salesperson';

  let spId = null, sp = null, salespersons = null;
  let dealers = [], unlocated = [];
  let factoryLoc = null, homeOfficeName = 'Factory';
  let source = 'manual', dispatchSummary = null, preselectIds = null;

  if (mode === 'dispatch') {
    // Source of the run:
    //   manual  → pick any dealers yourself (default)
    //   pending → "Available for dispatch": invoices raised but not yet
    //             dispatched (goods to load).
    //   transit → "Out for delivery": dispatched but not yet delivered.
    source = ['pending', 'transit'].includes(req.query.source) ? req.query.source : 'manual';
    const sc = scope.scopeWhere(req, 'd.salesperson_id');
    const scopeSql = sc.where !== '1=1' ? ' AND ' + sc.where : '';

    // dealer_id → { n, amt } of open dispatch work, when a source is chosen.
    let relevant = null;
    if (source === 'pending') {
      relevant = new Map(db.prepare(`
        SELECT i.dealer_id, COUNT(*) n, COALESCE(SUM(i.total),0) amt
        FROM invoices i
        WHERE i.status!='cancelled' AND NOT EXISTS (SELECT 1 FROM dispatches d WHERE d.invoice_id=i.id)
        GROUP BY i.dealer_id`).all().map(r => [r.dealer_id, { n: r.n, amt: r.amt }]));
    } else if (source === 'transit') {
      relevant = new Map(db.prepare(`
        SELECT dp.dealer_id, COUNT(*) n, COALESCE(SUM(i.total),0) amt
        FROM dispatches dp LEFT JOIN invoices i ON i.id=dp.invoice_id
        WHERE dp.status='dispatched' AND (dp.delivered_date IS NULL OR dp.delivered_date='')
        GROUP BY dp.dealer_id`).all().map(r => [r.dealer_id, { n: r.n, amt: r.amt }]));
    }
    const relIds = relevant ? [...relevant.keys()] : null;
    const relFilter = relIds ? (relIds.length ? ` AND d.id IN (${relIds.map(() => '?').join(',')})` : ' AND 1=0') : '';
    const relParams = relIds || [];

    dealers = db.prepare(`
      SELECT d.id, d.code, d.name, d.city, d.phone, d.address,
             d.last_visit_lat AS lat, d.last_visit_lng AS lng, d.last_visit_at, u.name AS sp_name
      FROM dealers d LEFT JOIN users u ON u.id=d.salesperson_id
      WHERE d.active=1 AND d.last_visit_lat IS NOT NULL${scopeSql}${relFilter}
      ORDER BY COALESCE(d.city,''), d.name`).all(...sc.params, ...relParams);
    dealers.forEach(d => { d.last_visit_ist = d.last_visit_at ? fmtDateTime(d.last_visit_at) : null; if (relevant) d.pending = relevant.get(d.id) || null; });
    unlocated = db.prepare(`
      SELECT d.id, d.code, d.name, d.city, d.phone, u.name AS sp_name
      FROM dealers d LEFT JOIN users u ON u.id=d.salesperson_id
      WHERE d.active=1 AND d.last_visit_lat IS NULL${scopeSql}${relFilter}
      ORDER BY COALESCE(d.city,''), d.name`).all(...sc.params, ...relParams);
    unlocated.forEach(d => { if (relevant) d.pending = relevant.get(d.id) || null; });

    if (relevant) {
      preselectIds = dealers.map(d => d.id);   // route auto-computes for all routable ones
      const all = dealers.concat(unlocated);
      dispatchSummary = {
        source, dealerCount: all.length, locatedCount: dealers.length, unlocatedCount: unlocated.length,
        amount: all.reduce((s, d) => s + (d.pending ? d.pending.amt : 0), 0),
      };
    }

    const fo = db.prepare("SELECT name,lat,lng FROM locations WHERE active=1 AND lat IS NOT NULL AND lng IS NOT NULL ORDER BY id LIMIT 1").get();
    if (fo) { factoryLoc = { lat: fo.lat, lng: fo.lng }; homeOfficeName = fo.name; }
  } else {
    // Salesperson plans for themselves; others pick a salesperson in scope.
    spId = isOwn ? req.session.user.id : (req.query.sp ? parseInt(req.query.sp) : null);
    if (spId && !isOwn && !scope.isInScope(req, spId)) spId = null;
    salespersons = isOwn ? null : scope.visibleSalespersons(req).filter(u => u.role === 'salesperson');
    if (spId) {
      dealers = db.prepare(`
        SELECT d.id, d.code, d.name, d.city, d.phone, d.address,
               d.last_visit_lat AS lat, d.last_visit_lng AS lng, d.last_visit_at
        FROM dealers d WHERE d.active=1 AND d.salesperson_id=? AND d.last_visit_lat IS NOT NULL
        ORDER BY COALESCE(d.city,''), d.name`).all(spId);
      dealers.forEach(d => { d.last_visit_ist = d.last_visit_at ? fmtDateTime(d.last_visit_at) : null; });
      unlocated = db.prepare(`
        SELECT d.id, d.code, d.name, d.city, d.phone
        FROM dealers d WHERE d.active=1 AND d.salesperson_id=? AND d.last_visit_lat IS NULL
        ORDER BY COALESCE(d.city,''), d.name`).all(spId);
    }
    sp = spId ? db.prepare('SELECT id, name FROM users WHERE id=?').get(spId) : null;
    if (sp && sp.id) {
      const homeOffice = db.prepare(`
        SELECT l.id, l.name, l.lat, l.lng FROM users u JOIN locations l ON l.id = u.home_office_id
         WHERE u.id = ? AND l.active = 1 AND l.lat IS NOT NULL AND l.lng IS NOT NULL`).get(sp.id);
      if (homeOffice) { factoryLoc = { lat: homeOffice.lat, lng: homeOffice.lng }; homeOfficeName = homeOffice.name; }
    }
  }

  // Legacy fallback anchor for both modes: median of recent factory_in logs.
  if (!factoryLoc) {
    const factoryRows = db.prepare(`SELECT lat, lng FROM factory_logs WHERE log_type='in' AND lat IS NOT NULL AND lng IS NOT NULL ORDER BY id DESC LIMIT 50`).all();
    if (factoryRows.length) {
      const lats = factoryRows.map(r => r.lat).sort((a, b) => a - b);
      const lngs = factoryRows.map(r => r.lng).sort((a, b) => a - b);
      factoryLoc = { lat: lats[Math.floor(lats.length / 2)], lng: lngs[Math.floor(lngs.length / 2)] };
    }
  }

  // Group locatable dealers by city for the picker UI.
  const byCity = {};
  dealers.forEach(d => { const c = d.city || 'City not set'; (byCity[c] = byCity[c] || []).push(d); });
  const cityNames = Object.keys(byCity).sort();

  // If ids[] passed, compute the optimised loop. Otherwise show the picker.
  // A dispatch source (pending/transit) pre-selects all routable dealers so the
  // delivery route auto-computes — the user can still uncheck and re-plan.
  let idsCsv = (req.query.ids || '').trim();
  if (!idsCsv && preselectIds && preselectIds.length) idsCsv = preselectIds.join(',');
  let plan = null;
  if (idsCsv && dealers.length) {
    const wanted = new Set(idsCsv.split(',').map(x => parseInt(x)).filter(Boolean));
    const picked = dealers.filter(d => wanted.has(d.id));
    if (picked.length) {
      const start = factoryLoc || { lat: picked[0].lat, lng: picked[0].lng };
      const ordered = nearestNeighbour(start, picked);
      const legs = [];
      let totalKm = 0;
      if (factoryLoc) { const k = haversineMeters(factoryLoc, ordered[0]) / 1000; legs.push({ from_label: homeOfficeName, to_label: ordered[0].name, km: k }); totalKm += k; }
      for (let i = 1; i < ordered.length; i++) { const k = haversineMeters(ordered[i - 1], ordered[i]) / 1000; legs.push({ from_label: ordered[i - 1].name, to_label: ordered[i].name, km: k }); totalKm += k; }
      if (factoryLoc) { const k = haversineMeters(ordered[ordered.length - 1], factoryLoc) / 1000; legs.push({ from_label: ordered[ordered.length - 1].name, to_label: homeOfficeName, km: k }); totalKm += k; }
      plan = { picked: ordered, legs, totalKm, hasFactory: !!factoryLoc, homeOfficeName };
    }
  }

  const routeLabel = mode === 'dispatch' ? 'Dispatch run' : (sp ? sp.name : '');
  res.render('visits/plan', {
    title: 'Route Plan' + (routeLabel ? ' · ' + routeLabel : ''),
    mode, isOwn, sp, spId, salespersons, dealers, unlocated, byCity, cityNames,
    factoryLoc, homeOfficeName, plan, idsCsv, routeLabel, source, dispatchSummary,
    canDispatch: res.locals.canWrite ? res.locals.canWrite('dispatch') : false,
  });
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
  // Team scope: salesperson sees own only; area_manager sees own + reports.
  if (!require('../middleware/scope').isInScope(req, v.salesperson_id)) {
    flash(req,'danger','Outside your scope.'); return res.redirect('/visits');
  }
  // Same permission flags as the prospects list — drive the buttons.
  if (v.visit_type === 'prospect') {
    v.can_act      = canActOnProspect(req, v);
    v.can_reassign = canReassignProspect(req, v);
  }
  res.render('visits/show', { title: 'Visit ' + v.visit_no, v });
});

// ─── KM Path visualisation ────────────────────────────────────
// Opens in a new tab from the KM Report. Shows the salesperson's actual
// geo-tagged journey for a given date as a polyline on the map, with the
// haversine distance labelled on each leg. So if a salesperson argues about
// the km figure, you can pull this up and show exactly which pin-to-pin
// straight lines added up to the daily total.
router.get('/km/path/:spId/:date', (req, res) => {
  const spId = parseInt(req.params.spId);
  const date = req.params.date; // YYYY-MM-DD
  if (!spId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    flash(req, 'danger', 'Bad parameters.');
    return res.redirect('/visits/km/report');
  }
  // Team scope: salesperson sees own only; area_manager sees own +
  // reports; owner/admin/accountant see anyone.
  if (!require('../middleware/scope').isInScope(req, spId)) {
    flash(req, 'danger', 'Outside your scope.');
    return res.redirect('/visits/km/report');
  }

  const sp = db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(spId);
  if (!sp) { flash(req, 'danger', 'User not found.'); return res.redirect('/visits/km/report'); }

  // Build the same ordered point list the KM report aggregates from.
  const factoryIn  = db.prepare("SELECT lat, lng, created_at, photo_path, accuracy_m FROM factory_logs WHERE salesperson_id=? AND log_date=? AND log_type='in'").get(spId, date);
  const factoryOut = db.prepare("SELECT lat, lng, created_at, photo_path, accuracy_m FROM factory_logs WHERE salesperson_id=? AND log_date=? AND log_type='out'").get(spId, date);
  const visits = db.prepare(`
    SELECT v.id, v.visit_no, v.lat, v.lng, v.created_at, v.photo_path, v.accuracy_m,
           v.visit_type, d.name AS dealer_name, d.city AS dealer_city,
           v.prospect_name, v.prospect_shop, v.prospect_city
    FROM dealer_visits v
    LEFT JOIN dealers d ON d.id = v.dealer_id
    WHERE v.salesperson_id = ? AND date(v.created_at) = ?
    ORDER BY v.created_at
  `).all(spId, date);

  // stops = [factoryIn?, ...visits, factoryOut?] in chronological order
  // (Named "stops" instead of "path" because `path` collides with the
  // res.locals.path string the sidebar partial expects.)
  const stops = [];
  if (factoryIn) {
    stops.push({
      kind: 'factory_in', label: 'Factory (in)',
      lat: factoryIn.lat, lng: factoryIn.lng,
      when_ist: fmtDateTime(factoryIn.created_at),
      photo: factoryIn.photo_path, accuracy_m: factoryIn.accuracy_m,
    });
  }
  visits.forEach(v => {
    const place = v.dealer_name ? `${v.dealer_name}${v.dealer_city ? ' · ' + v.dealer_city : ''}`
      : (v.prospect_shop ? `${v.prospect_shop} (${v.prospect_name})${v.prospect_city ? ' · ' + v.prospect_city : ''}` : 'Unnamed');
    stops.push({
      kind: 'visit', label: `${v.visit_no} · ${place}`,
      visit_id: v.id, type: v.visit_type,
      lat: v.lat, lng: v.lng,
      when_ist: fmtDateTime(v.created_at),
      photo: v.photo_path, accuracy_m: v.accuracy_m,
    });
  });
  if (factoryOut) {
    stops.push({
      kind: 'factory_out', label: 'Factory (out)',
      lat: factoryOut.lat, lng: factoryOut.lng,
      when_ist: fmtDateTime(factoryOut.created_at),
      photo: factoryOut.photo_path, accuracy_m: factoryOut.accuracy_m,
    });
  }

  // Compute per-leg distances and the total — identical to /km/report so
  // the sum matches what the report shows for this row.
  let totalKm = 0;
  const legs = [];
  for (let i = 1; i < stops.length; i++) {
    const dKm = haversineMeters(stops[i - 1], stops[i]) / 1000;
    totalKm += dKm;
    legs.push({ from: i - 1, to: i, km: dKm });
  }

  res.render('visits/km-path', {
    title: `KM Path · ${sp.name} · ${date}`,
    sp, date, stops, legs, totalKm,
  });
});

// ─── Map view ──────────────────────────────────────────────────
// Now supports ?from=YYYY-MM-DD&to=YYYY-MM-DD&sp=<id> filters and serves an
// expansion-coverage sidebar (cities + counts) alongside the pin map.
router.get('/map/recent', (req, res) => {
  const { where, params } = scopeSql(req);
  const scopeMod = require('../middleware/scope');
  const today = new Date().toISOString().slice(0, 10);
  // Defaults: last 7 days for backwards compat with the existing list link.
  const defaultFrom = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const from = req.query.from || defaultFrom;
  const to   = req.query.to   || today;
  const spFilter = (req.query.sp || '').trim();
  // Phase 3: office filter
  const officeFilter = req.query.office ? parseInt(req.query.office) : null;
  const officeUserIds = officeFilter ? scopeMod.userIdsForOffice(officeFilter) : null;

  let sql = `
    SELECT v.id, v.visit_no, v.lat, v.lng, v.photo_path, v.created_at, v.visit_type,
           v.salesperson_id, u.name AS sp_name,
           d.name AS dealer_name, d.city AS dealer_city,
           v.prospect_name, v.prospect_shop, v.prospect_city
    FROM dealer_visits v
    JOIN users u ON u.id = v.salesperson_id
    LEFT JOIN dealers d ON d.id = v.dealer_id
    WHERE ${where}
      AND date(v.created_at) BETWEEN ? AND ?`;
  const p = [...params, from, to];
  if (spFilter) { sql += ' AND v.salesperson_id = ?'; p.push(parseInt(spFilter)); }
  if (officeUserIds !== null) {
    if (officeUserIds.length === 0) { sql += ' AND 0=1'; }
    else { sql += ' AND v.salesperson_id IN (' + officeUserIds.map(() => '?').join(',') + ')'; p.push(...officeUserIds); }
  }
  sql += ' ORDER BY v.id DESC';
  const items = db.prepare(sql).all(...p);

  // Distinct salespersons that appear in the result — drives the legend +
  // dropdown. Pull from a separate query so the dropdown lists all reps even
  // when the user has filtered to one.
  // Salesperson dropdown — restricted to the user's visible team so an
  // area manager can't filter by someone outside it.
  const visibleIds = require('../middleware/scope').getScopeUserIds(req);
  let spDropSql = `
    SELECT u.id, u.name, COUNT(v.id) AS visit_count
    FROM users u
    LEFT JOIN dealer_visits v ON v.salesperson_id = u.id
      AND date(v.created_at) BETWEEN ? AND ?
    WHERE u.role = 'salesperson' AND u.active = 1`;
  const spDropParams = [from, to];
  if (visibleIds !== null) {
    spDropSql += ' AND u.id IN (' + visibleIds.map(() => '?').join(',') + ')';
    spDropParams.push(...visibleIds);
  }
  spDropSql += ' GROUP BY u.id ORDER BY visit_count DESC, u.name';
  const salespersons = db.prepare(spDropSql).all(...spDropParams);

  // Pre-format the visit timestamp to IST so the pin popup doesn't render
  // the raw "YYYY-MM-DD HH:MM:SS" UTC string. created_at is kept too in case
  // anyone needs it.
  items.forEach(it => { it.when_ist = fmtDateTime(it.created_at); });

  // ─── Stores layer ─────────────────────────────────────────────
  // Every active dealer whose location has been captured at least once
  // gets pinned as a 🏪 store. The location was stamped by the most-recent
  // visit (see UPDATE in POST / above). Salespersons only see their own
  // dealers; owner/admin see everyone's.
  let storeSql = `
    SELECT d.id, d.code, d.name, d.city, d.phone,
           d.last_visit_lat AS lat, d.last_visit_lng AS lng, d.last_visit_at,
           d.salesperson_id, COALESCE(u.name, '—') AS sp_name,
           (SELECT COUNT(*) FROM dealer_visits v WHERE v.dealer_id = d.id) AS visit_count,
           COALESCE((SELECT SUM(total) FROM invoices i WHERE i.dealer_id = d.id AND i.status != 'cancelled'),0) AS lifetime_sales
    FROM dealers d
    LEFT JOIN users u ON u.id = d.salesperson_id
    WHERE d.active = 1 AND d.last_visit_lat IS NOT NULL AND d.last_visit_lng IS NOT NULL`;
  const storeParams = [];
  // Team scope on dealers (salesperson sees own dealers, area_manager
  // sees team dealers, full-visibility roles see all).
  const dscope = require('../middleware/scope').scopeWhere(req, 'd.salesperson_id');
  if (dscope.where !== '1=1') { storeSql += ' AND ' + dscope.where; storeParams.push(...dscope.params); }
  if (spFilter) {
    storeSql += ' AND d.salesperson_id = ?';
    storeParams.push(parseInt(spFilter));
  }
  if (officeUserIds !== null) {
    if (officeUserIds.length === 0) { storeSql += ' AND 0=1'; }
    else { storeSql += ' AND d.salesperson_id IN (' + officeUserIds.map(() => '?').join(',') + ')'; storeParams.push(...officeUserIds); }
  }
  storeSql += ' ORDER BY d.name';
  const stores = db.prepare(storeSql).all(...storeParams);
  stores.forEach(s => { s.last_visit_ist = s.last_visit_at ? fmtDateTime(s.last_visit_at) : null; });
  // Business-value star rating (1–5): rank dealers that have bought into 5
  // equal tiers by lifetime sales (top 20% = 5★). Dealers with no purchases
  // get 0★ (shown as "new / no orders"). Adapts to your own dealer sizes.
  const ranked = stores.filter(s => s.lifetime_sales > 0).slice().sort((a, b) => a.lifetime_sales - b.lifetime_sales);
  const rn = ranked.length;
  ranked.forEach((s, i) => { s.stars = rn ? Math.min(5, Math.floor(i / rn * 5) + 1) : 0; });
  stores.forEach(s => { if (!(s.lifetime_sales > 0)) s.stars = 0; });

  // For the sidebar: how many dealers have we located vs total assigned?
  // Tells the user "you've physically reached 12 of your 47 dealers."
  let coverageSql = `
    SELECT
      COUNT(*) AS total_dealers,
      SUM(CASE WHEN d.last_visit_lat IS NOT NULL THEN 1 ELSE 0 END) AS located
    FROM dealers d WHERE d.active = 1`;
  const coverageParams = [];
  // Same team-scope rule as the stores layer above.
  const cscope = require('../middleware/scope').scopeWhere(req, 'd.salesperson_id');
  if (cscope.where !== '1=1') { coverageSql += ' AND ' + cscope.where; coverageParams.push(...cscope.params); }
  else if (spFilter) {
    coverageSql += ' AND d.salesperson_id = ?';
    coverageParams.push(parseInt(spFilter));
  }
  if (officeUserIds !== null) {
    if (officeUserIds.length === 0) { coverageSql += ' AND 0=1'; }
    else { coverageSql += ' AND d.salesperson_id IN (' + officeUserIds.map(() => '?').join(',') + ')'; coverageParams.push(...officeUserIds); }
  }
  const dealerCoverage = db.prepare(coverageSql).get(...coverageParams);

  // Office markers — pull every active office that has GPS set so we
  // can render them on the map as 🏭 / 🏢 / 📦 anchors. Doesn't depend
  // on the office filter (the offices themselves don't get filtered;
  // only the data they govern does).
  const offices = db.prepare(`SELECT id, code, name, type, city, lat, lng FROM locations WHERE active=1 AND lat IS NOT NULL AND lng IS NOT NULL ORDER BY type, name`).all();
  const visibleOfficeList = scopeMod.visibleOffices(req);
  const officeName = officeFilter ? (visibleOfficeList.find(o => o.id === officeFilter)?.name || null) : null;

  // Coverage / expansion: cities visited in the period (existing dealer city
  // OR prospect city). Visits whose dealer master has no city set get
  // bucketed into "City not set" so it's obvious *which* records to fix.
  const coverage = {};
  let missingCityCount = 0;
  items.forEach(it => {
    const raw = (it.dealer_city || it.prospect_city || '').trim();
    const city = raw || 'City not set';
    if (!raw) missingCityCount++;
    if (!coverage[city]) coverage[city] = { city, visits: 0, prospects: 0, dealers: 0, missing: !raw };
    coverage[city].visits++;
    if (it.visit_type === 'prospect') coverage[city].prospects++;
    else coverage[city].dealers++;
  });
  // Real cities first (sorted by activity), then the "missing" bucket at the end.
  const coverageRows = Object.values(coverage).sort((a, b) => {
    if (a.missing !== b.missing) return a.missing ? 1 : -1;
    return b.visits - a.visits;
  });

  res.render('visits/map', {
    title: 'Visit Map · Coverage',
    items, salespersons, coverageRows, stores, dealerCoverage,
    offices, visibleOfficeList, officeFilter, officeName,
    from, to, spFilter, missingCityCount,
  });
});

// ─── Prospects (visits without a real dealer yet) ──────────────
// Beefed-up funnel view: stats strip + per-salesperson breakdown +
// filter chips (all / pending / promoted / lost) + reassign action.
router.get('/prospects/list', (req, res) => {
  const { where, params } = scopeSql(req);
  // Filter chips: status + which salesperson logged the prospect.
  const statusFilter = req.query.status || 'all';   // all | pending | promoted | lost
  const spFilter     = req.query.sp ? parseInt(req.query.sp) : null;

  const extra = [];
  const extraParams = [];
  if (statusFilter === 'pending')  extra.push('v.promoted_to_dealer_id IS NULL AND v.lost_at IS NULL');
  if (statusFilter === 'promoted') extra.push('v.promoted_to_dealer_id IS NOT NULL');
  if (statusFilter === 'lost')     extra.push('v.lost_at IS NOT NULL');
  if (spFilter)                    { extra.push('v.salesperson_id = ?'); extraParams.push(spFilter); }
  const extraSql = extra.length ? ' AND ' + extra.join(' AND ') : '';

  const items = db.prepare(`
    SELECT v.*, u.name AS sp_name, pd.name AS promoted_name,
      CAST(julianday('now') - julianday(v.created_at) AS INTEGER) AS days_old
    FROM dealer_visits v
    JOIN users u ON u.id=v.salesperson_id
    LEFT JOIN dealers pd ON pd.id=v.promoted_to_dealer_id
    WHERE v.visit_type='prospect' AND ${where}${extraSql}
    ORDER BY v.id DESC LIMIT 500
  `).all(...params, ...extraParams);

  // Attach per-row permission flags so the view can show / hide
  // Promote / Lost / Restore / Reassign buttons without re-checking
  // role logic in the template.
  items.forEach(v => {
    v.can_act      = canActOnProspect(req, v);
    v.can_reassign = canReassignProspect(req, v);
  });

  // Stats strip — counts across all prospects (ignoring filter chips so
  // the strip is the funnel overview, not the filtered view).
  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN promoted_to_dealer_id IS NULL AND lost_at IS NULL THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN promoted_to_dealer_id IS NOT NULL THEN 1 ELSE 0 END) AS promoted,
      SUM(CASE WHEN lost_at IS NOT NULL THEN 1 ELSE 0 END) AS lost,
      SUM(CASE WHEN promoted_to_dealer_id IS NULL AND lost_at IS NULL
                AND date(created_at) >= date('now','-7 days') THEN 1 ELSE 0 END) AS this_week
    FROM dealer_visits v
    WHERE v.visit_type='prospect' AND ${where}
  `).get(...params);
  const conversionRate = stats.total > 0 ? Math.round(stats.promoted * 100 / stats.total) : 0;

  // Per-salesperson breakdown — counts + conversion rate by SP. Helps
  // the owner see who's bringing in real leads vs noise.
  const bySp = db.prepare(`
    SELECT u.id, u.name,
      COUNT(*) AS total,
      SUM(CASE WHEN v.promoted_to_dealer_id IS NULL AND v.lost_at IS NULL THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN v.promoted_to_dealer_id IS NOT NULL THEN 1 ELSE 0 END) AS promoted,
      SUM(CASE WHEN v.lost_at IS NOT NULL THEN 1 ELSE 0 END) AS lost
    FROM dealer_visits v JOIN users u ON u.id=v.salesperson_id
    WHERE v.visit_type='prospect' AND ${where}
    GROUP BY u.id ORDER BY total DESC
  `).all(...params);
  bySp.forEach(s => s.conv_pct = s.total > 0 ? Math.round(s.promoted * 100 / s.total) : 0);

  // For the reassign dropdown — only show salespersons the user can see.
  const salespersons = db.prepare(`
    SELECT id, name FROM users WHERE active=1 AND role IN ('salesperson','admin','owner','area_manager') ORDER BY name
  `).all();

  res.render('visits/prospects', {
    title: 'Prospects', items, stats, conversionRate, bySp, salespersons,
    statusFilter, spFilter,
  });
});

// ─── Reassign a prospect to a different salesperson ─────────────
// Only the salesperson's reporting manager (area_manager) or
// owner/admin can move ownership. A salesperson cannot reassign
// their own prospect (would let them dump bad leads on peers).
router.post('/:id/reassign', (req, res) => {
  const v = db.prepare('SELECT * FROM dealer_visits WHERE id=?').get(req.params.id);
  if (!v || v.visit_type !== 'prospect') return res.redirect('/visits/prospects/list');
  if (!canReassignProspect(req, v)) {
    flash(req,'danger','Only the salesperson\'s manager (or owner/admin) can reassign a prospect.');
    return res.redirect('/visits/prospects/list');
  }
  const newSp = parseInt(req.body.salesperson_id);
  if (!newSp) { flash(req,'danger','Pick a salesperson.'); return res.redirect('/visits/prospects/list'); }
  if (v.promoted_to_dealer_id) { flash(req,'warning','Already promoted — reassign the dealer instead.'); return res.redirect('/visits/prospects/list'); }
  const oldSpName = db.prepare('SELECT name FROM users WHERE id=?').get(v.salesperson_id)?.name || '#'+v.salesperson_id;
  const newSpName = db.prepare('SELECT name FROM users WHERE id=?').get(newSp)?.name || '#'+newSp;
  db.prepare('UPDATE dealer_visits SET salesperson_id=? WHERE id=?').run(newSp, req.params.id);
  req.audit('reassign', 'visit', req.params.id, `${v.visit_no} prospect "${v.prospect_shop || v.prospect_name}" · ${oldSpName} → ${newSpName}`);
  flash(req,'success', `Prospect reassigned to ${newSpName}.`);
  res.redirect('/visits/prospects/list');
});

// ─── Mark a prospect as lost (SP owner, manager, or admin) ──────
router.post('/:id/lost', (req, res) => {
  const v = db.prepare('SELECT * FROM dealer_visits WHERE id=?').get(req.params.id);
  if (!v || v.visit_type !== 'prospect') return res.redirect('/visits/prospects/list');
  if (!canActOnProspect(req, v)) {
    flash(req,'danger','You can only mark your own prospects as lost (or a team member\'s, if you\'re their manager).');
    return res.redirect('/visits/prospects/list');
  }
  if (v.promoted_to_dealer_id) { flash(req,'warning','Already promoted — cannot mark lost.'); return res.redirect('/visits/prospects/list'); }
  const reason = (req.body.lost_reason || '').trim().slice(0, 300) || null;
  db.prepare("UPDATE dealer_visits SET lost_at=datetime('now'), lost_reason=? WHERE id=?").run(reason, req.params.id);
  req.audit('mark_lost', 'visit', req.params.id, `${v.visit_no} prospect "${v.prospect_shop || v.prospect_name}"${reason ? ' · ' + reason : ''}`);
  flash(req,'success','Marked as lost.');
  res.redirect('/visits/prospects/list');
});

// ─── Restore a lost prospect to pending (SP owner, mgr, or admin) ──
router.post('/:id/restore', (req, res) => {
  const v = db.prepare('SELECT * FROM dealer_visits WHERE id=?').get(req.params.id);
  if (!v || v.visit_type !== 'prospect') return res.redirect('/visits/prospects/list');
  if (!canActOnProspect(req, v)) {
    flash(req,'danger','You can only restore your own prospects (or a team member\'s, if you\'re their manager).');
    return res.redirect('/visits/prospects/list');
  }
  db.prepare('UPDATE dealer_visits SET lost_at=NULL, lost_reason=NULL WHERE id=?').run(req.params.id);
  req.audit('restore', 'visit', req.params.id, `${v.visit_no} prospect "${v.prospect_shop || v.prospect_name}" back to pending`);
  flash(req,'success','Restored to pending.');
  res.redirect('/visits/prospects/list');
});

// Permission helpers for prospect actions.
//   canActOnProspect:    promote / mark-lost / restore — the salesperson
//                        who logged the prospect, their reporting manager,
//                        or owner/admin can do it. Salesperson owns the
//                        outcome of their own leads.
//   canReassignProspect: reassign — only the reporting manager (or owner
//                        /admin). A salesperson cannot dump their own
//                        prospect on someone else.
function canActOnProspect(req, prospect) {
  const role = req.session.user.role;
  if (['owner','admin'].includes(role)) return true;
  if (req.session.user.id === prospect.salesperson_id) return true;
  const { isInScope } = require('../middleware/scope');
  if (role === 'area_manager' && isInScope(req, prospect.salesperson_id)) return true;
  return false;
}
function canReassignProspect(req, prospect) {
  const role = req.session.user.role;
  if (['owner','admin'].includes(role)) return true;
  const { isInScope } = require('../middleware/scope');
  if (role === 'area_manager' && isInScope(req, prospect.salesperson_id)) return true;
  return false;
}

// ─── Promote a prospect → real dealer (SP owner, manager, or admin) ─
router.post('/:id/promote', (req, res) => {
  const v = db.prepare('SELECT * FROM dealer_visits WHERE id=?').get(req.params.id);
  if (!v || v.visit_type !== 'prospect') return res.redirect('/visits');
  if (!canActOnProspect(req, v)) {
    flash(req,'danger','You can only promote your own prospects (or a team member\'s, if you\'re their manager).');
    return res.redirect('/visits/' + req.params.id);
  }
  if (v.promoted_to_dealer_id) {
    flash(req,'warning','Already promoted.');
    return res.redirect('/visits/' + v.id);
  }
  // Don't create a duplicate dealer if this prospect's phone already exists.
  const dupErr = require('../utils/dealerDedup').duplicateDealerError(v.prospect_phone, null, null);
  if (dupErr) { flash(req, 'danger', dupErr); return res.redirect('/visits/' + v.id); }
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
