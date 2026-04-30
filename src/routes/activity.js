const express = require('express');
const { db } = require('../db');
const { todayLocal } = require('../utils/format');
const router = express.Router();

router.get('/', (req, res) => {
  const { user, action, entity, from, to, q, page } = req.query;
  const where = [];
  const params = [];
  if (user)   { where.push('al.user_id = ?');     params.push(user); }
  if (action) { where.push('al.action = ?');      params.push(action); }
  if (entity) { where.push('al.entity = ?');      params.push(entity); }
  if (from)   { where.push('al.created_at >= ?'); params.push(from + ' 00:00:00'); }
  if (to)     { where.push('al.created_at <= ?'); params.push(to + ' 23:59:59'); }
  if (q)      { where.push('(al.details LIKE ? OR al.action LIKE ? OR al.entity LIKE ?)');
                params.push(`%${q}%`, `%${q}%`, `%${q}%`); }

  const pageSize = 100;
  const pageNum = Math.max(0, parseInt(page || 0));
  const offset = pageNum * pageSize;

  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const items = db.prepare(`
    SELECT al.*, u.name AS user_name, u.role AS user_role
    FROM audit_log al LEFT JOIN users u ON u.id = al.user_id
    ${whereSql}
    ORDER BY al.id DESC
    LIMIT ${pageSize} OFFSET ${offset}
  `).all(...params);
  const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM audit_log al ${whereSql}`).get(...params);
  const total = totalRow.n;

  const users = db.prepare('SELECT id, name, role FROM users ORDER BY name').all();
  const actions = db.prepare(`SELECT DISTINCT action FROM audit_log WHERE action IS NOT NULL ORDER BY action`).all();
  const entities = db.prepare(`SELECT DISTINCT entity FROM audit_log WHERE entity IS NOT NULL ORDER BY entity`).all();

  const today = todayLocal();
  const todayCount = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE created_at >= ?").get(today + ' 00:00:00').n;
  const last24h = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE created_at >= datetime('now', '-1 day')").get().n;
  const distinctUsersToday = db.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM audit_log WHERE created_at >= ? AND user_id IS NOT NULL").get(today + ' 00:00:00').n;

  res.render('activity/index', {
    title: 'Activity Log',
    items, total, pageNum, pageSize,
    users, actions, entities,
    filters: { user, action, entity, from, to, q },
    todayCount, last24h, distinctUsersToday,
  });
});

// Per-user activity drilldown
router.get('/user/:userId', (req, res) => {
  const u = db.prepare('SELECT id, name, email, role, active FROM users WHERE id=?').get(req.params.userId);
  if (!u) return res.redirect('/activity');
  const items = db.prepare(`
    SELECT al.* FROM audit_log al WHERE al.user_id = ? ORDER BY al.id DESC LIMIT 500
  `).all(req.params.userId);
  // Action counts
  const counts = db.prepare(`
    SELECT action, COUNT(*) AS n FROM audit_log WHERE user_id = ? GROUP BY action ORDER BY n DESC
  `).all(req.params.userId);
  res.render('activity/user', { title: u.name + ' · Activity', u, items, counts });
});

module.exports = router;
