const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { requireFeature, requireWrite } = require('../middleware/permissions');
const { nextCode } = require('../utils/codegen');
const router = express.Router();

// Employee KYC / photo uploads land here. Per-month subdirs so a folder
// listing doesn't explode after a year of churn.
const EMP_UPLOAD_ROOT = path.join(__dirname, '..', '..', 'public', 'uploads', 'employees');
function empMonthDir() {
  const m = new Date().toISOString().slice(0, 7);
  const d = path.join(EMP_UPLOAD_ROOT, m);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}
const empUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, empMonthDir()),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg';
      const rnd = require('crypto').randomBytes(4).toString('hex');
      cb(null, (req.params.id || 'e') + '_' + (file.fieldname || 'doc') + '_' + Date.now() + '_' + rnd + ext);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },                // 10 MB / file
  fileFilter: (req, file, cb) => cb(null, /^(image\/|application\/pdf$)/i.test(file.mimetype)),
});
function relUploadPath(absPath) {
  return '/uploads/employees/' + path.relative(EMP_UPLOAD_ROOT, absPath).replace(/\\/g, '/');
}

// Sensitive sub-sections inside HR — payroll & advances handle real money.
// The mount-level guard already enforces feature `hr` (umbrella). These layer
// extra checks so the owner can revoke just payroll from someone who still
// needs to mark attendance.
router.use('/payroll',    requireFeature('hr_payroll'),    requireWrite('hr_payroll'));
router.use('/advances',   requireFeature('hr_payroll'),    requireWrite('hr_payroll'));
router.use('/incentives', requireFeature('hr_payroll'),    requireWrite('hr_payroll'));
router.use('/employees',  requireFeature('hr_employees'),  requireWrite('hr_employees'));

// ─── Dashboard ────────────────────────────────────────────────
router.get('/', (req, res) => {
  const empCount = db.prepare("SELECT COUNT(*) AS n FROM employees WHERE active=1").get().n;
  const today = new Date().toISOString().slice(0,10);
  const presentToday = db.prepare("SELECT COUNT(*) AS n FROM employee_attendance WHERE attendance_date=? AND status='present'").get(today).n;
  const period = today.slice(0,7);
  const advancesOpen = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(balance),0) AS bal FROM employee_advances WHERE status!='cleared'").get();
  const monthSalary = db.prepare("SELECT COALESCE(SUM(net_paid),0) AS v FROM salary_payments WHERE period=? AND status='paid'").get(period).v;
  const monthPieceTotal = db.prepare("SELECT COALESCE(SUM(total_amount),0) AS v FROM employee_pieces WHERE strftime('%Y-%m', work_date)=?").get(period).v;
  const monthKm = db.prepare("SELECT COALESCE(SUM(amount),0) AS v FROM employee_km_log WHERE strftime('%Y-%m', log_date)=?").get(period).v;
  res.render('hr/dashboard', { title: 'HR Dashboard', empCount, presentToday, advancesOpen, monthSalary, monthPieceTotal, monthKm, period, today });
});

// ─── Employees ────────────────────────────────────────────────
router.get('/employees', (req, res) => {
  const filter = req.query.filter || 'active';
  let sql = `SELECT e.*, u.name AS user_name FROM employees e LEFT JOIN users u ON u.id=e.user_id`;
  if (filter === 'active') sql += ' WHERE e.active=1';
  else if (filter === 'inactive') sql += ' WHERE e.active=0';
  sql += ' ORDER BY e.name';
  const items = db.prepare(sql).all();
  res.render('hr/employees/index', { title: 'Employees', items, filter });
});

router.get('/employees/new', (req, res) => {
  const users = db.prepare("SELECT id, name, email FROM users WHERE active=1 ORDER BY name").all();
  res.render('hr/employees/form', { title: 'New Employee', e: null, users });
});

