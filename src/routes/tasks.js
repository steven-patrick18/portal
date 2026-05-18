const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { getUserLevel } = require('../middleware/permissions');
const router = express.Router();

// 'full' level (owner/admin by default) can assign tasks to other people,
// edit/delete any task, and see everything. Everyone else only sees tasks
// they are assigned or that they created, and can only act on those.
function canManage(req) {
  return getUserLevel(req.session.user, 'tasks') === 'full';
}

// Scope a list/lookup to the current user unless they can manage.
// Table is always aliased `t`.
function scopeSql(req) {
  if (canManage(req)) return { where: '1=1', params: [] };
  return { where: '(t.assigned_to = ? OR t.created_by = ?)', params: [req.session.user.id, req.session.user.id] };
}

// Can this user act on (status/edit) this specific task row?
function canTouch(req, task) {
  if (!task) return false;
  if (canManage(req)) return true;
  return task.assigned_to === req.session.user.id || task.created_by === req.session.user.id;
}

const STATUSES = ['pending', 'in_progress', 'on_hold', 'review', 'done', 'cancelled'];
// Statuses that count as "still open" (for KPIs / overdue).
const OPEN_STATUSES = ['pending', 'in_progress', 'on_hold', 'review'];
const PRIORITIES = ['low', 'medium', 'high'];

// Build a "YYYY-MM-DD HH:MM" string from the form's date + time inputs.
function combineDue(date, time) {
  if (!date) return null;
  const t = (time && /^\d{2}:\d{2}/.test(time)) ? time.slice(0, 5) : '18:00';
  return `${date} ${t}`;
}

// ─── List ──────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const { where, params } = scopeSql(req);
  const status = STATUSES.includes(req.query.status) ? req.query.status : '';
  const mine = req.query.mine === '1';
  const q = (req.query.q || '').trim();

  let sql = `
    SELECT t.*, ua.name AS assignee_name, uc.name AS creator_name
    FROM tasks t
    JOIN users ua ON ua.id = t.assigned_to
    JOIN users uc ON uc.id = t.created_by
    WHERE ${where}`;
  const p = [...params];
  if (status) { sql += ' AND t.status = ?'; p.push(status); }
  if (mine)   { sql += ' AND t.assigned_to = ?'; p.push(req.session.user.id); }
  if (q)      { sql += ' AND (t.title LIKE ? OR t.description LIKE ?)'; p.push(`%${q}%`, `%${q}%`); }
  // Open tasks first, then by soonest deadline, then newest.
  sql += `
    ORDER BY
      CASE t.status
        WHEN 'in_progress' THEN 0 WHEN 'review' THEN 1 WHEN 'pending' THEN 2
        WHEN 'on_hold' THEN 3 WHEN 'done' THEN 4 ELSE 5 END,
      (t.due_at IS NULL), t.due_at ASC, t.id DESC
    LIMIT 300`;
  const items = db.prepare(sql).all(...p);
  // Local "now" as a sortable "YYYY-MM-DD HH:MM" string for overdue compare.
  const nowStr = db.prepare("SELECT strftime('%Y-%m-%d %H:%M', 'now', 'localtime') AS s").get().s;
  items.forEach(it => {
    it.overdue = it.due_at && OPEN_STATUSES.includes(it.status) && it.due_at < nowStr;
  });

  // Counters for the KPI strip (respect the same scope)
  const openList = "('" + OPEN_STATUSES.join("','") + "')";
  const cnt = db.prepare(`
    SELECT
      SUM(CASE WHEN status IN ${openList} THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN status IN ${openList} AND due_at IS NOT NULL
               AND datetime(replace(due_at,' ','T')) < datetime('now','localtime') THEN 1 ELSE 0 END) AS overdue
    FROM tasks t WHERE ${where}
  `).get(...params);

  res.render('tasks/index', {
    title: 'Tasks', items, status, mine, q,
    canManage: canManage(req),
    counts: { open: cnt.open || 0, done: cnt.done || 0, overdue: cnt.overdue || 0 },
  });
});

// ─── New ───────────────────────────────────────────────────────
router.get('/new', (req, res) => {
  const manage = canManage(req);
  const users = manage
    ? db.prepare("SELECT id, name, role FROM users WHERE active=1 ORDER BY name").all()
    : [{ id: req.session.user.id, name: req.session.user.name + ' (you)', role: req.session.user.role }];
  res.render('tasks/form', { title: 'New Task', task: null, users, canManage: manage });
});

