const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { flash } = require('../middleware/auth');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('auth/login', { title: 'Login' });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
  if (!u || !bcrypt.compareSync(password || '', u.password_hash)) {
    flash(req, 'danger', 'Invalid email or password.');
    return res.redirect('/login');
  }
  req.session.user = { id: u.id, name: u.name, email: u.email, role: u.role, phone: u.phone };
  db.prepare('INSERT INTO audit_log (user_id, action, ip) VALUES (?,?,?)').run(u.id, 'login', req.ip);
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  if (req.session.user) {
    db.prepare('INSERT INTO audit_log (user_id, action, ip) VALUES (?,?,?)').run(req.session.user.id, 'logout', req.ip);
  }
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
