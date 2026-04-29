function requireAuth(req, res, next) {
  if (!req.session.user) {
    if (req.method === 'GET' && !req.xhr) {
      return res.redirect('/login');
    }
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    const u = req.session.user;
    if (!u) return res.redirect('/login');
    if (!roles.includes(u.role) && u.role !== 'owner') {
      return res.status(403).render('error', {
        title: 'Forbidden',
        message: `Your role (${u.role}) cannot access this page.`,
        code: 403,
      });
    }
    next();
  };
}

function flash(req, type, message) {
  req.session.flash = { type, message };
}

module.exports = { requireAuth, requireRole, flash };
