const { db } = require('../db');

const LEVEL_ORDER = { none: 0, view: 1, limited: 2, full: 3 };

// Feature inheritance: a sub-feature's effective level falls back to its
// parent's level when no row exists for the sub-key. Lets us split coarse
// keys (hr, reports, sales, settings) into finer ones without breaking any
// existing route guards (e.g. requireFeature('hr') still works).
const FEATURE_PARENTS = {
  hr_employees:           'hr',
  hr_attendance:          'hr',
  hr_payroll:             'hr',
  reports_sales:          'reports',
  reports_production:     'reports',
  reports_finance:        'reports',
  sales_orders:           'sales',
  sales_invoices:         'sales',
  settings_users:         'settings',
  settings_access:        'settings',
  settings_payment_modes: 'settings',
  settings_categories:    'settings',
  settings_sms:           'settings',
  settings_stages:        'settings',
  settings_import:        'settings',
};

// Effective level for a user. Lookup order:
//   1. user_permissions[userId][feature]    (per-user override)
//   2. user_permissions[userId][parent]      (override on the umbrella key)
//   3. role_permissions[role][feature]
//   4. role_permissions[role][parent]
//   5. 'none'
// `userIdOrUser` may be either a numeric user id or a user object {id, role}.
// Backward-compat: if a string role is passed (legacy callers), only checks
// role_permissions (no per-user overrides — those need a user id).
function getUserLevel(userIdOrUser, featureKey) {
  let userId = null, role = null;
  if (typeof userIdOrUser === 'string') {
    role = userIdOrUser; // legacy: getUserLevel('admin', 'hr')
  } else if (userIdOrUser && typeof userIdOrUser === 'object') {
    userId = userIdOrUser.id;
    role = userIdOrUser.role;
  }
  if (!role) return 'none';
  if (role === 'owner') return 'full';
  const parent = FEATURE_PARENTS[featureKey];
  // 1. per-user override (specific feature)
  if (userId) {
    const ur = db.prepare('SELECT level FROM user_permissions WHERE user_id=? AND feature_key=?').get(userId, featureKey);
    if (ur) return ur.level;
    // 2. per-user override (parent feature)
    if (parent) {
      const upr = db.prepare('SELECT level FROM user_permissions WHERE user_id=? AND feature_key=?').get(userId, parent);
      if (upr) return upr.level;
    }
  }
  // 3. role default for this feature
  const r = db.prepare('SELECT level FROM role_permissions WHERE role=? AND feature_key=?').get(role, featureKey);
  if (r) return r.level;
  // 4. role default for parent
  if (parent) {
    const pr = db.prepare('SELECT level FROM role_permissions WHERE role=? AND feature_key=?').get(role, parent);
    if (pr) return pr.level;
  }
  return 'none';
}

// Effective permissions for a user: role defaults + per-user overrides,
// with sub-feature inheritance from parent. The map returned here drives
// the sidebar `has(feature)` checks and any view-side `perms.foo` lookups.
function getAllPermsForUser(userOrRole) {
  // Accept either a user object {id, role} or a bare role string (legacy).
  let userId = null, role = null;
  if (typeof userOrRole === 'string') {
    role = userOrRole;
  } else if (userOrRole && typeof userOrRole === 'object') {
    userId = userOrRole.id;
    role = userOrRole.role;
  }
  if (role === 'owner') {
    const out = {};
    db.prepare('SELECT DISTINCT feature_key FROM role_permissions').all().forEach(r => { out[r.feature_key] = 'full'; });
    Object.keys(FEATURE_PARENTS).forEach(k => { if (!out[k]) out[k] = 'full'; });
    return out;
  }
  const out = {};
  // 1. role defaults
  db.prepare('SELECT feature_key, level FROM role_permissions WHERE role=?').all(role || '')
    .forEach(r => { out[r.feature_key] = r.level; });
  // 2. inherit sub-features from parent before overrides apply
  Object.entries(FEATURE_PARENTS).forEach(([sub, parent]) => {
    if (out[sub] === undefined && out[parent] !== undefined) out[sub] = out[parent];
  });
  // 3. per-user overrides win
  if (userId) {
    db.prepare('SELECT feature_key, level FROM user_permissions WHERE user_id=?').all(userId)
      .forEach(r => { out[r.feature_key] = r.level; });
    // overrides on a parent cascade to subs that haven't been explicitly set
    Object.entries(FEATURE_PARENTS).forEach(([sub, parent]) => {
      const hadOverride = db.prepare('SELECT 1 FROM user_permissions WHERE user_id=? AND feature_key=?').get(userId, sub);
      if (!hadOverride) {
        const parentOverride = db.prepare('SELECT level FROM user_permissions WHERE user_id=? AND feature_key=?').get(userId, parent);
        if (parentOverride) out[sub] = parentOverride.level;
      }
    });
  }
  return out;
}
// Backward-compatible alias (some callers just pass a role string).
function getAllPermsForRole(role) { return getAllPermsForUser(role); }

// Middleware: blocks access if user's level for this feature is below minLevel.
function requireFeature(featureKey, minLevel = 'view') {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    const level = getUserLevel(req.session.user, featureKey);
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
  sales_orders:   'limited',  // salesperson can draft orders for their dealers
  sales_invoices: 'full',     // GST invoices are tighter — accountant/admin only by default
  payments:      'limited',  // salesperson can record payments
  dispatch:      'full',
  reports:       'full',
  reports_sales:      'full',
  reports_production: 'full',
  reports_finance:    'full',
  notifications: 'limited',
  settings:      'full',
  settings_users:         'full',
  settings_access:        'full',
  settings_payment_modes: 'full',
  settings_categories:    'full',
  settings_sms:           'full',
  settings_stages:        'full',
  settings_import:        'full',
  purchasing:    'full',
  activity:      'full',  // read-only for everyone — there are no POST routes anyway
  hr:            'full',
  hr_employees:  'full',
  hr_attendance: 'limited',  // operational; supervisors can mark attendance for their teams
  hr_payroll:    'full',     // money operations — accountant/admin only by default
  visits:        'limited',  // salespersons can log their own visits
  catalogue:     'full',     // generating costs real money — keep tight
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

// Helper for templates: can this user write this feature? Accepts a user
// object {id, role} for full per-user override support; falls back to role
// string for legacy callers.
function canWrite(userOrRole, featureKey) {
  const min = WRITE_MIN_LEVEL[featureKey] || 'full';
  return LEVEL_ORDER[getUserLevel(userOrRole, featureKey)] >= LEVEL_ORDER[min];
}

module.exports = {
  getUserLevel,
  getAllPermsForRole,   // legacy
  getAllPermsForUser,   // preferred — respects per-user overrides
  requireFeature, requireFullAccess, requireWrite, canWrite,
  WRITE_MIN_LEVEL, LEVEL_ORDER, FEATURE_PARENTS,
};
