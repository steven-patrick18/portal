// Responsibilities / KRA per role. Owner/admin manage the definitions here;
// every user sees their own role's list as a login welcome popup + a floating
// "My KRA" bubble (rendered globally — see app.js res.locals + the partial).
const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const router = express.Router();

// Cached active list grouped by role (tiny table; invalidated on edit).
let _cache = null;
function allActive() {
  if (_cache) return _cache;
  const byRole = {};
  db.prepare('SELECT id, role, area, detail, sort_order FROM kra_responsibilities WHERE active=1 ORDER BY role, sort_order, id')
    .all().forEach(r => { (byRole[r.role] = byRole[r.role] || []).push(r); });
  _cache = byRole;
  return _cache;
}
function getForRole(role) { return allActive()[role] || []; }
function invalidate() { _cache = null; }

router.get('/', (req, res) => {
  const byRole = {};
  db.prepare('SELECT * FROM kra_responsibilities ORDER BY role, sort_order, id')
    .all().forEach(r => { (byRole[r.role] = byRole[r.role] || []).push(r); });
  let roles = [];
  try { roles = db.prepare('SELECT role_key, label FROM roles ORDER BY role_key').all(); }
  catch (_) { roles = Object.keys(byRole).map(r => ({ role_key: r, label: r })); }
  res.render('kra/index', { title: 'Responsibilities (KRA)', byRole, roles });
});

router.post('/', (req, res) => {            // add
  const role = (req.body.role || '').trim();
  const area = (req.body.area || '').trim();
  if (!role || !area) { flash(req, 'danger', 'Pick a role and enter a responsibility.'); return res.redirect('/kra'); }
  const max = db.prepare('SELECT COALESCE(MAX(sort_order),0) m FROM kra_responsibilities WHERE role=?').get(role).m;
  db.prepare('INSERT INTO kra_responsibilities (role,area,detail,sort_order) VALUES (?,?,?,?)')
    .run(role, area, (req.body.detail || '').trim() || null, max + 1);
  invalidate();
  req.audit('create', 'kra', null, `${role}: "${area}"`);
  flash(req, 'success', 'Responsibility added.');
  res.redirect('/kra#' + role);
});

router.post('/:id', (req, res) => {         // edit / reorder / toggle
  const k = db.prepare('SELECT * FROM kra_responsibilities WHERE id=?').get(req.params.id);
  if (!k) { flash(req, 'danger', 'Not found.'); return res.redirect('/kra'); }
  const area = (req.body.area || '').trim() || k.area;
  const active = req.body.active === '0' ? 0 : (req.body.active === '1' ? 1 : k.active);
  const sort = req.body.sort_order != null && req.body.sort_order !== '' ? parseInt(req.body.sort_order) : k.sort_order;
  db.prepare("UPDATE kra_responsibilities SET area=?, detail=?, active=?, sort_order=?, updated_at=datetime('now') WHERE id=?")
    .run(area, (req.body.detail || '').trim() || null, active, sort, k.id);
  invalidate();
  req.audit('update', 'kra', k.id, `${k.role}: "${area}"`);
  flash(req, 'success', 'Updated.');
  res.redirect('/kra#' + k.role);
});

router.post('/:id/delete', (req, res) => {
  const k = db.prepare('SELECT * FROM kra_responsibilities WHERE id=?').get(req.params.id);
  if (k) { db.prepare('DELETE FROM kra_responsibilities WHERE id=?').run(k.id); invalidate(); req.audit('delete', 'kra', k.id, `${k.role}: "${k.area}"`); flash(req, 'success', 'Removed.'); }
  res.redirect('/kra' + (k ? '#' + k.role : ''));
});

module.exports = router;
module.exports.getForRole = getForRole;
module.exports.invalidate = invalidate;
