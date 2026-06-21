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
  // Probation confirmations that are due-soon or overdue (drives the alert).
  const due = confirmationsDue();
  const confirmDue = due.filter(d => d.conf_status !== 'upcoming').length;
  res.render('hr/dashboard', { title: 'HR Dashboard', empCount, presentToday, advancesOpen, monthSalary, monthPieceTotal, monthKm, period, today, confirmDue });
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

// Build the salary_components JSON from the form's comp_name[]/comp_amount[]
// arrays. Returns a JSON string, or null when no usable rows (→ auto-calc).
function componentsJson(f) {
  const names = [].concat(f.comp_name || []);
  const amts  = [].concat(f.comp_amount || []);
  const rows = [];
  for (let i = 0; i < names.length; i++) {
    const name = String(names[i] || '').trim();
    const amount = parseFloat(amts[i]);
    if (name && isFinite(amount) && amount > 0) rows.push({ name, amount });
  }
  return rows.length ? JSON.stringify(rows) : null;
}

router.post('/employees', (req, res) => {
  const code = req.body.code || nextCode('employees', 'code', 'EMP');
  const f = req.body;
  const r = db.prepare(`INSERT INTO employees (code,name,phone,email,address,employee_type,department,designation,base_salary,per_piece_rate,km_rate,joining_date,bank_name,account_no,ifsc,pan,user_id,notes,father_name,dob,probation_months,notice_period_days,confirmation_date,reporting_to,salary_components) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(code, f.name, f.phone||null, f.email||null, f.address||null, f.employee_type||'salary', f.department||null, f.designation||null,
         parseFloat(f.base_salary||0), parseFloat(f.per_piece_rate||0), parseFloat(f.km_rate||0),
         f.joining_date||null, f.bank_name||null, f.account_no||null, f.ifsc||null, f.pan||null,
         f.user_id ? parseInt(f.user_id) : null, f.notes||null,
         f.father_name||null, f.dob||null,
         f.probation_months !== undefined && f.probation_months !== '' ? parseInt(f.probation_months) : 3,
         f.notice_period_days !== undefined && f.notice_period_days !== '' ? parseInt(f.notice_period_days) : 30,
         f.confirmation_date||null, f.reporting_to||null, componentsJson(f));
  req.audit('create', 'employee', r.lastInsertRowid, `${code} ${f.name}`);
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
  const documents = db.prepare('SELECT * FROM employee_documents WHERE employee_id=? ORDER BY id DESC').all(e.id);
  const docTypes = require('../utils/hrDocs').DOC_TYPES;
  // Per-employee compliance snapshot (reuses the matrix builder, filtered to this employee).
  const _m = complianceMatrix();
  const compliance = _m.rows.find(r => r.id === e.id) || null;
  const complianceChecks = _m.checks;
  res.render('hr/employees/show', { title: e.name, e, attendance, advances, advanceBalance, recentPieces, recentKm, recentSalary, period, documents, docTypes, compliance, complianceChecks });
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
  db.prepare(`UPDATE employees SET name=?,phone=?,email=?,address=?,employee_type=?,department=?,designation=?,base_salary=?,per_piece_rate=?,km_rate=?,joining_date=?,exit_date=?,bank_name=?,account_no=?,ifsc=?,pan=?,user_id=?,active=?,notes=?,father_name=?,dob=?,probation_months=?,notice_period_days=?,confirmation_date=?,reporting_to=?,salary_components=?,updated_at=datetime('now') WHERE id=?`)
    .run(f.name, f.phone||null, f.email||null, f.address||null, f.employee_type||'salary', f.department||null, f.designation||null,
         parseFloat(f.base_salary||0), parseFloat(f.per_piece_rate||0), parseFloat(f.km_rate||0),
         f.joining_date||null, f.exit_date||null, f.bank_name||null, f.account_no||null, f.ifsc||null, f.pan||null,
         f.user_id ? parseInt(f.user_id) : null, f.active?1:0, f.notes||null,
         f.father_name||null, f.dob||null,
         f.probation_months !== undefined && f.probation_months !== '' ? parseInt(f.probation_months) : (e.probation_months ?? 3),
         f.notice_period_days !== undefined && f.notice_period_days !== '' ? parseInt(f.notice_period_days) : (e.notice_period_days ?? 30),
         f.confirmation_date||null, f.reporting_to||null, componentsJson(f), e.id);
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
  const clear  = db.prepare(`DELETE FROM employee_attendance WHERE employee_id=? AND attendance_date=?`);
  const trx = db.transaction(() => {
    for (let i = 0; i < ids.length; i++) {
      const eid = parseInt(ids[i]); const st = statuses[i];
      if (!eid) continue;
      // Empty status = "unmarked": delete any existing row so a
      // mistakenly-marked day can be reverted to blank (not just to a
      // different status). Without this, payroll keeps pro-rating on a
      // stale mark that the UI can never clear.
      if (!st) { clear.run(eid, attendance_date); continue; }
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

// Per-employee biometric code (inline save from the mapping table).
// Routed under /attendance (not /employees) so it inherits the
// attendance-level guard, not the stricter hr_employees:full write
// guard — the mapping page is reachable with attendance access.
router.post('/attendance/biometric-code/:id', (req, res) => {
  const e = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id);
  if (!e) return res.redirect('/hr/attendance/biometric');
  const code = (req.body.biometric_code || '').trim() || null;
  db.prepare("UPDATE employees SET biometric_code=?, updated_at=datetime('now') WHERE id=?").run(code, e.id);
  req.audit('update', 'employee', e.id, `${e.code} biometric_code → ${code || '—'}`);
  flash(req,'success', `${e.name}: biometric code ${code ? 'set to ' + code : 'cleared'}.`);
  res.redirect('/hr/attendance/biometric');
});

// ═══════════════ HR DOCUMENTS (letters) ═══════════════════════
const hrDocs = require('../utils/hrDocs');

const DOC_PREFIX = {
  offer: 'OFR', appointment: 'APT', joining: 'JNG', confirmation: 'CNF',
  probation_extension: 'PRB', increment: 'INC', warning: 'WRN',
  termination: 'TRM', resignation_acceptance: 'RES', relieving: 'REL',
  experience: 'EXP', salary_certificate: 'SLC',
  // Phase 2
  performance_appraisal: 'APR', promotion: 'PRO', pip: 'PIP',
  show_cause: 'SCN', charge_sheet: 'CHG', suspension: 'SUS',
  transfer: 'TRF', full_final: 'FNF', noc: 'NOC', bonafide: 'BON',
};
function nextDocNo(docType) {
  const prefix = DOC_PREFIX[docType] || 'DOC';
  const rows = db.prepare("SELECT doc_no FROM employee_documents WHERE doc_type=? AND doc_no IS NOT NULL").all(docType);
  let max = 0;
  rows.forEach(r => {
    const m = String(r.doc_no).match(/(\d+)\s*$/);
    if (m) max = Math.max(max, parseInt(m[1]));
  });
  return prefix + String(max + 1).padStart(5, '0');
}
function brandCompany() {
  try { return require('./settings').getBranding(); }
  catch (_) { return { name: process.env.COMPANY_NAME || 'Company', address:'', phone:'', email:'', gstin:'', logo:'' }; }
}

// Generate a draft document for an employee from a standard template.
router.post('/employees/:id/documents', (req, res) => {
  const e = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id);
  if (!e) return res.redirect('/hr/employees');
  const docType = req.body.doc_type;
  const built = hrDocs.buildDoc(docType, e, brandCompany());
  if (!built) { flash(req,'danger','Unknown document type.'); return res.redirect('/hr/employees/' + e.id); }
  const r = db.prepare(`INSERT INTO employee_documents (employee_id, doc_type, title, body_html, status) VALUES (?,?,?,?,'draft')`)
    .run(e.id, docType, built.title, built.html);
  req.audit('create', 'document', r.lastInsertRowid, `${e.code} ${e.name} · ${built.title} (draft)`);
  flash(req,'success', `${built.title} draft created — review, edit if needed, then Issue.`);
  res.redirect('/hr/documents/' + r.lastInsertRowid);
});

// View / edit / print a single document.
router.get('/documents/:id', (req, res) => {
  const d = db.prepare(`SELECT d.*, e.name AS emp_name, e.code AS emp_code, e.designation, e.department
                        FROM employee_documents d JOIN employees e ON e.id=d.employee_id WHERE d.id=?`).get(req.params.id);
  if (!d) return res.redirect('/hr/employees');
  res.render('hr/document', { title: d.title, d, docLabel: hrDocs.labelFor(d.doc_type) });
});

// Save edits to a DRAFT (issued/filed are frozen).
router.post('/documents/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM employee_documents WHERE id=?').get(req.params.id);
  if (!d) return res.redirect('/hr/employees');
  if (d.status !== 'draft') { flash(req,'danger','Only drafts can be edited. Issued documents are frozen.'); return res.redirect('/hr/documents/' + d.id); }
  const title = (req.body.title || d.title).trim();
  const body  = req.body.body_html || d.body_html;
  db.prepare("UPDATE employee_documents SET title=?, body_html=?, notes=?, updated_at=datetime('now') WHERE id=?")
    .run(title, body, req.body.notes || null, d.id);
  flash(req,'success','Draft saved.');
  res.redirect('/hr/documents/' + d.id);
});

// Issue = freeze: assign doc number, stamp issue date, lock editing.
router.post('/documents/:id/issue', (req, res) => {
  const d = db.prepare('SELECT * FROM employee_documents WHERE id=?').get(req.params.id);
  if (!d) return res.redirect('/hr/employees');
  if (d.status !== 'draft') { flash(req,'warning','Already issued.'); return res.redirect('/hr/documents/' + d.id); }
  const docNo = nextDocNo(d.doc_type);
  const issued = req.body.issued_date || require('../utils/format').todayLocal();
  // Bake the doc number into the frozen HTML (replaces the {{DOC_NO}} token).
  const frozen = String(d.body_html).replace(/\{\{DOC_NO\}\}/g, docNo);
  db.prepare("UPDATE employee_documents SET status='issued', doc_no=?, issued_date=?, body_html=?, updated_at=datetime('now') WHERE id=?")
    .run(docNo, issued, frozen, d.id);
  // Issuing a Confirmation letter marks the employee confirmed (sets
  // confirmation_date if not already set) so they drop off the
  // probation-due tracker automatically.
  if (d.doc_type === 'confirmation') {
    db.prepare("UPDATE employees SET confirmation_date=COALESCE(confirmation_date, ?), updated_at=datetime('now') WHERE id=?").run(issued, d.employee_id);
  }
  req.audit('issue', 'document', d.id, `${d.title} · ${docNo}`);
  flash(req,'success', `Issued as ${docNo}. Print it, get it signed & stamped, then upload the signed copy.`);
  res.redirect('/hr/documents/' + d.id);
});

// Upload the signed + stamped scan → status filed.
router.post('/documents/:id/upload', empUpload.single('signed_doc'), (req, res) => {
  const d = db.prepare('SELECT * FROM employee_documents WHERE id=?').get(req.params.id);
  if (!d) { if (req.file) try { fs.unlinkSync(req.file.path); } catch(_){} return res.redirect('/hr/employees'); }
  if (!req.file) { flash(req,'danger','No file received.'); return res.redirect('/hr/documents/' + d.id); }
  const rel = relUploadPath(req.file.path);
  db.prepare("UPDATE employee_documents SET signed_doc_path=?, status='filed', updated_at=datetime('now') WHERE id=?").run(rel, d.id);
  req.audit('file_signed', 'document', d.id, `${d.title} · signed copy uploaded`);
  flash(req,'success','Signed copy filed.');
  res.redirect('/hr/documents/' + d.id);
});

router.post('/documents/:id/delete', (req, res) => {
  const d = db.prepare('SELECT * FROM employee_documents WHERE id=?').get(req.params.id);
  if (!d) return res.redirect('/hr/employees');
  if (!['owner','admin'].includes(req.session.user.role)) { flash(req,'danger','Only owner/admin can delete a document.'); return res.redirect('/hr/documents/' + d.id); }
  db.prepare('DELETE FROM employee_documents WHERE id=?').run(d.id);
  req.audit('delete', 'document', d.id, `${d.title}${d.doc_no ? ' · ' + d.doc_no : ' (draft)'} · emp #${d.employee_id}`);
  flash(req,'success','Document deleted.');
  res.redirect('/hr/employees/' + d.employee_id);
});

// ═══════════════ POLICY HANDBOOK ══════════════════════════════
function getHandbook() {
  let hb = db.prepare("SELECT * FROM company_policies WHERE code='HANDBOOK'").get();
  if (!hb) {
    const c = brandCompany();
    const r = db.prepare(`INSERT INTO company_policies (code, title, body_html, version, effective_date) VALUES ('HANDBOOK','Employee Policy Handbook',?,1,date('now'))`)
      .run(hrDocs.defaultHandbookHtml(c));
    hb = db.prepare('SELECT * FROM company_policies WHERE id=?').get(r.lastInsertRowid);
  }
  return hb;
}

router.get('/handbook', (req, res) => {
  const hb = getHandbook();
  const isOwner = ['owner','admin'].includes(req.session.user.role);
  // Acknowledgment register for the CURRENT version.
  const employees = db.prepare("SELECT id, code, name FROM employees WHERE active=1 ORDER BY name").all();
  const acks = db.prepare("SELECT * FROM policy_acknowledgments WHERE policy_id=? AND version=?").all(hb.id, hb.version);
  const ackByEmp = new Map(acks.map(a => [a.employee_id, a]));
  const roster = employees.map(e => ({ ...e, ack: ackByEmp.get(e.id) || null }));
  const ackedCount = roster.filter(r => r.ack).length;
  res.render('hr/handbook', { title: 'Policy Handbook', hb, isOwner, roster, ackedCount });
});

router.post('/handbook', (req, res) => {
  if (!['owner','admin'].includes(req.session.user.role)) { flash(req,'danger','Only owner/admin can edit the handbook.'); return res.redirect('/hr/handbook'); }
  const hb = getHandbook();
  const body = req.body.body_html || hb.body_html;
  const title = (req.body.title || hb.title).trim();
  const bump = req.body.bump_version === '1';
  // Bumping the version forces everyone to re-acknowledge the new edition.
  const newVersion = bump ? hb.version + 1 : hb.version;
  db.prepare("UPDATE company_policies SET title=?, body_html=?, version=?, effective_date=CASE WHEN ? THEN date('now') ELSE effective_date END, updated_by=?, updated_at=datetime('now') WHERE id=?")
    .run(title, body, newVersion, bump ? 1 : 0, req.session.user.id, hb.id);
  req.audit('update', 'handbook', hb.id, bump ? `bumped to v${newVersion} — all staff must re-acknowledge` : 'edited (same version)');
  flash(req,'success', bump ? `Saved as version ${newVersion}. Existing acknowledgments are now superseded — staff re-sign the new edition.` : 'Handbook saved.');
  res.redirect('/hr/handbook');
});

// Record an employee's acknowledgment of the current version (with
// optional signed-copy upload).
router.post('/handbook/acknowledge', empUpload.single('signed_doc'), (req, res) => {
  const hb = getHandbook();
  const empId = parseInt(req.body.employee_id);
  if (!empId) { flash(req,'danger','Pick an employee.'); return res.redirect('/hr/handbook'); }
  const rel = req.file ? relUploadPath(req.file.path) : null;
  const ackDate = req.body.ack_date || require('../utils/format').todayLocal();
  db.prepare(`INSERT INTO policy_acknowledgments (policy_id, employee_id, version, ack_date, signed_doc_path, method, recorded_by)
              VALUES (?,?,?,?,?,?,?)
              ON CONFLICT(policy_id, employee_id, version) DO UPDATE SET
                ack_date=excluded.ack_date,
                signed_doc_path=COALESCE(excluded.signed_doc_path, policy_acknowledgments.signed_doc_path),
                method=excluded.method, recorded_by=excluded.recorded_by`)
    .run(hb.id, empId, hb.version, ackDate, rel, rel ? 'signed_upload' : 'recorded', req.session.user.id);
  const e = db.prepare('SELECT code, name FROM employees WHERE id=?').get(empId);
  req.audit('acknowledge', 'handbook', hb.id, `${e ? e.code + ' ' + e.name : '#'+empId} · v${hb.version}`);
  flash(req,'success', `Acknowledgment recorded for ${e ? e.name : 'employee'} (v${hb.version}).`);
  res.redirect('/hr/handbook');
});

// Reset the handbook body to the latest built-in standard template
// (the full 50-60 page manufacturing handbook). Bumps the version so
// staff re-acknowledge. Owner/admin only.
router.post('/handbook/reset', (req, res) => {
  if (!['owner','admin'].includes(req.session.user.role)) { flash(req,'danger','Only owner/admin can reset the handbook.'); return res.redirect('/hr/handbook'); }
  const hb = getHandbook();
  const fresh = hrDocs.defaultHandbookHtml(brandCompany());
  db.prepare("UPDATE company_policies SET body_html=?, version=version+1, effective_date=date('now'), updated_by=?, updated_at=datetime('now') WHERE id=?")
    .run(fresh, req.session.user.id, hb.id);
  req.audit('reset', 'handbook', hb.id, `reset to standard template, now v${hb.version + 1}`);
  flash(req,'success', `Handbook reset to the standard manufacturing template (now v${hb.version + 1}). Review/edit it, then collect fresh acknowledgments.`);
  res.redirect('/hr/handbook');
});

// ═══════════════ COMPLIANCE & AUTOMATION (Phase 3) ════════════
// Add N months to a 'YYYY-MM-DD' → 'YYYY-MM-DD'.
function addMonthsISO(iso, n) {
  if (!iso) return null;
  const d = new Date(String(iso).slice(0,10) + 'T00:00:00');
  if (isNaN(d)) return null;
  d.setMonth(d.getMonth() + (parseInt(n) || 0));
  return d.toISOString().slice(0,10);
}

// Confirmation-due rows: salaried/contract employees still on probation
// (confirmation_date not set) with a joining date — due = joining +
// probation_months. Returns sorted by due date with a status flag.
function confirmationsDue() {
  const today = new Date().toISOString().slice(0,10);
  const rows = db.prepare(`
    SELECT id, code, name, designation, department, employee_type, joining_date,
           COALESCE(probation_months,3) AS probation_months
    FROM employees
    WHERE active=1 AND confirmation_date IS NULL AND joining_date IS NOT NULL
  `).all();
  const out = [];
  rows.forEach(e => {
    const due = addMonthsISO(e.joining_date, e.probation_months);
    if (!due) return;
    const days = Math.floor((new Date(due) - new Date(today)) / 86400000);
    let status = 'upcoming';
    if (days < 0) status = 'overdue';
    else if (days <= 15) status = 'due_soon';
    out.push({ ...e, due_date: due, days_to_due: days, conf_status: status });
  });
  out.sort((a,b) => a.due_date.localeCompare(b.due_date));
  return out;
}

// Per-employee document completeness. Pass the active-employee list +
// the current handbook so callers can batch the lookups.
function complianceMatrix() {
  const hb = getHandbook();
  const employees = db.prepare("SELECT id, code, name, designation, department, photo_path, aadhaar_doc_path, pan_doc_path, police_verif_status, account_no FROM employees WHERE active=1 ORDER BY name").all();
  // Which employees have an issued/filed appointment letter.
  const apptSet = new Set(db.prepare("SELECT DISTINCT employee_id FROM employee_documents WHERE doc_type='appointment' AND status IN ('issued','filed')").all().map(r => r.employee_id));
  // Which employees acknowledged the CURRENT handbook version.
  const ackSet = new Set(db.prepare("SELECT employee_id FROM policy_acknowledgments WHERE policy_id=? AND version=?").all(hb.id, hb.version).map(r => r.employee_id));
  const checks = [
    { key: 'appointment', label: 'Appointment Letter' },
    { key: 'handbook',    label: 'Handbook Signed' },
    { key: 'photo',       label: 'Photo' },
    { key: 'aadhaar',     label: 'Aadhaar' },
    { key: 'pan',         label: 'PAN' },
    { key: 'police',      label: 'Police Verif.' },
    { key: 'bank',        label: 'Bank A/C' },
  ];
  const rows = employees.map(e => {
    const c = {
      appointment: apptSet.has(e.id),
      handbook:    ackSet.has(e.id),
      photo:       !!e.photo_path,
      aadhaar:     !!e.aadhaar_doc_path,
      pan:         !!e.pan_doc_path,
      police:      e.police_verif_status === 'verified',
      bank:        !!e.account_no,
    };
    const done = checks.filter(ck => c[ck.key]).length;
    return { ...e, c, done, total: checks.length, pct: Math.round(done * 100 / checks.length) };
  });
  return { checks, rows, hbVersion: hb.version };
}

router.get('/compliance', (req, res) => {
  const due = confirmationsDue();
  const matrix = complianceMatrix();
  const dueSoon = due.filter(d => d.conf_status !== 'upcoming').length;
  const fullyCompliant = matrix.rows.filter(r => r.done === r.total).length;
  res.render('hr/compliance', { title: 'HR Compliance', due, matrix, dueSoon, fullyCompliant });
});

// Documents register — every issued/filed document across all
// employees, filterable, printable on letterhead.
router.get('/documents-register', (req, res) => {
  const from = req.query.from || (new Date(Date.now() - 365*86400000).toISOString().slice(0,10));
  const to   = req.query.to   || new Date().toISOString().slice(0,10);
  const docType = req.query.type || 'all';
  const params = [from, to];
  let where = `d.status!='draft' AND d.issued_date BETWEEN ? AND ?`;
  if (docType !== 'all') { where += ' AND d.doc_type=?'; params.push(docType); }
  const rows = db.prepare(`
    SELECT d.*, e.name AS emp_name, e.code AS emp_code
    FROM employee_documents d JOIN employees e ON e.id=d.employee_id
    WHERE ${where}
    ORDER BY d.issued_date DESC, d.id DESC
  `).all(...params);
  res.render('hr/documentsRegister', { title: 'Documents Register', rows, from, to, docType, docTypes: hrDocs.DOC_TYPES, labelFor: hrDocs.labelFor });
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
