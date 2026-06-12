// End-to-end tests for the HR module — employees, attendance, piece
// work, KM, advances, incentives, payroll generation / recalc / pay /
// delete, and the printed slip. Exercises the REAL HTTP routes via
// supertest so middleware, validation, and flash flows are covered.
//
// Runs against an isolated throwaway DB (data/test-hr.db) so it never
// touches dev or production data. Run with:
//   node --test test/hr.test.js

const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const request = require('supertest');

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-only-secret';
// Isolated DB — delete any leftover from a previous run BEFORE the
// db module opens it.
const TEST_DB = path.join(__dirname, '..', 'data', 'test-hr.db');
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.unlinkSync(f); } catch (_) {}
}
process.env.DB_PATH = TEST_DB;

const { db, initDb } = require('../src/db');
initDb();
const app = require('../src/app');
const agent = request.agent(app);

// Far-future periods so nothing else in the seed data collides.
const P1 = '2030-01';
const P2 = '2030-02';

let salaryEmpId, contractEmpId;

before(async () => {
  const r = await agent.post('/login').type('form')
    .send({ email: 'owner@portal.local', password: 'admin123' });
  assert.strictEqual(r.status, 302, 'login should redirect');
});

test('create salary + contract employees', async () => {
  let r = await agent.post('/hr/employees').type('form').send({
    code: 'HRT001', name: 'HRTest Salary', employee_type: 'salary',
    department: 'sales', base_salary: '31000', km_rate: '5',
  });
  assert.strictEqual(r.status, 302);
  r = await agent.post('/hr/employees').type('form').send({
    code: 'HRT002', name: 'HRTest Contract', employee_type: 'contract',
    per_piece_rate: '4',
  });
  assert.strictEqual(r.status, 302);
  salaryEmpId   = db.prepare("SELECT id FROM employees WHERE code='HRT001'").get().id;
  contractEmpId = db.prepare("SELECT id FROM employees WHERE code='HRT002'").get().id;
  assert.ok(salaryEmpId && contractEmpId);
});

test('attendance: mark salary employee present', async () => {
  // 2030-01 has 31 days. Mark 20 present + 1 half day + 2 leave.
  // Remaining 8 unmarked → absent. paidDays = 20 + 0.5 + 2 = 22.5.
  const trx = [];
  for (let d = 1; d <= 20; d++) trx.push([`2030-01-${String(d).padStart(2,'0')}`, 'present']);
  trx.push(['2030-01-21', 'half_day']);
  trx.push(['2030-01-22', 'leave'], ['2030-01-23', 'leave']);
  for (const [date, status] of trx) {
    const r = await agent.post('/hr/attendance').type('form')
      .send({ attendance_date: date, employee_id: salaryEmpId, status });
    assert.strictEqual(r.status, 302);
  }
});

test('piece work: contract employee logs 500 + 300 pcs', async () => {
  let r = await agent.post('/hr/pieces').type('form').send({
    employee_id: contractEmpId, work_date: '2030-01-10', qty_pieces: '500', rate_per_piece: '4',
  });
  assert.strictEqual(r.status, 302);
  r = await agent.post('/hr/pieces').type('form').send({
    employee_id: contractEmpId, work_date: '2030-01-15', qty_pieces: '300', rate_per_piece: '3.5',
  });
  assert.strictEqual(r.status, 302);
  const total = db.prepare("SELECT COALESCE(SUM(total_amount),0) AS v FROM employee_pieces WHERE employee_id=?").get(contractEmpId).v;
  assert.strictEqual(total, 500*4 + 300*3.5);   // 2000 + 1050 = 3050
});

test('piece work: negative qty rejected', async () => {
  await agent.post('/hr/pieces').type('form').send({
    employee_id: contractEmpId, work_date: '2030-01-16', qty_pieces: '-50', rate_per_piece: '4',
  });
  const bad = db.prepare("SELECT COUNT(*) AS n FROM employee_pieces WHERE qty_pieces < 0").get().n;
  assert.strictEqual(bad, 0, 'negative piece rows must not be stored');
});

test('KM log for salary employee', async () => {
  const r = await agent.post('/hr/km').type('form').send({
    employee_id: salaryEmpId, log_date: '2030-01-12', km: '100', rate_per_km: '5',
  });
  assert.strictEqual(r.status, 302);
  const v = db.prepare("SELECT COALESCE(SUM(amount),0) AS v FROM employee_km_log WHERE employee_id=?").get(salaryEmpId).v;
  assert.strictEqual(v, 500);
});

test('advance + incentive for contract employee', async () => {
  let r = await agent.post('/hr/advances').type('form').send({
    employee_id: contractEmpId, advance_date: '2030-01-05', amount: '1000',
  });
  assert.strictEqual(r.status, 302);
  r = await agent.post('/hr/incentives').type('form').send({
    employee_id: contractEmpId, period: P1, amount: '500', reason: 'festival bonus',
  });
  assert.strictEqual(r.status, 302);
});

