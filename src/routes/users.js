const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { requireRole, flash } = require('../middleware/auth');

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

router.use(requireRole('admin'));

router.get('/', (req, res) => {
  const users = db.prepare('SELECT id,name,email,phone,role,active,created_at FROM users ORDER BY id').all();
  res.render('users/index', { title: 'Users', users });
});

router.get('/new', (req, res) => res.render('users/form', { title: 'New User', u: null }));

router.post('/', (req, res) => {
  const { name, email, phone, role, password } = req.body;
  if (!password || password.length < 6) { flash(req, 'danger', 'Password >= 6 chars'); return res.redirect('/users/new'); }
  try {
    const r = db.prepare('INSERT INTO users (name,email,phone,role,password_hash) VALUES (?,?,?,?,?)')
      .run(name, email, phone || null, role, bcrypt.hashSync(password, 10));
    req.audit('create', 'user', r.lastInsertRowid, `${email} (role: ${role})`);
    flash(req, 'success', 'User created.');
    res.redirect('/users');
  } catch (e) {
    flash(req, 'danger', e.message); res.redirect('/users/new');
  }
});

router.get('/:id/edit', (req, res) => {
  const u = db.prepare('SELECT id,name,email,phone,role,active FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.redirect('/users');
  res.render('users/form', { title: 'Edit User', u });
});

router.post('/:id', (req, res) => {
  const { name, email, phone, role, active, password } = req.body;
  const fields = ['name=?','email=?','phone=?','role=?','active=?','updated_at=datetime(\'now\')'];
  const vals = [name, email, phone || null, role, active ? 1 : 0];
  if (password) { fields.push('password_hash=?'); vals.push(bcrypt.hashSync(password, 10)); }
  vals.push(req.params.id);
  db.prepare(`UPDATE users SET ${fields.join(',')} WHERE id=?`).run(...vals);
  req.audit('update', 'user', req.params.id, `${email} role=${role} active=${active ? 1 : 0}${password ? ' (password changed)' : ''}`);
  flash(req, 'success', 'User updated.'); res.redirect('/users');
});

module.exports = router;
