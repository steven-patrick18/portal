const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { requireFeature, requireWrite } = require('../middleware/permissions');
const { nextCode } = require('../utils/codegen');
const router = express.Router();

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
  const employees = db.prepare("SELECT id, code, name, per_piece_rate FROM employees WHERE active=1 AND employee_type='contract' ORDER BY name").all();
  const products = db.prepare('SELECT id, code, name FROM products WHERE active=1 ORDER BY name').all();
  const workTypes = db.prepare('SELECT id, name, default_rate FROM work_types WHERE active=1 ORDER BY name').all();
  res.render('hr/pieces', { title: 'Per-Piece Work Log', items, total, month, employees, products, workTypes });
});

router.post('/pieces', (req, res) => {
  const f = req.body;
  const qty = parseInt(f.qty_pieces);
  const rate = parseFloat(f.rate_per_piece);
  if (!f.employee_id || !qty || !rate) { flash(req,'danger','Employee, qty, and rate required'); return res.redirect('/hr/pieces'); }
  const total = qty * rate;
  db.prepare(`INSERT INTO employee_pieces (employee_id, work_date, qty_pieces, rate_per_piece, total_amount, product_id, batch_id, work_type_id, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(parseInt(f.employee_id), f.work_date, qty, rate, total, f.product_id||null, f.batch_id||null, f.work_type_id||null, f.notes||null, req.session.user.id);
  flash(req, 'success', `Logged ${qty} pcs · ₹${total.toFixed(2)}.`);
  res.redirect('/hr/pieces?month=' + (f.work_date||'').slice(0,7));
});

router.post('/pieces/:id/delete', (req, res) => {
  db.prepare('DELETE FROM employee_pieces WHERE id=?').run(req.params.id);
  flash(req, 'success', 'Deleted.');
  res.redirect('back' in res ? 'back' : '/hr/pieces');
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
  const employees = db.prepare("SELECT id, code, name, km_rate FROM employees WHERE active=1 AND department IN ('sales','field') ORDER BY name").all();
  const allEmployees = db.prepare("SELECT id, code, name, km_rate FROM employees WHERE active=1 ORDER BY name").all();
  const dealers = db.prepare('SELECT id, code, name FROM dealers WHERE active=1 ORDER BY name').all();
  res.render('hr/km', { title: 'Mileage Log', items, total, totalKm, month, employees: employees.length ? employees : allEmployees, dealers });
});

router.post('/km', (req, res) => {
  const f = req.body;
  const km = parseFloat(f.km);
  const rate = parseFloat(f.rate_per_km);
  if (!f.employee_id || !km || !rate) { flash(req,'danger','Employee, km, and rate required'); return res.redirect('/hr/km'); }
  const amount = km * rate;
  db.prepare(`INSERT INTO employee_km_log (employee_id, log_date, km, rate_per_km, amount, dealer_id, notes, created_by) VALUES (?,?,?,?,?,?,?,?)`)
    .run(parseInt(f.employee_id), f.log_date, km, rate, amount, f.dealer_id||null, f.notes||null, req.session.user.id);
  flash(req, 'success', `Logged ${km} km · ₹${amount.toFixed(2)}.`);
  res.redirect('/hr/km?month=' + (f.log_date||'').slice(0,7));
});

router.post('/km/:id/delete', (req, res) => {
  db.prepare('DELETE FROM employee_km_log WHERE id=?').run(req.params.id);
  flash(req, 'success', 'Deleted.');
  res.redirect('/hr/km');
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
  db.prepare(`INSERT INTO employee_advances (employee_id, advance_date, amount, balance, status, notes, created_by) VALUES (?,?,?,?,'pending',?,?)`)
    .run(parseInt(f.employee_id), f.advance_date, amount, amount, f.notes||null, req.session.user.id);
  flash(req, 'success', `Advance ₹${amount.toFixed(2)} recorded.`);
  res.redirect('/hr/advances');
});

router.post('/advances/:id/repay', (req, res) => {
  const adv = db.prepare('SELECT * FROM employee_advances WHERE id=?').get(req.params.id);
  if (!adv) return res.redirect('/hr/advances');
  const amt = parseFloat(req.body.amount);
  if (!amt || amt <= 0) { flash(req,'danger','Invalid amount'); return res.redirect('/hr/advances'); }
  const newBal = Math.max(0, adv.balance - amt);
  const status = newBal <= 0.01 ? 'cleared' : 'partial';
  const trx = db.transaction(() => {
    db.prepare(`INSERT INTO employee_advance_repayments (advance_id, repay_date, amount, notes) VALUES (?, date('now'), ?, ?)`)
      .run(adv.id, amt, req.body.notes||null);
    db.prepare('UPDATE employee_advances SET balance=?, status=? WHERE id=?').run(newBal, status, adv.id);
  });
  trx();
  flash(req, 'success', `Repayment ₹${amt.toFixed(2)} recorded.`);
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
  db.prepare(`INSERT INTO employee_incentives (employee_id, period, reason, amount, created_by) VALUES (?,?,?,?,?)`)
    .run(parseInt(f.employee_id), f.period, f.reason||null, amount, req.session.user.id);
  flash(req, 'success', `Incentive ₹${amount.toFixed(2)} added.`);
  res.redirect('/hr/incentives?period=' + f.period);
});

router.post('/incentives/:id/delete', (req, res) => {
  const i = db.prepare('SELECT applied_to_salary_id FROM employee_incentives WHERE id=?').get(req.params.id);
  if (i && i.applied_to_salary_id) { flash(req,'danger','Already applied to a salary slip — cannot delete'); return res.redirect('/hr/incentives'); }
  db.prepare('DELETE FROM employee_incentives WHERE id=?').run(req.params.id);
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
  res.render('hr/payroll/index', { title: 'Payroll', items, totals, period, empCount });
});

router.post('/payroll/generate', (req, res) => {
  const period = req.body.period;
  if (!/^\d{4}-\d{2}$/.test(period)) { flash(req,'danger','Invalid period (YYYY-MM)'); return res.redirect('/hr/payroll'); }
  const employees = db.prepare('SELECT * FROM employees WHERE active=1').all();
  let created = 0, skipped = 0;
  const trx = db.transaction(() => {
    for (const e of employees) {
      const existing = db.prepare('SELECT id FROM salary_payments WHERE employee_id=? AND period=?').get(e.id, period);
      if (existing) { skipped++; continue; }
      const slip = computeSlip(e, period);
      db.prepare(`INSERT INTO salary_payments (employee_id, period, base_amount, days_present, days_absent, piece_amount, incentive_amount, km_amount, advance_deducted, gross, net_paid, notes, created_by, month_days, paid_days, half_day_count, leave_count, holiday_count, unmarked_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(e.id, period, slip.base, slip.daysPresent, slip.daysAbsent, slip.piece, slip.incentive, slip.km, slip.advance, slip.gross, slip.net, slip.notes, req.session.user.id,
             slip.monthDays, slip.paidDays, slip.halfDay, slip.leave, slip.holiday, slip.unmarked);
      created++;
    }
  });
  trx();
  flash(req, 'success', `Generated ${created} salary slip${created===1?'':'s'}${skipped?', '+skipped+' already existed':''}.`);
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
  const trx = db.transaction(() => {
    db.prepare(`UPDATE salary_payments SET status='paid', paid_date=?, payment_mode_id=?, notes=COALESCE(notes,'') || CASE WHEN ?<>'' THEN char(10) || ? ELSE '' END WHERE id=?`)
      .run(paid_date || new Date().toISOString().slice(0,10), payment_mode_id||null, notes||'', notes||'', slip.id);
    // Mark incentives in this period as applied
    db.prepare(`UPDATE employee_incentives SET applied_to_salary_id=? WHERE employee_id=? AND period=? AND applied_to_salary_id IS NULL`)
      .run(slip.id, slip.employee_id, slip.period);
    // Apply the advance deduction as repayment(s) — FIFO across open advances
    let remaining = slip.advance_deducted;
    const advances = db.prepare("SELECT * FROM employee_advances WHERE employee_id=? AND status!='cleared' ORDER BY id").all(slip.employee_id);
    for (const a of advances) {
      if (remaining <= 0.01) break;
      const apply = Math.min(remaining, a.balance);
      const newBal = a.balance - apply;
      const newStatus = newBal <= 0.01 ? 'cleared' : 'partial';
      db.prepare(`INSERT INTO employee_advance_repayments (advance_id, repay_date, amount, salary_payment_id, notes) VALUES (?,?,?,?,?)`)
        .run(a.id, paid_date || new Date().toISOString().slice(0,10), apply, slip.id, 'auto-deducted from salary ' + slip.period);
      db.prepare('UPDATE employee_advances SET balance=?, status=? WHERE id=?').run(newBal, newStatus, a.id);
      remaining -= apply;
    }
  });
  trx();
  req.audit('pay_salary', 'salary', slip.id, `${slip.period} · ₹${slip.net_paid.toFixed(2)}`);
  flash(req, 'success', 'Marked as paid.');
  res.redirect('/hr/payroll/' + slip.id);
});