router.post('/employees', (req, res) => {
  const code = req.body.code || nextCode('employees', 'code', 'EMP');
  const f = req.body;
  db.prepare(`INSERT INTO employees (code,name,phone,email,address,employee_type,department,designation,base_salary,per_piece_rate,km_rate,joining_date,bank_name,account_no,ifsc,pan,user_id,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(code, f.name, f.phone||null, f.email||null, f.address||null, f.employee_type||'salary', f.department||null, f.designation||null,
         parseFloat(f.base_salary||0), parseFloat(f.per_piece_rate||0), parseFloat(f.km_rate||0),
         f.joining_date||null, f.bank_name||null, f.account_no||null, f.ifsc||null, f.pan||null,
         f.user_id ? parseInt(f.user_id) : null, f.notes||null);
  req.audit('create', 'employee', null, `${code} ${f.name}`);
  flash(req, 'success', 'Employee added.');
  res.redirect('/hr/employees');
});

router.get('/employees/:id', (req, res) => {
  const e = db.prepare('SELECT e.*, u.name AS user_name, u.email AS user_email FROM employees e LEFT JOIN users u ON u.id=e.user_id WHERE e.id=?').get(req.params.id);
  if (!e) return res.redirect('/hr/employees');
  const period = new Date().toISOString().slice(0,7);
  const attendance = db.prepare(`SELECT status, COUNT(*) AS n FROM employee_attendance WHERE employee_id=? AND strftime('%Y-%m', attendance_date)=? GROUP BY status`).all(e.id, period);
  const advances = db.prepare('SELECT * FROM employee_advances WHERE employee_id=? ORDER BY id DESC LIMIT 10').all(e.id);
  const advanceBalance = db.prepare("SELECT COALESCE(SUM(balance),0) AS v FROM employee_advances WHERE employee_id=? AND status!='cleared'").get(e.id).v;
  const recentPieces = db.prepare(`SELECT * FROM employee_pieces WHERE employee_id=? ORDER BY work_date DESC, id DESC LIMIT 10`).all(e.id);
  const recentKm = db.prepare(`SELECT k.*, d.name AS dealer_name FROM employee_km_log k LEFT JOIN dealers d ON d.id=k.dealer_id WHERE k.employee_id=? ORDER BY k.log_date DESC, k.id DESC LIMIT 10`).all(e.id);
  const recentSalary = db.prepare('SELECT * FROM salary_payments WHERE employee_id=? ORDER BY period DESC LIMIT 12').all(e.id);
  res.render('hr/employees/show', { title: e.name, e, attendance, advances, advanceBalance, recentPieces, recentKm, recentSalary, period });
});

router.get('/employees/:id/edit', (req, res) => {
  const e = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id);
  if (!e) return res.redirect('/hr/employees');
  const users = db.prepare("SELECT id, name, email FROM users WHERE active=1 ORDER BY name").all();
  res.render('hr/employees/form', { title: 'Edit ' + e.name, e, users });
});

router.post('/employees/:id', (req, res) => {
  const e = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id);
  if (!e) return res.redirect('/hr/employees');
  const f = req.body;
  db.prepare(`UPDATE employees SET name=?,phone=?,email=?,address=?,employee_type=?,department=?,designation=?,base_salary=?,per_piece_rate=?,km_rate=?,joining_date=?,exit_date=?,bank_name=?,account_no=?,ifsc=?,pan=?,user_id=?,active=?,notes=?,updated_at=datetime('now') WHERE id=?`)
    .run(f.name, f.phone||null, f.email||null, f.address||null, f.employee_type||'salary', f.department||null, f.designation||null,
         parseFloat(f.base_salary||0), parseFloat(f.per_piece_rate||0), parseFloat(f.km_rate||0),
         f.joining_date||null, f.exit_date||null, f.bank_name||null, f.account_no||null, f.ifsc||null, f.pan||null,
         f.user_id ? parseInt(f.user_id) : null, f.active?1:0, f.notes||null, e.id);
  req.audit('update', 'employee', e.id, `${e.code} ${f.name}`);
  flash(req, 'success', 'Updated.');
  res.redirect('/hr/employees/' + e.id);
});

// ─── Live photo capture (selfie via device camera) ───────────────
// Form posts a single image file from <input type=file capture=user>.
// Replaces any previous photo (we keep the file around just in case;
// only the DB pointer is overwritten).
router.post('/employees/:id/photo', empUpload.single('photo'), (req, res) => {
  const e = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id);
  if (!e) { if (req.file) try { fs.unlinkSync(req.file.path); } catch (_) {} return res.redirect('/hr/employees'); }
  if (!req.file) { flash(req,'danger','No photo received. Allow camera access and try again.'); return res.redirect('/hr/employees/' + e.id); }
  const rel = relUploadPath(req.file.path);
  db.prepare("UPDATE employees SET photo_path=?, updated_at=datetime('now') WHERE id=?").run(rel, e.id);
  req.audit('upload_photo', 'employee', e.id, `${e.code} ${e.name} · live photo updated`);
  flash(req,'success','Photo updated.');
  res.redirect('/hr/employees/' + e.id);
});

// ─── KYC documents upload (Aadhaar / PAN / DL) ───────────────────
// Multi-file form: any subset of {aadhaar_doc, pan_doc, dl_doc} can be
// provided. Numbers (aadhaar_no, dl_no) are optional text fields. PDF
// or image accepted.
router.post('/employees/:id/kyc',
  empUpload.fields([
    { name: 'aadhaar_doc', maxCount: 1 },
    { name: 'pan_doc',     maxCount: 1 },
    { name: 'dl_doc',      maxCount: 1 },
  ]),
  (req, res) => {
    const e = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id);
    if (!e) return res.redirect('/hr/employees');
    const f = req.body;
    const changes = [];
    const sets = [];
    const params = [];
    if (f.aadhaar_no !== undefined && f.aadhaar_no !== e.aadhaar_no) {
      sets.push('aadhaar_no=?'); params.push(f.aadhaar_no || null);
      changes.push('aadhaar_no');
    }
    if (f.dl_no !== undefined && f.dl_no !== e.dl_no) {
      sets.push('dl_no=?'); params.push(f.dl_no || null);
      changes.push('dl_no');
    }
    // PAN number lives in the existing `pan` column — keep editable here too.
    if (f.pan !== undefined && f.pan !== e.pan) {
      sets.push('pan=?'); params.push(f.pan || null);
      changes.push('pan');
    }
    const files = req.files || {};
    if (files.aadhaar_doc && files.aadhaar_doc[0]) { sets.push('aadhaar_doc_path=?'); params.push(relUploadPath(files.aadhaar_doc[0].path)); changes.push('aadhaar_doc'); }
    if (files.pan_doc     && files.pan_doc[0])     { sets.push('pan_doc_path=?');     params.push(relUploadPath(files.pan_doc[0].path));     changes.push('pan_doc'); }
    if (files.dl_doc      && files.dl_doc[0])      { sets.push('dl_doc_path=?');      params.push(relUploadPath(files.dl_doc[0].path));      changes.push('dl_doc'); }
    if (sets.length === 0) { flash(req,'info','Nothing to save.'); return res.redirect('/hr/employees/' + e.id); }
    sets.push("updated_at=datetime('now')");
    params.push(e.id);
    db.prepare(`UPDATE employees SET ${sets.join(',')} WHERE id=?`).run(...params);
    req.audit('update_kyc', 'employee', e.id, `${e.code} ${e.name} · ${changes.join(', ')}`);
    flash(req,'success','KYC updated.');
    res.redirect('/hr/employees/' + e.id);
  }
);

// ─── Police verification (status + optional doc + date + notes) ───
router.post('/employees/:id/police-verif',
  empUpload.single('police_verif_doc'),
  (req, res) => {
    const e = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id);
    if (!e) return res.redirect('/hr/employees');
    const allowed = new Set(['not_done','pending','verified','not_required']);
    const status = allowed.has(req.body.police_verif_status) ? req.body.police_verif_status : 'pending';
    const sets = ['police_verif_status=?', 'police_verif_date=?', 'police_verif_notes=?'];
    const params = [status, req.body.police_verif_date || null, req.body.police_verif_notes || null];
    if (req.file) { sets.push('police_verif_doc_path=?'); params.push(relUploadPath(req.file.path)); }
    sets.push("updated_at=datetime('now')");
    params.push(e.id);
    db.prepare(`UPDATE employees SET ${sets.join(',')} WHERE id=?`).run(...params);
    req.audit('police_verif', 'employee', e.id, `${e.code} ${e.name} · ${status}${req.file ? ' · doc uploaded' : ''}`);
    flash(req,'success','Police verification updated.');
    res.redirect('/hr/employees/' + e.id);
  }
);

// ─── Attendance ────────────────────────────────────────────────
router.get('/attendance', (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0,10);
  const employees = db.prepare(`
    SELECT e.id, e.code, e.name, e.department, e.employee_type, a.id AS att_id, a.status, a.check_in, a.check_out, a.notes
    FROM employees e LEFT JOIN employee_attendance a ON a.employee_id=e.id AND a.attendance_date=?
    WHERE e.active=1 ORDER BY e.department, e.name
  `).all(date);
  const summary = { present:0, absent:0, half_day:0, leave:0, holiday:0, unmarked:0 };
  employees.forEach(e => { if (e.status) summary[e.status]++; else summary.unmarked++; });
  res.render('hr/attendance', { title: 'Attendance', date, employees, summary });
});

router.post('/attendance', (req, res) => {
  const { attendance_date } = req.body;
  const ids = [].concat(req.body.employee_id || []);
  const statuses = [].concat(req.body.status || []);
  const upsert = db.prepare(`INSERT INTO employee_attendance (employee_id, attendance_date, status, created_by) VALUES (?,?,?,?) ON CONFLICT(employee_id, attendance_date) DO UPDATE SET status=excluded.status`);
  const trx = db.transaction(() => {
    for (let i = 0; i < ids.length; i++) {
      const eid = parseInt(ids[i]); const st = statuses[i];
      if (!eid || !st) continue;
      upsert.run(eid, attendance_date, st, req.session.user.id);
    }
  });
  trx();
  req.audit('mark', 'attendance', null, `${ids.length} employees on ${attendance_date}`);
  flash(req, 'success', 'Attendance saved.');
  res.redirect('/hr/attendance?date=' + attendance_date);
});

// ─── Biometric sync (eTimeOffice cloud) ──────────────────────
// The office biometric pushes punches to etimeoffice.com; these routes
// pull the day-wise summary back and upsert employee_attendance.
router.get('/attendance/biometric', (req, res) => {
  const eto = require('../utils/etimeoffice');
  const creds = eto.getCredentials();
  const isOwner = ['owner','admin'].includes(req.session.user.role);
  // Employees + their mapping codes, to show what'll match.
  const employees = db.prepare("SELECT id, code, name, biometric_code, active FROM employees WHERE active=1 ORDER BY name").all();
  const today = require('../utils/format').todayLocal();
  const monthStart = today.slice(0,7) + '-01';
  res.render('hr/biometric', {
    title: 'Biometric Sync',
    configured: eto.configured(),
    corpId: creds.corpId, etoUsername: creds.username, hasPassword: !!creds.password,
    isOwner, employees, from: monthStart, to: today,
  });
});

router.post('/attendance/biometric/settings', (req, res) => {
  if (!['owner','admin'].includes(req.session.user.role)) {
    flash(req,'danger','Only owner/admin can change biometric credentials.');
    return res.redirect('/hr/attendance/biometric');
  }
  const eto = require('../utils/etimeoffice');
  const { corp_id, username, password } = req.body;
  if (!corp_id || !username) { flash(req,'danger','Corporate ID and username are required.'); return res.redirect('/hr/attendance/biometric'); }
  eto.saveSetting('ETO_CORP_ID', corp_id.trim(), req.session.user.id);
  eto.saveSetting('ETO_USERNAME', username.trim(), req.session.user.id);
  // Blank password field = keep the existing one (so editing the corp id
  // doesn't force a password re-entry).
  if (password && password.trim()) eto.saveSetting('ETO_PASSWORD', password.trim(), req.session.user.id);
  req.audit('update', 'biometric_settings', null, `eTimeOffice corp ${corp_id.trim()} / ${username.trim()}`);
  flash(req,'success','Credentials saved. Run a sync to test them.');
  res.redirect('/hr/attendance/biometric');
});

router.post('/attendance/biometric/sync', async (req, res) => {
  const eto = require('../utils/etimeoffice');
  const from = req.body.from;
  const to   = req.body.to;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
    flash(req,'danger','Pick valid From and To dates.');
    return res.redirect('/hr/attendance/biometric');
  }
  const result = await eto.fetchInOutPunchData(from, to);
  if (!result.ok) {
    flash(req,'danger', result.error);
    return res.redirect('/hr/attendance/biometric');
  }

  // Build the Empcode → employee map: biometric_code first, employees.code
  // as fallback. Case-insensitive, trimmed.
  const employees = db.prepare('SELECT id, code, biometric_code FROM employees WHERE active=1').all();
  const byCode = new Map();
  employees.forEach(e => {
    if (e.biometric_code) byCode.set(String(e.biometric_code).trim().toUpperCase(), e.id);
  });
  employees.forEach(e => {
    const k = String(e.code).trim().toUpperCase();
    if (!byCode.has(k)) byCode.set(k, e.id);
  });

  const upsert = db.prepare(`
    INSERT INTO employee_attendance (employee_id, attendance_date, status, check_in, check_out, notes, created_by)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(employee_id, attendance_date) DO UPDATE SET
      status=excluded.status, check_in=excluded.check_in, check_out=excluded.check_out, notes=excluded.notes
  `);

  let synced = 0, skippedNoMatch = 0, skippedNoStatus = 0;
  const unmatched = new Set();
  const trx = db.transaction(() => {
    for (const r of result.rows) {
      const empId = byCode.get(String(r.Empcode || '').trim().toUpperCase());
      if (!empId) { skippedNoMatch++; if (r.Empcode) unmatched.add(`${r.Empcode} (${r.Name || '?'})`); continue; }
      const date = eto.fromApiDate(r.DateString);
      if (!date) { skippedNoStatus++; continue; }
      const inT  = (r.INTime  && /^\d{2}:\d{2}/.test(r.INTime))  ? r.INTime.slice(0,5)  : null;
      const outT = (r.OUTTime && /^\d{2}:\d{2}/.test(r.OUTTime)) ? r.OUTTime.slice(0,5) : null;
      const status = eto.mapStatus(r.Status, inT);
      if (!status) { skippedNoStatus++; continue; }
      upsert.run(empId, date, status, inT, outT, '[biometric]', req.session.user.id);
      synced++;
    }
  });
  trx();

  req.audit('biometric_sync', 'attendance', null, `${from} → ${to} · ${synced} day-records synced, ${skippedNoMatch} unmatched, ${skippedNoStatus} no-status`);
  let msg = `Synced ${synced} attendance record${synced===1?'':'s'} from eTimeOffice (${from} → ${to}).`;
  if (skippedNoMatch) msg += ` ${skippedNoMatch} skipped — Empcodes with no matching employee: ${[...unmatched].slice(0,8).join(', ')}${unmatched.size>8?' …':''}. Set the Biometric Code on those employees and sync again.`;
  if (skippedNoStatus) msg += ` ${skippedNoStatus} rows had no usable status/date and were skipped.`;
  flash(req, skippedNoMatch ? 'warning' : 'success', msg);
  res.redirect('/hr/attendance/biometric');
});

// Per-employee biometric code (inline save from the mapping table)
router.post('/employees/:id/biometric-code', (req, res) => {
  const e = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id);
  if (!e) return res.redirect('/hr/attendance/biometric');
  const code = (req.body.biometric_code || '').trim() || null;
  db.prepare("UPDATE employees SET biometric_code=?, updated_at=datetime('now') WHERE id=?").run(code, e.id);
  req.audit('update', 'employee', e.id, `${e.code} biometric_code → ${code || '—'}`);
  flash(req,'success', `${e.name}: biometric code ${code ? 'set to ' + code : 'cleared'}.`);
  res.redirect('/hr/attendance/biometric');
});

// ─── Work Types (master for piece-rate operations) ───────────
router.get('/work-types', (req, res) => {
  const items = db.prepare('SELECT * FROM work_types ORDER BY active DESC, name').all();
  res.render('hr/work-types', { title: 'Work Types', items });
});

router.post('/work-types', (req, res) => {
  const { name, default_rate, description } = req.body;
  if (!name) { flash(req,'danger','Name required'); return res.redirect('/hr/work-types'); }
  try {
    db.prepare('INSERT INTO work_types (name, default_rate, description) VALUES (?,?,?)').run(name.trim(), parseFloat(default_rate||0), description||null);
    flash(req,'success','Added.');
  } catch (e) { flash(req,'danger', e.message); }
  res.redirect('/hr/work-types');
});

router.post('/work-types/:id', (req, res) => {
  const { name, default_rate, description } = req.body;
  if (!name || !name.trim()) { flash(req,'danger','Name required'); return res.redirect('/hr/work-types'); }
  try {
    db.prepare('UPDATE work_types SET name=?, default_rate=?, description=? WHERE id=?').run(name.trim(), parseFloat(default_rate||0), description||null, req.params.id);
    flash(req,'success','Updated.');
  } catch (e) { flash(req,'danger', e.message); }
  res.redirect('/hr/work-types');
});

router.post('/work-types/:id/toggle', (req, res) => {
  db.prepare('UPDATE work_types SET active = 1 - active WHERE id=?').run(req.params.id);
  res.redirect('/hr/work-types');
});

// ─── Pieces (per-piece work log) ──────────────────────────────
router.get('/pieces', (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0,7);
  const items = db.prepare(`
    SELECT pc.*, e.code, e.name AS emp_name, p.name AS product_name, b.batch_no, w.name AS work_name
    FROM employee_pieces pc JOIN employees e ON e.id=pc.employee_id
    LEFT JOIN products p ON p.id=pc.product_id
    LEFT JOIN production_batches b ON b.id=pc.batch_id
    LEFT JOIN work_types w ON w.id=pc.work_type_id
    WHERE strftime('%Y-%m', pc.work_date)=? ORDER BY pc.work_date DESC, pc.id DESC
  `).all(month);
  const total = items.reduce((s, i) => s + i.total_amount, 0);
  // Contract workers first (their bread and butter), then salaried —
  // a salary employee CAN log piece work, it just adds on top of base.
  const employees = db.prepare("SELECT id, code, name, per_piece_rate, employee_type FROM employees WHERE active=1 ORDER BY CASE employee_type WHEN 'contract' THEN 0 ELSE 1 END, name").all();
  const products = db.prepare('SELECT id, code, name FROM products WHERE active=1 ORDER BY name').all();
  const workTypes = db.prepare('SELECT id, name, default_rate FROM work_types WHERE active=1 ORDER BY name').all();
  res.render('hr/pieces', { title: 'Per-Piece Work Log', items, total, month, employees, products, workTypes });
});

// Helper: does this employee have a salary slip covering the month of
// the given date? Returns { exists, paid, period } — used to protect
// already-paid history from edits underneath it, and to nudge the user
// to recalculate drafts.
function slipForMonth(employeeId, dateStr) {
  const period = String(dateStr || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(period)) return { exists: false, paid: false, period };
  const slip = db.prepare('SELECT id, status FROM salary_payments WHERE employee_id=? AND period=?').get(employeeId, period);
  return { exists: !!slip, paid: !!slip && slip.status === 'paid', period, id: slip ? slip.id : null };
}

router.post('/pieces', (req, res) => {
  const f = req.body;
  const qty = parseInt(f.qty_pieces);
  const rate = parseFloat(f.rate_per_piece);
  if (!f.employee_id || !qty || !rate) { flash(req,'danger','Employee, qty, and rate required'); return res.redirect('/hr/pieces'); }
  if (qty <= 0 || !isFinite(rate) || rate <= 0) { flash(req,'danger','Qty and rate must be positive numbers.'); return res.redirect('/hr/pieces'); }
  if (!f.work_date || !/^\d{4}-\d{2}-\d{2}$/.test(f.work_date)) { flash(req,'danger','Pick a valid work date.'); return res.redirect('/hr/pieces'); }
  const total = qty * rate;
  const slip = slipForMonth(parseInt(f.employee_id), f.work_date);
  db.prepare(`INSERT INTO employee_pieces (employee_id, work_date, qty_pieces, rate_per_piece, total_amount, product_id, batch_id, work_type_id, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(parseInt(f.employee_id), f.work_date, qty, rate, total, f.product_id||null, f.batch_id||null, f.work_type_id||null, f.notes||null, req.session.user.id);
  req.audit('add', 'piece_work', null, `emp #${f.employee_id} · ${qty} pcs × ₹${rate} = ₹${total.toFixed(2)} (${f.work_date})`);
  if (slip.paid) {
    flash(req, 'warning', `Logged ${qty} pcs · ₹${total.toFixed(2)} — but the ${slip.period} slip is already PAID, so this will NOT be paid automatically. Handle it in the next period or as a manual payment.`);
  } else if (slip.exists) {
    flash(req, 'warning', `Logged ${qty} pcs · ₹${total.toFixed(2)}. A draft slip for ${slip.period} already exists — open it and click Recalculate to include this.`);
  } else {
    flash(req, 'success', `Logged ${qty} pcs · ₹${total.toFixed(2)}.`);
  }
  res.redirect('/hr/pieces?month=' + (f.work_date||'').slice(0,7));
});

router.post('/pieces/:id/delete', (req, res) => {
  const p = db.prepare('SELECT * FROM employee_pieces WHERE id=?').get(req.params.id);
  if (!p) return res.redirect('/hr/pieces');
  const slip = slipForMonth(p.employee_id, p.work_date);
  if (slip.paid) {
    flash(req,'danger',`Cannot delete — the ${slip.period} salary slip is already PAID and includes this work. Paid history is immutable.`);
    return res.redirect('/hr/pieces?month=' + p.work_date.slice(0,7));
  }
  db.prepare('DELETE FROM employee_pieces WHERE id=?').run(p.id);
  req.audit('delete', 'piece_work', p.id, `emp #${p.employee_id} · ${p.qty_pieces} pcs ₹${p.total_amount} (${p.work_date})`);
  flash(req, slip.exists ? 'warning' : 'success',
    slip.exists ? `Deleted. The draft slip for ${slip.period} still counts it — open the slip and click Recalculate.` : 'Deleted.');
  res.redirect('/hr/pieces?month=' + p.work_date.slice(0,7));
});

// ─── KM Log (Sales team mileage) ──────────────────────────────
router.get('/km', (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0,7);
  const items = db.prepare(`
    SELECT k.*, e.code, e.name AS emp_name, d.name AS dealer_name
    FROM employee_km_log k JOIN employees e ON e.id=k.employee_id
    LEFT JOIN dealers d ON d.id=k.dealer_id
    WHERE strftime('%Y-%m', k.log_date)=? ORDER BY k.log_date DESC, k.id DESC
  `).all(month);
  const total = items.reduce((s, i) => s + i.amount, 0);
  const totalKm = items.reduce((s, i) => s + i.km, 0);
  const employees = db.prepare("SELECT id, code, name, km_rate FROM employees WHERE active=1 AND LOWER(COALESCE(department,'')) IN ('sales','field') ORDER BY name").all();
  const allEmployees = db.prepare("SELECT id, code, name, km_rate FROM employees WHERE active=1 ORDER BY name").all();
  const dealers = db.prepare('SELECT id, code, name FROM dealers WHERE active=1 ORDER BY name').all();
  res.render('hr/km', { title: 'Mileage Log', items, total, totalKm, month, employees: employees.length ? employees : allEmployees, dealers });
});

router.post('/km', (req, res) => {
  const f = req.body;
  const km = parseFloat(f.km);
  const rate = parseFloat(f.rate_per_km);
  if (!f.employee_id || !km || !rate) { flash(req,'danger','Employee, km, and rate required'); return res.redirect('/hr/km'); }
  if (!isFinite(km) || km <= 0 || !isFinite(rate) || rate <= 0) { flash(req,'danger','KM and rate must be positive numbers.'); return res.redirect('/hr/km'); }
  if (!f.log_date || !/^\d{4}-\d{2}-\d{2}$/.test(f.log_date)) { flash(req,'danger','Pick a valid date.'); return res.redirect('/hr/km'); }
  const amount = km * rate;
  const slip = slipForMonth(parseInt(f.employee_id), f.log_date);
  db.prepare(`INSERT INTO employee_km_log (employee_id, log_date, km, rate_per_km, amount, dealer_id, notes, created_by) VALUES (?,?,?,?,?,?,?,?)`)
    .run(parseInt(f.employee_id), f.log_date, km, rate, amount, f.dealer_id||null, f.notes||null, req.session.user.id);
  req.audit('add', 'km_log', null, `emp #${f.employee_id} · ${km} km × ₹${rate} = ₹${amount.toFixed(2)} (${f.log_date})`);
  if (slip.paid) {
    flash(req, 'warning', `Logged ${km} km · ₹${amount.toFixed(2)} — but the ${slip.period} slip is already PAID; this will NOT be paid automatically.`);
  } else if (slip.exists) {
    flash(req, 'warning', `Logged ${km} km · ₹${amount.toFixed(2)}. A draft slip for ${slip.period} exists — open it and click Recalculate.`);
  } else {
    flash(req, 'success', `Logged ${km} km · ₹${amount.toFixed(2)}.`);
  }
  res.redirect('/hr/km?month=' + (f.log_date||'').slice(0,7));
});

router.post('/km/:id/delete', (req, res) => {
  const k = db.prepare('SELECT * FROM employee_km_log WHERE id=?').get(req.params.id);
  if (!k) return res.redirect('/hr/km');
  const slip = slipForMonth(k.employee_id, k.log_date);
  if (slip.paid) {
    flash(req,'danger',`Cannot delete — the ${slip.period} salary slip is already PAID and includes this reimbursement.`);
    return res.redirect('/hr/km?month=' + k.log_date.slice(0,7));
  }
  db.prepare('DELETE FROM employee_km_log WHERE id=?').run(k.id);
  req.audit('delete', 'km_log', k.id, `emp #${k.employee_id} · ${k.km} km ₹${k.amount} (${k.log_date})`);
  flash(req, slip.exists ? 'warning' : 'success',
    slip.exists ? `Deleted. The draft slip for ${slip.period} still counts it — Recalculate that slip.` : 'Deleted.');
  res.redirect('/hr/km?month=' + k.log_date.slice(0,7));
});

// ─── Advances ──────────────────────────────────────────────────
router.get('/advances', (req, res) => {
  const items = db.prepare(`
    SELECT a.*, e.code, e.name AS emp_name FROM employee_advances a
    JOIN employees e ON e.id=a.employee_id ORDER BY a.id DESC LIMIT 200
  `).all();
  const employees = db.prepare("SELECT id, code, name FROM employees WHERE active=1 ORDER BY name").all();
  const totalOpen = db.prepare("SELECT COALESCE(SUM(balance),0) AS v FROM employee_advances WHERE status!='cleared'").get().v;
  res.render('hr/advances', { title: 'Employee Advances', items, employees, totalOpen });
});

router.post('/advances', (req, res) => {
  const f = req.body;
  const amount = parseFloat(f.amount);
  if (!f.employee_id || !amount) { flash(req,'danger','Employee and amount required'); return res.redirect('/hr/advances'); }
  if (!isFinite(amount) || amount <= 0) { flash(req,'danger','Advance amount must be a positive number.'); return res.redirect('/hr/advances'); }
  if (!f.advance_date || !/^\d{4}-\d{2}-\d{2}$/.test(f.advance_date)) { flash(req,'danger','Pick a valid date.'); return res.redirect('/hr/advances'); }
  const r = db.prepare(`INSERT INTO employee_advances (employee_id, advance_date, amount, balance, status, notes, created_by) VALUES (?,?,?,?,'pending',?,?)`)
    .run(parseInt(f.employee_id), f.advance_date, amount, amount, f.notes||null, req.session.user.id);
  req.audit('add', 'advance', r.lastInsertRowid, `emp #${f.employee_id} · ₹${amount.toFixed(2)} (${f.advance_date})`);
  flash(req, 'success', `Advance ₹${amount.toFixed(2)} recorded.`);
  res.redirect('/hr/advances');
});

router.post('/advances/:id/repay', (req, res) => {
  const adv = db.prepare('SELECT * FROM employee_advances WHERE id=?').get(req.params.id);
  if (!adv) return res.redirect('/hr/advances');
  const amt = parseFloat(req.body.amount);
  if (!amt || !isFinite(amt) || amt <= 0) { flash(req,'danger','Invalid amount'); return res.redirect('/hr/advances'); }
  // Cap the recorded repayment at the open balance — recording ₹5,000
  // against a ₹2,000 balance used to log a ₹5,000 repayment row while
  // only clearing ₹2,000, which made the repayment history overstate
  // what was actually recovered.
  const apply = Math.min(amt, adv.balance);
  if (apply <= 0) { flash(req,'warning','This advance is already cleared.'); return res.redirect('/hr/advances'); }
  const newBal = adv.balance - apply;
  const status = newBal <= 0.01 ? 'cleared' : 'partial';
  const trx = db.transaction(() => {
    db.prepare(`INSERT INTO employee_advance_repayments (advance_id, repay_date, amount, notes) VALUES (?, ?, ?, ?)`)
      .run(adv.id, require('../utils/format').todayLocal(), apply, req.body.notes||null);
    db.prepare('UPDATE employee_advances SET balance=?, status=? WHERE id=?').run(newBal, status, adv.id);
  });
  trx();
  req.audit('repay', 'advance', adv.id, `emp #${adv.employee_id} · ₹${apply.toFixed(2)} repaid, balance ₹${newBal.toFixed(2)}`);
  flash(req, 'success', `Repayment ₹${apply.toFixed(2)} recorded${apply < amt ? ' (capped at the open balance)' : ''}.`);
  res.redirect('/hr/advances');
});

// ─── Incentives ────────────────────────────────────────────────
router.get('/incentives', (req, res) => {
  const period = req.query.period || new Date().toISOString().slice(0,7);
  const items = db.prepare(`
    SELECT i.*, e.code, e.name AS emp_name FROM employee_incentives i
    JOIN employees e ON e.id=i.employee_id WHERE i.period=? ORDER BY i.id DESC
  `).all(period);
  const total = items.reduce((s, i) => s + i.amount, 0);
  const employees = db.prepare("SELECT id, code, name FROM employees WHERE active=1 ORDER BY name").all();
  res.render('hr/incentives', { title: 'Incentives', items, total, period, employees });
});

router.post('/incentives', (req, res) => {
  const f = req.body;
  const amount = parseFloat(f.amount);
  if (!f.employee_id || !amount) { flash(req,'danger','Employee and amount required'); return res.redirect('/hr/incentives'); }
  // Negative amounts ARE allowed — a penalty/deduction entry. Just block
  // zero and non-numeric.
  if (!isFinite(amount) || amount === 0) { flash(req,'danger','Amount must be a non-zero number.'); return res.redirect('/hr/incentives'); }
  if (!/^\d{4}-\d{2}$/.test(f.period || '')) { flash(req,'danger','Pick a valid period.'); return res.redirect('/hr/incentives'); }
  // If the period's slip is already generated/paid, tell the user how
  // this incentive will (or won't) reach the employee.
  const slip = db.prepare('SELECT id, status FROM salary_payments WHERE employee_id=? AND period=?').get(parseInt(f.employee_id), f.period);
  const r = db.prepare(`INSERT INTO employee_incentives (employee_id, period, reason, amount, created_by) VALUES (?,?,?,?,?)`)
    .run(parseInt(f.employee_id), f.period, f.reason||null, amount, req.session.user.id);
  req.audit('add', 'incentive', r.lastInsertRowid, `emp #${f.employee_id} · ₹${amount.toFixed(2)} (${f.period})${f.reason ? ' · ' + f.reason : ''}`);
  if (slip && slip.status === 'paid') {
    flash(req, 'warning', `Incentive ₹${amount.toFixed(2)} added — but the ${f.period} slip is already PAID. It will stay pending; pay it manually or via the next period.`);
  } else if (slip) {
    flash(req, 'warning', `Incentive ₹${amount.toFixed(2)} added. A draft slip for ${f.period} exists — open it and click Recalculate to include this.`);
  } else {
    flash(req, 'success', `Incentive ₹${amount.toFixed(2)} added.`);
  }
  res.redirect('/hr/incentives?period=' + f.period);
});

router.post('/incentives/:id/delete', (req, res) => {
  const i = db.prepare('SELECT * FROM employee_incentives WHERE id=?').get(req.params.id);
  if (!i) return res.redirect('/hr/incentives');
  // Incentives link to a slip at GENERATION now. Linked to a PAID slip →
  // immutable history, block. Linked to a DRAFT → allow delete but tell
  // the user to hit Recalculate on that slip so the amount drops out.
  if (i.applied_to_salary_id) {
    const slip = db.prepare('SELECT id, status, period FROM salary_payments WHERE id=?').get(i.applied_to_salary_id);
    if (slip && slip.status === 'paid') {
      flash(req,'danger','This incentive was paid out in a salary slip — cannot delete (history).');
      return res.redirect('/hr/incentives');
    }
    db.prepare('DELETE FROM employee_incentives WHERE id=?').run(i.id);
    req.audit('delete', 'incentive', i.id, `₹${i.amount} (${i.period}) — was in draft slip #${i.applied_to_salary_id}`);
    flash(req, 'warning', `Deleted. It was included in a DRAFT slip for ${slip ? slip.period : i.period} — open that slip and click Recalculate to update the total.`);
    return res.redirect('/hr/incentives');
  }
  db.prepare('DELETE FROM employee_incentives WHERE id=?').run(i.id);
  req.audit('delete', 'incentive', i.id, `₹${i.amount} (${i.period})`);
  flash(req, 'success', 'Deleted.');
  res.redirect('/hr/incentives');
});

// ─── Payroll ───────────────────────────────────────────────────
router.get('/payroll', (req, res) => {
  const period = req.query.period || new Date().toISOString().slice(0,7);
  const items = db.prepare(`
    SELECT s.*, e.code, e.name AS emp_name, e.employee_type, pm.name AS mode
    FROM salary_payments s JOIN employees e ON e.id=s.employee_id
    LEFT JOIN payment_modes pm ON pm.id=s.payment_mode_id
    WHERE s.period=? ORDER BY e.name
  `).all(period);
  const totals = items.reduce((acc, s) => {
    acc.gross += s.gross; acc.net += s.net_paid; return acc;
  }, { gross: 0, net: 0 });
  const empCount = db.prepare('SELECT COUNT(*) AS n FROM employees WHERE active=1').get().n;
  // Active employees that DON'T have a slip for this period yet —
  // powers the selective-generation picker.
  const pendingEmployees = db.prepare(`
    SELECT e.id, e.code, e.name, e.employee_type, e.department
    FROM employees e
    WHERE e.active=1
      AND NOT EXISTS (SELECT 1 FROM salary_payments s WHERE s.employee_id=e.id AND s.period=?)
    ORDER BY e.name
  `).all(period);
  res.render('hr/payroll/index', { title: 'Payroll', items, totals, period, empCount, pendingEmployees });
});

// Selective payroll generation — the user picks WHICH employees to
// generate slips for (single or multiple). No silent generate-for-all:
// owner wants control over each slip, not a 58-row bulk dump.
router.post('/payroll/generate', (req, res) => {
  const period = req.body.period;
  if (!/^\d{4}-\d{2}$/.test(period)) { flash(req,'danger','Invalid period (YYYY-MM)'); return res.redirect('/hr/payroll'); }
  const ids = [].concat(req.body.employee_ids || []).map(x => parseInt(x)).filter(Boolean);
  if (ids.length === 0) {
    flash(req,'danger','Pick at least one employee to generate a slip for.');
    return res.redirect('/hr/payroll?period=' + period);
  }
  const ph = ids.map(() => '?').join(',');
  const employees = db.prepare(`SELECT * FROM employees WHERE active=1 AND id IN (${ph})`).all(...ids);
  let created = 0, skipped = 0;
  const names = [];
  const trx = db.transaction(() => {
    for (const e of employees) {
      const existing = db.prepare('SELECT id FROM salary_payments WHERE employee_id=? AND period=?').get(e.id, period);
      if (existing) { skipped++; continue; }
      const slip = computeSlip(e, period);
      const r = db.prepare(`INSERT INTO salary_payments (employee_id, period, base_amount, days_present, days_absent, piece_amount, incentive_amount, km_amount, advance_deducted, gross, net_paid, notes, created_by, month_days, paid_days, half_day_count, leave_count, holiday_count, unmarked_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(e.id, period, slip.base, slip.daysPresent, slip.daysAbsent, slip.piece, slip.incentive, slip.km, slip.advance, slip.gross, slip.net, slip.notes, req.session.user.id,
             slip.monthDays, slip.paidDays, slip.halfDay, slip.leave, slip.holiday, slip.unmarked);
      // Link the incentives that were just summed into incentive_amount.
      // Linking at generation (not at pay) means an incentive created
      // AFTER this point stays unlinked — visible as "pending" on the
      // incentives page and pulled in by Recalculate — instead of being
      // silently marked applied at pay time without ever being paid.
      db.prepare(`UPDATE employee_incentives SET applied_to_salary_id=? WHERE employee_id=? AND period=? AND applied_to_salary_id IS NULL`)
        .run(r.lastInsertRowid, e.id, period);
      created++;
      names.push(e.name);
    }
  });
  trx();
  req.audit('generate_payroll', 'salary', null, `${period} · ${created} slip(s): ${names.slice(0,5).join(', ')}${names.length>5?' +' + (names.length-5) + ' more':''}`);
  flash(req, 'success', `Generated ${created} salary slip${created===1?'':'s'}${skipped?', '+skipped+' already existed':''}.`);
  res.redirect('/hr/payroll?period=' + period);
});

// Bulk-delete DRAFT slips for the period (paid slips are immutable).
router.post('/payroll/delete-selected', (req, res) => {
  const period = req.body.period;
  const ids = [].concat(req.body.slip_ids || []).map(x => parseInt(x)).filter(Boolean);
  if (ids.length === 0) { flash(req,'danger','Pick at least one slip to delete.'); return res.redirect('/hr/payroll?period=' + period); }
  let deleted = 0, blocked = 0;
  const trx = db.transaction(() => {
    for (const id of ids) {
      const slip = db.prepare('SELECT * FROM salary_payments WHERE id=?').get(id);
      if (!slip) continue;
      if (slip.status === 'paid') { blocked++; continue; }
      db.prepare('UPDATE employee_incentives SET applied_to_salary_id=NULL WHERE applied_to_salary_id=?').run(id);
      db.prepare('DELETE FROM salary_payments WHERE id=?').run(id);
      deleted++;
    }
  });
  trx();
  req.audit('delete_payroll', 'salary', null, `${period} · deleted ${deleted} draft slip(s)${blocked ? ', ' + blocked + ' paid slip(s) skipped' : ''}`);
  flash(req, deleted ? 'success' : 'warning', `${deleted} slip${deleted===1?'':'s'} deleted${blocked ? ' — ' + blocked + ' paid slip(s) were skipped (immutable)' : ''}.`);
  res.redirect('/hr/payroll?period=' + period);
});

router.get('/payroll/:id', (req, res) => {
  const slip = db.prepare(`SELECT s.*, e.code, e.name AS emp_name, e.employee_type, e.department, e.designation, pm.name AS mode FROM salary_payments s JOIN employees e ON e.id=s.employee_id LEFT JOIN payment_modes pm ON pm.id=s.payment_mode_id WHERE s.id=?`).get(req.params.id);
  if (!slip) return res.redirect('/hr/payroll');
  const incentives = db.prepare('SELECT * FROM employee_incentives WHERE applied_to_salary_id=?').all(slip.id);
  const advanceRepayments = db.prepare(`SELECT r.*, a.advance_date, a.amount AS advance_total FROM employee_advance_repayments r JOIN employee_advances a ON a.id=r.advance_id WHERE r.salary_payment_id=?`).all(slip.id);
  const modes = db.prepare("SELECT * FROM payment_modes WHERE active=1 ORDER BY name").all();
  res.render('hr/payroll/show', { title: 'Salary Slip ' + slip.period, s: slip, incentives, advanceRepayments, modes });
});

router.post('/payroll/:id/pay', (req, res) => {
  const slip = db.prepare('SELECT * FROM salary_payments WHERE id=?').get(req.params.id);
  if (!slip) return res.redirect('/hr/payroll');
  if (slip.status === 'paid') { flash(req,'warning','Already paid.'); return res.redirect('/hr/payroll/' + slip.id); }
  const { paid_date, payment_mode_id, notes } = req.body;
  const payDate = paid_date || require('../utils/format').todayLocal();

  // GUARD against the double-deduction bug: the slip's advance_deducted
  // was computed at GENERATION time from the then-open balance. If a
  // sibling slip (another period) was paid in between, part of that
  // balance is already recovered — deducting the stale figure would
  // short the employee (money withheld but applied to nothing).
  // Recompute against the LIVE open balance and shrink the deduction
  // (and grow the net) if needed. Never grow the deduction silently —
  // a new advance taken after generation needs an explicit Recalculate.
  const liveOpen = db.prepare("SELECT COALESCE(SUM(balance),0) AS v FROM employee_advances WHERE employee_id=? AND status!='cleared'").get(slip.employee_id).v;
  const actualAdv = Math.min(slip.advance_deducted, liveOpen);
  const advAdjusted = Math.abs(actualAdv - slip.advance_deducted) > 0.01;

  const trx = db.transaction(() => {
    if (advAdjusted) {
      const newNet = slip.gross - actualAdv;
      db.prepare('UPDATE salary_payments SET advance_deducted=?, net_paid=? WHERE id=?').run(actualAdv, newNet, slip.id);
      slip.advance_deducted = actualAdv;
      slip.net_paid = newNet;
    }
    db.prepare(`UPDATE salary_payments SET status='paid', paid_date=?, payment_mode_id=?, notes=COALESCE(notes,'') || CASE WHEN ?<>'' THEN char(10) || ? ELSE '' END WHERE id=?`)
      .run(payDate, payment_mode_id||null, notes||'', notes||'', slip.id);
    // Incentives are linked to the slip at GENERATION / RECALC time now
    // (see /payroll/generate) — no mass-marking here, which used to
    // swallow incentives created after generation without paying them.
    // Apply the advance deduction as repayment(s) — FIFO across open advances
    let remaining = slip.advance_deducted;
    const advances = db.prepare("SELECT * FROM employee_advances WHERE employee_id=? AND status!='cleared' ORDER BY id").all(slip.employee_id);
    for (const a of advances) {
      if (remaining <= 0.01) break;
      const apply = Math.min(remaining, a.balance);
      const newBal = a.balance - apply;
      const newStatus = newBal <= 0.01 ? 'cleared' : 'partial';
      db.prepare(`INSERT INTO employee_advance_repayments (advance_id, repay_date, amount, salary_payment_id, notes) VALUES (?,?,?,?,?)`)
        .run(a.id, payDate, apply, slip.id, 'auto-deducted from salary ' + slip.period);
      db.prepare('UPDATE employee_advances SET balance=?, status=? WHERE id=?').run(newBal, newStatus, a.id);
      remaining -= apply;
    }
  });
  trx();
  req.audit('pay_salary', 'salary', slip.id, `${slip.period} · ₹${slip.net_paid.toFixed(2)}${advAdjusted ? ' (advance deduction adjusted to live balance)' : ''}`);
  flash(req, 'success', advAdjusted
    ? `Marked as paid. Note: advance deduction was reduced to ${'₹'}${actualAdv.toFixed(2)} (part of the balance was already recovered by another slip) — net pay adjusted up.`
    : 'Marked as paid.');
  res.redirect('/hr/payroll/' + slip.id);
});

router.post('/payroll/:id/delete', (req, res) => {
  const slip = db.prepare('SELECT * FROM salary_payments WHERE id=?').get(req.params.id);
  if (!slip) return res.redirect('/hr/payroll');
  if (slip.status === 'paid') { flash(req,'danger','Cannot delete a paid slip'); return res.redirect('/hr/payroll/' + slip.id); }
  const trx = db.transaction(() => {
    // Free the incentives this slip had claimed so the next generation
    // (or another period's recalc) can pick them up again.
    db.prepare('UPDATE employee_incentives SET applied_to_salary_id=NULL WHERE applied_to_salary_id=?').run(slip.id);
    db.prepare('DELETE FROM salary_payments WHERE id=?').run(slip.id);
  });
  trx();
  req.audit('delete_salary', 'salary', slip.id, `${slip.period} · draft slip for employee #${slip.employee_id} deleted`);
  flash(req,'success','Slip deleted.');
  res.redirect('/hr/payroll?period=' + slip.period);
});

// Recalculate a draft slip after attendance / pieces / incentives changed.
// Only allowed on drafts — paid slips are historical records and immutable.
router.post('/payroll/:id/recalc', (req, res) => {
  const slip = db.prepare('SELECT * FROM salary_payments WHERE id=?').get(req.params.id);
  if (!slip) return res.redirect('/hr/payroll');
  if (slip.status === 'paid') { flash(req,'danger','Cannot recalculate a paid slip — delete and regenerate is not allowed once paid.'); return res.redirect('/hr/payroll/' + slip.id); }
  const e = db.prepare('SELECT * FROM employees WHERE id=?').get(slip.employee_id);
  if (!e) { flash(req,'danger','Employee not found'); return res.redirect('/hr/payroll/' + slip.id); }
  const fresh = computeSlip(e, slip.period, slip.id);
  const trx = db.transaction(() => {
    db.prepare(`UPDATE salary_payments SET base_amount=?, days_present=?, days_absent=?, piece_amount=?, incentive_amount=?, km_amount=?, advance_deducted=?, gross=?, net_paid=?, month_days=?, paid_days=?, half_day_count=?, leave_count=?, holiday_count=?, unmarked_count=? WHERE id=?`)
      .run(fresh.base, fresh.daysPresent, fresh.daysAbsent, fresh.piece, fresh.incentive, fresh.km, fresh.advance, fresh.gross, fresh.net,
           fresh.monthDays, fresh.paidDays, fresh.halfDay, fresh.leave, fresh.holiday, fresh.unmarked, slip.id);
    // Pull in any incentives created since generation (they were summed
    // into fresh.incentive above via the IS NULL branch).
    db.prepare(`UPDATE employee_incentives SET applied_to_salary_id=? WHERE employee_id=? AND period=? AND applied_to_salary_id IS NULL`)
      .run(slip.id, slip.employee_id, slip.period);
  });
  trx();
  req.audit('recalc_salary', 'salary', slip.id, `${slip.period} · gross ₹${fresh.gross.toFixed(2)} net ₹${fresh.net.toFixed(2)}`);
  flash(req,'success','Slip recalculated.');
  res.redirect('/hr/payroll/' + slip.id);
});

// Compute a salary slip preview for an employee × period
function computeSlip(e, period, slipId = null) {
  // Compute the actual number of days in the period (28-31)
  const [y, m] = period.split('-').map(Number);
  const monthDays = new Date(y, m, 0).getDate();

  // Attendance buckets for this employee × period
  const att = db.prepare(`SELECT status, COUNT(*) AS n FROM employee_attendance WHERE employee_id=? AND strftime('%Y-%m', attendance_date)=? GROUP BY status`).all(e.id, period);
  let present = 0, absent = 0, halfDay = 0, leave = 0, holiday = 0;
  att.forEach(a => {
    if (a.status === 'present')      present  = a.n;
    else if (a.status === 'absent')  absent   = a.n;
    else if (a.status === 'half_day')halfDay  = a.n;
    else if (a.status === 'leave')   leave    = a.n;
    else if (a.status === 'holiday') holiday  = a.n;
  });
  const totalMarked = present + absent + halfDay + leave + holiday;
  const unmarked = Math.max(0, monthDays - totalMarked);
  // Days that count as PAID: present + half-day (0.5) + leave + holiday.
  // Days that count as UNPAID: absent + unmarked. (If you want unmarked
  // days to be paid, mark them as 'leave' or 'holiday'.)
  const paidDays = present + halfDay * 0.5 + leave + holiday;
  const totalAbsent = absent + unmarked;

  // Salary base, pro-rated by paid days. SAFETY: if no attendance at all
  // was marked for the month, fall back to full salary so a brand-new
  // install where the owner hasn't started tracking attendance yet doesn't
  // pay everyone zero.
  let base = 0;
  if (e.employee_type === 'salary') {
    if (totalMarked === 0) base = e.base_salary || 0;
    else                   base = (e.base_salary || 0) * (paidDays / monthDays);
  }

  // Pieces
  const pieceTotal = db.prepare(`SELECT COALESCE(SUM(total_amount),0) AS v FROM employee_pieces WHERE employee_id=? AND strftime('%Y-%m', work_date)=?`).get(e.id, period).v;
  // KM
  const kmTotal = db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM employee_km_log WHERE employee_id=? AND strftime('%Y-%m', log_date)=?`).get(e.id, period).v;
  // Incentives: unlinked ones, plus (on recalc) the ones already linked
  // to THIS slip — without the second term a recalc would zero out the
  // incentive line because generation linked them.
  const incTotal = slipId
    ? db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM employee_incentives WHERE employee_id=? AND period=? AND (applied_to_salary_id IS NULL OR applied_to_salary_id=?)`).get(e.id, period, slipId).v
    : db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM employee_incentives WHERE employee_id=? AND period=? AND applied_to_salary_id IS NULL`).get(e.id, period).v;
  // Advance balance — cap deduction at gross (don't push net negative)
  const advBalance = db.prepare("SELECT COALESCE(SUM(balance),0) AS v FROM employee_advances WHERE employee_id=? AND status!='cleared'").get(e.id).v;
  const gross = base + pieceTotal + incTotal + kmTotal;
  const advance = Math.min(advBalance, Math.max(0, gross));
  const net = gross - advance;

  return {
    base,
    daysPresent: present + halfDay * 0.5,   // half-days count as 0.5 present
    daysAbsent: totalAbsent,
    monthDays, paidDays, halfDay, leave, holiday, unmarked,
    piece: pieceTotal, incentive: incTotal, km: kmTotal,
    advance, gross, net,
    notes: null,
  };
}

module.exports = router;
