const { db } = require('../db');

const LEVEL_ORDER = { none: 0, view: 1, limited: 2, full: 3 };

function getUserLevel(role, featureKey) {
  if (!role) return 'none';
  if (role === 'owner') return 'full';
  const r = db.prepare('SELECT level FROM role_permissions WHERE role=? AND feature_key=?').get(role, featureKey);
  return r ? r.level : 'none';
}

function getAllPermsForRole(role) {
  if (role === 'owner') {
    const out = {};
    db.prepare('SELECT DISTINCT feature_key FROM role_permissions').all().forEach(r => { out[r.feature_key] = 'full'; });
    return out;
  }
  const rows = db.prepare('SELECT feature_key, level FROM role_permissions WHERE role=?').all(role);
  const out = {};
  rows.forEach(r => { out[r.feature_key] = r.level; });
  return out;
}

// Middleware: blocks access if user's level for this feature is below minLevel.
function requireFeature(featureKey, minLevel = 'view') {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    const level = getUserLevel(req.session.user.role, featureKey);
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) {
      // For modify operations, send 403 JSON; for GET, render error page
      if (req.method === 'GET' && !req.xhr) {
        return res.status(403).render('error', {
          title: 'Access Denied',
          message: `Your role (${req.session.user.role}) doesn't have access to this section.`,
          code: 403,
        });
      }
      return res.status(403).json({ error: 'forbidden', feature: featureKey, required: minLevel, your_level: level });
    }
    res.locals.userLevel = level;
    next();
  };
}

// Middleware: requires "full" level (typically for create/edit/delete)
function requireFullAccess(featureKey) {
  return requireFeature(featureKey, 'full');
}

// Per-feature minimum level required to PERFORM A WRITE (POST/PUT/DELETE).
//   'full'    = only admins/owners (and accountants if matrix grants full) can write
//   'limited' = salespersons can also write — they typically can create their own data
const WRITE_MIN_LEVEL = {
  products:      'full',
  materials:     'full',
  bom:           'full',
  production:    'full',
  fabric_costs:  'full',
  stock:         'full',
  dealers:       'limited',  // salesperson can edit their assigned dealers
  sales:         'limited',  // salesperson can create orders/invoices for their dealers
  payments:      'limited',  // salesperson can record payments
  dispatch:      'full',
  reports:       'full',
  notifications: 'limited',
  settings:      'full',
  purchasing:    'full',
  activity:      'full',  // read-only for everyone — there are no POST routes anyway
};

// Middleware: GET requests pass through (already gated by requireFeature).
// Non-GET methods are blocked unless user meets WRITE_MIN_LEVEL[featureKey].
function requireWrite(featureKey) {
  const minLevel = WRITE_MIN_LEVEL[featureKey] || 'full';
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    return requireFeature(featureKey, minLevel)(req, res, next);
  };
}

// Helper for templates: can this user write this feature?
function canWrite(role, featureKey) {
  const min = WRITE_MIN_LEVEL[featureKey] || 'full';
  return LEVEL_ORDER[getUserLevel(role, featureKey)] >= LEVEL_ORDER[min];
}

module.exports = { getUserLevel, getAllPermsForRole, requireFeature, requireFullAccess, requireWrite, canWrite, WRITE_MIN_LEVEL, LEVEL_ORDER };