test('selective payroll generation computes both slips correctly', async () => {
  const r = await agent.post('/hr/payroll/generate').type('form')
    .send({ period: P1, employee_ids: [salaryEmpId, contractEmpId] });
  assert.strictEqual(r.status, 302);

  // Contract slip: base 0 + pieces 3050 + incentive 500 = gross 3550,
  // advance 1000 → net 2550.
  const c = db.prepare('SELECT * FROM salary_payments WHERE employee_id=? AND period=?').get(contractEmpId, P1);
  assert.ok(c, 'contract slip exists');
  assert.strictEqual(c.base_amount, 0);
  assert.strictEqual(c.piece_amount, 3050);
  assert.strictEqual(c.incentive_amount, 500);
  assert.strictEqual(c.gross, 3550);
  assert.strictEqual(c.advance_deducted, 1000);
  assert.strictEqual(c.net_paid, 2550);

  // Salary slip: 31000 × (22.5 / 31) + km 500. No advance.
  const s = db.prepare('SELECT * FROM salary_payments WHERE employee_id=? AND period=?').get(salaryEmpId, P1);
  assert.ok(s, 'salary slip exists');
  const expectedBase = 31000 * (22.5 / 31);
  assert.ok(Math.abs(s.base_amount - expectedBase) < 0.01, `base ${s.base_amount} ≈ ${expectedBase}`);
  assert.strictEqual(s.km_amount, 500);
  assert.strictEqual(s.advance_deducted, 0);

  // Incentive must be LINKED to the contract slip at generation.
  const inc = db.prepare('SELECT * FROM employee_incentives WHERE employee_id=? AND period=?').get(contractEmpId, P1);
  assert.strictEqual(inc.applied_to_salary_id, c.id, 'incentive linked at generation');
});

test('incentive added after generation stays pending; recalc pulls it in', async () => {
  await agent.post('/hr/incentives').type('form').send({
    employee_id: contractEmpId, period: P1, amount: '200', reason: 'late addition',
  });
  const late = db.prepare("SELECT * FROM employee_incentives WHERE reason='late addition'").get();
  assert.strictEqual(late.applied_to_salary_id, null, 'late incentive must stay unlinked until recalc');

  const slip = db.prepare('SELECT * FROM salary_payments WHERE employee_id=? AND period=?').get(contractEmpId, P1);
  const r = await agent.post(`/hr/payroll/${slip.id}/recalc`).type('form').send({});
  assert.strictEqual(r.status, 302);
  const after = db.prepare('SELECT * FROM salary_payments WHERE id=?').get(slip.id);
  assert.strictEqual(after.incentive_amount, 700, 'recalc must include the late incentive');
  assert.strictEqual(after.gross, 3750);
  assert.strictEqual(after.net_paid, 2750);
  const lateAfter = db.prepare('SELECT * FROM employee_incentives WHERE id=?').get(late.id);
  assert.strictEqual(lateAfter.applied_to_salary_id, slip.id, 'recalc links the late incentive');
});

test('ADVANCE DOUBLE-DEDUCTION GUARD: paying a stale slip shrinks the deduction', async () => {
  // P2 needs earnings, otherwise the deduction correctly caps at a
  // gross of zero and the scenario can't reproduce.
  let r = await agent.post('/hr/pieces').type('form').send({
    employee_id: contractEmpId, work_date: '2030-02-10', qty_pieces: '400', rate_per_piece: '4',
  });
  assert.strictEqual(r.status, 302);
  // Generate a P2 slip — it deducts the SAME ₹1000 advance (still open).
  r = await agent.post('/hr/payroll/generate').type('form')
    .send({ period: P2, employee_ids: [contractEmpId] });
  assert.strictEqual(r.status, 302);
  const p2 = db.prepare('SELECT * FROM salary_payments WHERE employee_id=? AND period=?').get(contractEmpId, P2);
  assert.strictEqual(p2.advance_deducted, 1000, 'P2 draft also grabbed the open advance');

  // Pay P1 — recovers the full ₹1000.
  const p1 = db.prepare('SELECT * FROM salary_payments WHERE employee_id=? AND period=?').get(contractEmpId, P1);
  r = await agent.post(`/hr/payroll/${p1.id}/pay`).type('form').send({ paid_date: '2030-02-01' });
  assert.strictEqual(r.status, 302);
  const advAfterP1 = db.prepare("SELECT COALESCE(SUM(balance),0) AS v FROM employee_advances WHERE employee_id=? AND status!='cleared'").get(contractEmpId).v;
  assert.strictEqual(advAfterP1, 0, 'advance fully recovered by P1');

  // Pay P2 — the stale ₹1000 deduction MUST be adjusted to ₹0 so the
  // employee is not shorted (this was the bug).
  r = await agent.post(`/hr/payroll/${p2.id}/pay`).type('form').send({ paid_date: '2030-03-01' });
  assert.strictEqual(r.status, 302);
  const p2After = db.prepare('SELECT * FROM salary_payments WHERE id=?').get(p2.id);
  assert.strictEqual(p2After.advance_deducted, 0, 'stale deduction zeroed at pay');
  assert.strictEqual(p2After.net_paid, p2After.gross, 'net restored to full gross');
  // And no phantom repayment rows were written for P2.
  const phantomRepay = db.prepare('SELECT COUNT(*) AS n FROM employee_advance_repayments WHERE salary_payment_id=?').get(p2.id).n;
  assert.strictEqual(phantomRepay, 0);
});

