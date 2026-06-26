// Tracks background bulk-SMS sends (broadcast / ledger / survey push) so the
// UI can poll live progress instead of blocking the request for ~80s.
const { db } = require('../db');

function create({ kind, label, total, userId }) {
  return db.prepare('INSERT INTO sms_jobs (kind,label,total,created_by) VALUES (?,?,?,?)')
    .run(kind || 'broadcast', label || null, total || 0, userId || null).lastInsertRowid;
}
function setTotal(id, total) { db.prepare('UPDATE sms_jobs SET total=? WHERE id=?').run(total, id); }
function bump(id, field) {
  if (!['sent', 'skipped', 'failed'].includes(field)) return;
  db.prepare(`UPDATE sms_jobs SET ${field}=${field}+1 WHERE id=?`).run(id);
}
function finish(id, status, error) {
  db.prepare("UPDATE sms_jobs SET status=?, error=?, finished_at=datetime('now') WHERE id=?")
    .run(status || 'done', error || null, id);
}
function get(id) { return db.prepare('SELECT * FROM sms_jobs WHERE id=?').get(id); }
function recent(n) { return db.prepare('SELECT * FROM sms_jobs ORDER BY id DESC LIMIT ?').all(n || 8); }

module.exports = { create, setTotal, bump, finish, get, recent };
