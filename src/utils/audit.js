// Activity / audit logger — writes a row to audit_log per user action.
//
// Design notes:
//   • IP capture is defensive: behind nginx, `req.ip` should already be the
//     real client IP because we `app.set('trust proxy', 1)` in app.js, but
//     we additionally fall back to X-Real-IP and the leftmost X-Forwarded-For
//     entry — saw 127.0.0.1 leak through once on the live VPS, easier to
//     belt-and-braces this than chase the ghost.
//   • IPv6-mapped-IPv4 (`::ffff:1.2.3.4`) is normalised to plain IPv4 for
//     readability in the activity UI.
//   • We also record method, path, referer and user-agent so the log
//     answers "who did what, from where, in which browser" — useful for
//     security audits and for figuring out which device a salesperson was
//     using when a stale dealer record got created.
const { db } = require('../db');

// Pick the most-trustworthy client IP we can find. Each source we trust
// in turn; if multiple agree (typical) we get the same answer. Express's
// req.ip honours `trust proxy`, X-Real-IP is what nginx writes for the
// immediate client, X-Forwarded-For is the full chain (left = original).
function clientIp(req) {
  let ip = req && req.ip;
  if (!ip || ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1') {
    ip = (req.headers['x-real-ip'] || '').trim() || ip;
  }
  if (!ip || ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1') {
    const xff = (req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (xff[0]) ip = xff[0];
  }
  if (!ip) return null;
  // Normalise IPv6-mapped IPv4: ::ffff:1.2.3.4 → 1.2.3.4
  return ip.replace(/^::ffff:/, '');
}

// Extract everything worth logging from the request in one shot.
function clientInfo(req) {
  const xff = req.headers['x-forwarded-for'] || '';
  return {
    ip:            clientIp(req),
    user_agent:    String(req.headers['user-agent'] || '').slice(0, 500),
    method:        req.method,
    path:          (req.originalUrl || req.url || '').slice(0, 300),
    referer:       String(req.headers['referer'] || req.headers['referrer'] || '').slice(0, 300),
    forwarded_for: String(xff).slice(0, 300),
  };
}

function logActivity(userId, action, entity, entityId, details, info) {
  info = info || {};
  try {
    db.prepare(`INSERT INTO audit_log
        (user_id, action, entity, entity_id, details, ip, user_agent, method, path, referer, forwarded_for)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        userId || null,
        String(action || '').slice(0, 60),
        entity || null,
        entityId || null,
        details ? String(details).slice(0, 500) : null,
        info.ip || null,
        info.user_agent || null,
        info.method || null,
        info.path || null,
        info.referer || null,
        info.forwarded_for || null,
      );
  } catch (e) {
    // Never break the request because of a logging failure
    console.error('audit log failed:', e.message);
  }
}

// Express middleware — attaches req.audit(action, entity, entityId, details)
// AND exposes req.clientInfo so auth login/logout (which run before the
// session is set up by other route handlers) can use it directly.
function auditMiddleware(req, res, next) {
  req.clientInfo = clientInfo(req);
  req.audit = (action, entity, entityId, details) => {
    if (!req.session || !req.session.user) return;
    logActivity(req.session.user.id, action, entity, entityId, details, req.clientInfo);
  };
  next();
}

module.exports = { logActivity, auditMiddleware, clientInfo, clientIp };
