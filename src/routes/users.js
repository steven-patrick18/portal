const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { requireRole, flash } = require('../middleware/auth');
const { requireFeature, requireWrite } = require('../middleware/permissions');

const router = express.Router();

router.get('/me', (req, res) => {
  const u = db.prepare('SELECT id,name,email,phone,role,active,created_at FROM users WHERE id=?').get(req.session.user.id);
  res.render('users/profile', { title: 'My Profile', u });
});

router.post('/me/password', (req, res) => {
  const { current, password, confirm } = req.body;
  if (!password || password.length < 6) { flash(req, 'danger', 'Password must be at least 6 chars.'); return res.redirect('/users/me'); }
  if (password !== confirm) { flash(req, 'danger', 'Passwords do not match.'); return res.redirect('/users/me'); }
  const u = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.session.user.id);
  if (!bcrypt.compareSync(current || '', u.password_hash)) { flash(req, 'danger', 'Current password is incorrect.'); return res.redirect('/users/me'); }
  db.prepare('UPDATE users SET password_hash=?, updated_at=datetime(\'now\') WHERE id=?').run(bcrypt.hashSync(password,10), req.session.user.id);
  flash(req, 'success', 'Password changed.'); res.redirect('/users/me');
});

// Admin user CRUD: requires the 'admin' role AND the settings_users feature
// (so the owner can revoke user-management from a specific admin without
// stripping their whole admin role).
router.use(requireRole('admin'), requireFeature('settings_users'), requireWrite('settings_users'));

// List of active users that could be a "manager" for a Reports-To dropdown.
// Excludes the currently-edited user (if any) so a user can't report to themself.
function managerOptions(excludeId) {
  const params = [];
  let sql = "SELECT id, name, role FROM users WHERE active = 1";
  if (excludeId) { sql += " AND id <> ?"; params.push(excludeId); }
  sql += " ORDER BY name";
  return db.prepare(sql).all(...params);
}

router.get('/', (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.name, u.email, u.phone, u.role, u.active, u.created_at,
           u.reports_to, m.name AS manager_name
    FROM users u LEFT JOIN users m ON m.id = u.reports_to
    ORDER BY u.id
  `).all();
  res.render('users/index', { title: 'Users', users });
});

function rolesForForm() {
  return db.prepare('SELECT role_key, label, is_system FROM roles ORDER BY sort_order, id').all();
}

router.get('/new', (req, res) => res.render('users/form', {
  title: 'New User', u: null, managers: managerOptions(null), roles: rolesForForm(),
}));

router.post('/', (req, res) => {
  const { name, email, phone, role, password, reports_to } = req.body;
  if (!password || password.length < 6) { flash(req, 'danger', 'Password >= 6 chars'); return res.redirect('/users/new'); }
  try {
    const r = db.prepare('INSERT INTO users (name,email,phone,role,password_hash,reports_to) VALUES (?,?,?,?,?,?)')
      .run(name, email, phone || null, role, bcrypt.hashSync(password, 10), reports_to ? Number(reports_to) : null);
    req.audit('create', 'user', r.lastInsertRowid, `${email} (role: ${role})`);
    flash(req, 'success', 'User created.');
    res.redirect('/users');
  } catch (e) {
    flash(req, 'danger', e.message); res.redirect('/users/new');
  }
});

// Defense-in-depth: only the owner can edit another owner. Admins cannot
// touch owner accounts — neither password, role, active flag, nor any other
// field. The owner can still edit their own account via /users/me.
function blockIfTargetIsOwner(req, res, next) {
  const target = db.prepare('SELECT id, role FROM users WHERE id=?').get(req.params.id);
  if (!target) return res.redirect('/users');
  if (target.role === 'owner' && req.session.user.role !== 'owner') {
    flash(req, 'danger', 'Owner accounts can only be edited by the owner.');
    return res.redirect('/users');
  }
  res.locals.targetUser = target;
  next();
}

router.get('/:id/edit', blockIfTargetIsOwner, (req, res) => {
  const u = db.prepare('SELECT id,name,email,phone,role,active,reports_to FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.redirect('/users');
  res.render('users/form', { title: 'Edit User', u, managers: managerOptions(u.id), roles: rolesForForm() });
});

router.post('/:id', blockIfTargetIsOwner, (req, res) => {
  const { name, email, phone, role, active, password, reports_to } = req.body;
  // Non-owners cannot promote anyone TO owner either (would otherwise be a
  // privilege escalation: admin creates puppet, then promotes them to owner).
  const safeRole = (role === 'owner' && req.session.user.role !== 'owner') ? res.locals.targetUser.role : role;
  // Block self-reporting at the API layer too (form already excludes self, but defense-in-depth).
  const mgrId = reports_to && Number(reports_to) !== Number(req.params.id) ? Number(reports_to) : null;
  const fields = ['name=?','email=?','phone=?','role=?','active=?','reports_to=?','updated_at=datetime(\'now\')'];
  const vals = [name, email, phone || null, safeRole, active ? 1 : 0, mgrId];
  if (password) { fields.push('password_hash=?'); vals.push(bcrypt.hashSync(password, 10)); }
  vals.push(req.params.id);
  db.prepare(`UPDATE users SET ${fields.join(',')} WHERE id=?`).run(...vals);
  req.audit('update', 'user', req.params.id, `${email} role=${safeRole} active=${active ? 1 : 0}${password ? ' (password changed)' : ''}`);
  flash(req, 'success', 'User updated.'); res.redirect('/users');
});

module.exports = router;
