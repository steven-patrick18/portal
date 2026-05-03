const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { logActivity, clientInfo } = require('../utils/audit');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  // Only expose seed-account hints in non-production environments — never in prod.
  res.render('auth/login', { title: 'Login', showDevHints: process.env.NODE_ENV !== 'production' });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const info = clientInfo(req);
  const u = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
  if (!u || !bcrypt.compareSync(password || '', u.password_hash)) {
    // Record failed login attempts too — useful for spotting brute-force.
    // user_id is null here because we don't have a verified user yet.
    logActivity(null, 'login_failed', 'auth', null, 'email=' + (email || '(empty)'), info);
    flash(req, 'danger', 'Invalid email or password.');
    return res.redirect('/login');
  }
  req.session.user = { id: u.id, name: u.name, email: u.email, role: u.role, phone: u.phone };
  logActivity(u.id, 'login', 'auth', u.id, null, info);
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  if (req.session.user) {
    logActivity(req.session.user.id, 'logout', 'auth', req.session.user.id, null, clientInfo(req));
  }
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