router.post('/payroll/:id/delete', (req, res) => {
  const slip = db.prepare('SELECT * FROM salary_payments WHERE id=?').get(req.params.id);
  if (!slip) return res.redirect('/hr/payroll');
  if (slip.status === 'paid') { flash(req,'danger','Cannot delete a paid slip'); return res.redirect('/hr/payroll/' + slip.id); }
  db.prepare('DELETE FROM salary_payments WHERE id=?').run(slip.id);
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
  const fresh = computeSlip(e, slip.period);
  db.prepare(`UPDATE salary_payments SET base_amount=?, days_present=?, days_absent=?, piece_amount=?, incentive_amount=?, km_amount=?, advance_deducted=?, gross=?, net_paid=?, month_days=?, paid_days=?, half_day_count=?, leave_count=?, holiday_count=?, unmarked_count=? WHERE id=?`)
    .run(fresh.base, fresh.daysPresent, fresh.daysAbsent, fresh.piece, fresh.incentive, fresh.km, fresh.advance, fresh.gross, fresh.net,
         fresh.monthDays, fresh.paidDays, fresh.halfDay, fresh.leave, fresh.holiday, fresh.unmarked, slip.id);
  flash(req,'success','Slip recalculated.');
  res.redirect('/hr/payroll/' + slip.id);
});

// Compute a salary slip preview for an employee × period
function computeSlip(e, period) {
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
  // Incentives
  const incTotal = db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM employee_incentives WHERE employee_id=? AND period=? AND applied_to_salary_id IS NULL`).get(e.id, period).v;
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
