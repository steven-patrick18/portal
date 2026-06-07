// Team-scope helper for the area_manager role.
//
// Owner / admin / accountant see everything.
// area_manager sees their own data plus the data of every user whose
// users.reports_to = manager.id (their direct reports).
// salesperson and every other role see only their own data.
//
// All scoping in route handlers should go through getScopeUserIds() or
// scopeWhere() instead of hardcoding `role === 'salesperson'` checks —
// otherwise the area_manager will see nothing.

const { db } = require('../db');

const FULL_VISIBILITY_ROLES = new Set(['owner', 'admin', 'accountant']);

// Returns the array of user IDs that THIS user can see data for, or
// `null` when the user has full visibility (no filter needed).
//
//   owner/admin/accountant → null
//   area_manager           → [self.id, ...directReports]
//   anyone else            → [self.id]
//
// The result is cached on `req.scopeUserIds` for the lifetime of the
// request to avoid repeated DB hits.
function getScopeUserIds(req) {
  if (!req.session || !req.session.user) return [];
  if (req.scopeUserIds !== undefined) return req.scopeUserIds;
  const u = req.session.user;
  if (FULL_VISIBILITY_ROLES.has(u.role)) {
    req.scopeUserIds = null;
    return null;
  }
  if (u.role === 'area_manager') {
    const reports = db.prepare('SELECT id FROM users WHERE reports_to = ? AND active = 1').all(u.id).map(r => r.id);
    req.scopeUserIds = [u.id, ...reports];
    return req.scopeUserIds;
  }
  req.scopeUserIds = [u.id];
  return req.scopeUserIds;
}

// Build a SQL WHERE fragment that scopes the given column to this user's
// team. Returns `{ where, params }`.
//
//   - For full-visibility roles: { where: '1=1', params: [] }
//   - For everyone else: { where: 'col IN (?,?,...)', params: [...ids] }
//
// `column` should be the fully-qualified column name on a JOINable table,
// e.g. 'i.salesperson_id', 'v.salesperson_id', 'd.salesperson_id',
// 'p.salesperson_id', or for created_by tables, 't.assigned_to'.
function scopeWhere(req, column) {
  const ids = getScopeUserIds(req);
  if (ids === null) return { where: '1=1', params: [] };
  if (ids.length === 0) return { where: '0=1', params: [] };
  const placeholders = ids.map(() => '?').join(',');
  return { where: `${column} IN (${placeholders})`, params: ids };
}

// True when this user has unlimited (no-filter) visibility.
function hasFullVisibility(req) {
  return getScopeUserIds(req) === null;
}

// True when `targetUserId` is in this user's team scope (or full-visibility).
// Used by edit/show handlers to gate access to a single record.
function isInScope(req, targetUserId) {
  const ids = getScopeUserIds(req);
  if (ids === null) return true;
  return ids.includes(Number(targetUserId));
}

// Returns the user IDs that show up in the salesperson dropdown for this
// user — owner/admin see every active salesperson + area_manager;
// an area_manager only sees themselves + their direct reports;
// salesperson sees only themselves.
function visibleSalespersons(req) {
  const ids = getScopeUserIds(req);
  if (ids === null) {
    return db.prepare("SELECT id, name, role FROM users WHERE active = 1 AND role IN ('salesperson','area_manager') ORDER BY name").all();
  }
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`SELECT id, name, role FROM users WHERE active = 1 AND id IN (${placeholders}) ORDER BY name`).all(...ids);
}

// Returns the IDs of users tied to a given office (Phase 3 office filter).
// Used by list/report routes that take an optional ?office=<id> query param:
// only rows whose salesperson belongs to that office come through.
function userIdsForOffice(officeId) {
  if (!officeId) return null;
  return db.prepare('SELECT id FROM users WHERE active=1 AND home_office_id=?').all(officeId).map(r => r.id);
}

// Lists active offices for the office-filter dropdown. The filter is
// only useful to roles with full visibility (otherwise their team scope
// already restricts what they see) — return [] for other roles so the
// dropdown isn't even rendered.
function visibleOffices(req) {
  const u = req.session && req.session.user;
  if (!u || !FULL_VISIBILITY_ROLES.has(u.role)) return [];
  return db.prepare("SELECT id, code, name, type, city FROM locations WHERE active=1 ORDER BY type, name").all();
}

module.exports = {
  getScopeUserIds,
  scopeWhere,
  hasFullVisibility,
  isInScope,
  visibleSalespersons,
  userIdsForOffice,
  visibleOffices,
  FULL_VISIBILITY_ROLES,
};
