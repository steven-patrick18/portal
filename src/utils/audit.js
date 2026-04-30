// Lightweight activity logger. Writes to audit_log table.
// Use either logActivity(userId, action, entity, entityId, details, ip)
// or via req.audit(action, entity, entityId, details) which auto-fills user + ip.
const { db } = require('../db');

function logActivity(userId, action, entity, entityId, details, ip) {
  try {
    db.prepare(`INSERT INTO audit_log (user_id, action, entity, entity_id, details, ip) VALUES (?,?,?,?,?,?)`)
      .run(userId || null, String(action || '').slice(0, 60), entity || null, entityId || null,
           details ? String(details).slice(0, 500) : null, ip || null);
  } catch (e) {
    // Never break the request because of a logging failure
    console.error('audit log failed:', e.message);
  }
}

// Express middleware: attaches req.audit(action, entity, entityId, details)
function auditMiddleware(req, res, next) {
  req.audit = (action, entity, entityId, details) => {
    if (!req.session || !req.session.user) return;
    logActivity(req.session.user.id, action, entity, entityId, details, req.ip);
  };
  next();
}

module.exports = { logActivity, auditMiddleware };