router.post('/', (req, res) => {
  const manage = canManage(req);
  const { title, description, priority, estimated_hours, due_date, due_time } = req.body;
  if (!title || !title.trim()) { flash(req, 'danger', 'Title is required.'); return res.redirect('/tasks/new'); }
  // Non-managers can only assign to themselves, whatever they submit.
  let assignedTo = parseInt(req.body.assigned_to) || req.session.user.id;
  if (!manage) assignedTo = req.session.user.id;
  const prio = PRIORITIES.includes(priority) ? priority : 'medium';
  const est = estimated_hours ? parseFloat(estimated_hours) : null;
  const dueAt = combineDue(due_date, due_time);

  const r = db.prepare(`INSERT INTO tasks (title, description, assigned_to, created_by, priority, estimated_hours, due_at) VALUES (?,?,?,?,?,?,?)`)
    .run(title.trim(), description || null, assignedTo, req.session.user.id, prio, est, dueAt);
  req.audit('create', 'task', r.lastInsertRowid, `${title.trim()} → user #${assignedTo}${dueAt ? ' · due ' + dueAt : ''}`);
  flash(req, 'success', 'Task created.');
  res.redirect('/tasks/' + r.lastInsertRowid);
});

// ─── Show ──────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const t = db.prepare(`
    SELECT t.*, ua.name AS assignee_name, uc.name AS creator_name
    FROM tasks t JOIN users ua ON ua.id=t.assigned_to JOIN users uc ON uc.id=t.created_by
    WHERE t.id=?`).get(req.params.id);
  if (!t) return res.redirect('/tasks');
  if (!canTouch(req, t)) { flash(req, 'danger', 'That task is not yours.'); return res.redirect('/tasks'); }
  res.render('tasks/show', { title: t.title, t, canManage: canManage(req), STATUSES });
});

// ─── Edit (manager, or the task's creator) ─────────────────────
router.get('/:id/edit', (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!t) return res.redirect('/tasks');
  const manage = canManage(req);
  if (!manage && t.created_by !== req.session.user.id) {
    flash(req, 'danger', 'Only the creator or a manager can edit a task. You can still change its status.');
    return res.redirect('/tasks/' + t.id);
  }
  const users = manage
    ? db.prepare("SELECT id, name, role FROM users WHERE active=1 ORDER BY name").all()
    : [{ id: req.session.user.id, name: req.session.user.name + ' (you)', role: req.session.user.role }];
  res.render('tasks/form', { title: 'Edit Task', task: t, users, canManage: manage });
});

router.post('/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!t) return res.redirect('/tasks');
  const manage = canManage(req);
  if (!manage && t.created_by !== req.session.user.id) {
    flash(req, 'danger', 'Only the creator or a manager can edit this task.');
    return res.redirect('/tasks/' + t.id);
  }
  const { title, description, priority, estimated_hours, due_date, due_time } = req.body;
  if (!title || !title.trim()) { flash(req, 'danger', 'Title is required.'); return res.redirect('/tasks/' + t.id + '/edit'); }
  let assignedTo = manage ? (parseInt(req.body.assigned_to) || t.assigned_to) : t.assigned_to;
  const prio = PRIORITIES.includes(priority) ? priority : t.priority;
  const est = estimated_hours ? parseFloat(estimated_hours) : null;
  const dueAt = combineDue(due_date, due_time);
  db.prepare(`UPDATE tasks SET title=?, description=?, assigned_to=?, priority=?, estimated_hours=?, due_at=?, updated_at=datetime('now') WHERE id=?`)
    .run(title.trim(), description || null, assignedTo, prio, est, dueAt, t.id);
  req.audit('update', 'task', t.id, `${title.trim()} · ${prio}${dueAt ? ' · due ' + dueAt : ''}`);
  flash(req, 'success', 'Task updated.');
  res.redirect('/tasks/' + t.id);
});

// ─── Status change (assignee, creator, or manager) ─────────────
router.post('/:id/status', (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!t) return res.redirect('/tasks');
  if (!canTouch(req, t)) { flash(req, 'danger', 'That task is not yours.'); return res.redirect('/tasks'); }
  const status = req.body.status;
  if (!STATUSES.includes(status)) { flash(req, 'danger', 'Bad status.'); return res.redirect('/tasks/' + t.id); }
  const completedAt = status === 'done' ? "datetime('now')" : 'NULL';
  db.prepare(`UPDATE tasks SET status=?, completed_at=${completedAt}, updated_at=datetime('now') WHERE id=?`).run(status, t.id);
  req.audit('status', 'task', t.id, `${t.title} → ${status}`);
  flash(req, 'success', `Marked ${status.replace('_', ' ')}.`);
  res.redirect(req.get('Referer') && req.get('Referer').includes('/tasks/' + t.id) ? '/tasks/' + t.id : '/tasks');
});

// ─── Delete (manager only) ─────────────────────────────────────
router.post('/:id/delete', (req, res) => {
  if (!canManage(req)) { flash(req, 'danger', 'Only a manager can delete a task.'); return res.redirect('/tasks/' + req.params.id); }
  const t = db.prepare('SELECT title FROM tasks WHERE id=?').get(req.params.id);
  if (!t) return res.redirect('/tasks');
  db.prepare('DELETE FROM tasks WHERE id=?').run(req.params.id);
  req.audit('delete', 'task', req.params.id, t.title);
  flash(req, 'success', 'Task deleted.');
  res.redirect('/tasks');
});

module.exports = router;