test('paid-month guards: cannot delete piece work or add without warning', async () => {
  // P1 slip for contract emp is PAID now. Deleting its piece rows must be blocked.
  const piece = db.prepare('SELECT * FROM employee_pieces WHERE employee_id=? LIMIT 1').get(contractEmpId);
  await agent.post(`/hr/pieces/${piece.id}/delete`).type('form').send({});
  const still = db.prepare('SELECT COUNT(*) AS n FROM employee_pieces WHERE id=?').get(piece.id).n;
  assert.strictEqual(still, 1, 'piece row from a paid month must survive delete attempts');
});

test('paid slip cannot be deleted or recalculated', async () => {
  const p1 = db.prepare('SELECT * FROM salary_payments WHERE employee_id=? AND period=?').get(contractEmpId, P1);
  await agent.post(`/hr/payroll/${p1.id}/delete`).type('form').send({});
  assert.ok(db.prepare('SELECT id FROM salary_payments WHERE id=?').get(p1.id), 'paid slip survives delete');
  await agent.post(`/hr/payroll/${p1.id}/recalc`).type('form').send({});
  const after = db.prepare('SELECT * FROM salary_payments WHERE id=?').get(p1.id);
  assert.strictEqual(after.net_paid, 2750, 'paid slip amounts unchanged after recalc attempt');
});

test('draft slip delete unlinks incentives for re-use', async () => {
  // New incentive + slip in P2... P2 already paid. Use a third period.
  const P3 = '2030-03';
  await agent.post('/hr/incentives').type('form').send({
    employee_id: contractEmpId, period: P3, amount: '300', reason: 'p3 bonus',
  });
  await agent.post('/hr/payroll/generate').type('form').send({ period: P3, employee_ids: [contractEmpId] });
  const slip = db.prepare('SELECT * FROM salary_payments WHERE employee_id=? AND period=?').get(contractEmpId, P3);
  assert.strictEqual(slip.incentive_amount, 300);
  const inc = db.prepare("SELECT * FROM employee_incentives WHERE reason='p3 bonus'").get();
  assert.strictEqual(inc.applied_to_salary_id, slip.id);

  await agent.post(`/hr/payroll/${slip.id}/delete`).type('form').send({});
  const incAfter = db.prepare('SELECT * FROM employee_incentives WHERE id=?').get(inc.id);
  assert.strictEqual(incAfter.applied_to_salary_id, null, 'incentive freed when draft slip deleted');
});

test('advance repayment is capped at open balance', async () => {
  await agent.post('/hr/advances').type('form').send({
    employee_id: salaryEmpId, advance_date: '2030-01-20', amount: '2000',
  });
  const adv = db.prepare('SELECT * FROM employee_advances WHERE employee_id=? ORDER BY id DESC LIMIT 1').get(salaryEmpId);
  await agent.post(`/hr/advances/${adv.id}/repay`).type('form').send({ amount: '5000' });
  const after = db.prepare('SELECT * FROM employee_advances WHERE id=?').get(adv.id);
  assert.strictEqual(after.balance, 0);
  assert.strictEqual(after.status, 'cleared');
  const repaid = db.prepare('SELECT COALESCE(SUM(amount),0) AS v FROM employee_advance_repayments WHERE advance_id=?').get(adv.id).v;
  assert.strictEqual(repaid, 2000, 'repayment row capped at the real balance, not the typed 5000');
});

test('slip detail + payroll register pages render with print markup', async () => {
  const slip = db.prepare('SELECT * FROM salary_payments WHERE employee_id=? AND period=?').get(contractEmpId, P1);
  let r = await agent.get(`/hr/payroll/${slip.id}`);
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /SALARY SLIP/);
  assert.match(r.text, /Authorised Signatory/);
  assert.match(r.text, /Amount in words/);
  assert.match(r.text, /Two Thousand Seven Hundred Fifty Rupees Only/);

  r = await agent.get('/hr/payroll?period=' + P1);
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /SALARY REGISTER/);
  assert.match(r.text, /Print Register/);
});

test('work-types update without name does not crash', async () => {
  await agent.post('/hr/work-types').type('form').send({ name: 'Stitch-Test', default_rate: '2' });
  const wt = db.prepare("SELECT * FROM work_types WHERE name='Stitch-Test'").get();
  const r = await agent.post(`/hr/work-types/${wt.id}`).type('form').send({ default_rate: '3' });
  assert.strictEqual(r.status, 302, 'missing name redirects with flash, not 500');
  const after = db.prepare('SELECT * FROM work_types WHERE id=?').get(wt.id);
  assert.strictEqual(after.name, 'Stitch-Test', 'name unchanged');
});
