// SMS Reports — a read-only deep-dive into every SMS: status (sent / failed),
// the exact gateway reason, request id, raw response, per-event breakdown, and
// the bulk-job history (broadcasts / ledger / survey pushes, incl. in-progress).
const express = require('express');
const { db } = require('../db');
const { toCsv, sendCsv } = require('../utils/csv');
const router = express.Router();

// Pull a human reason + request id out of the stored provider_response JSON.
function parseResp(pr) {
  try {
    const j = JSON.parse(pr || '{}');
    if (j.stub) return { reason: 'Test mode — logged, not sent', reqId: '' };
    if (j.error) return { reason: String(j.error), reqId: j.request_id || '' };
    if (j.message) return { reason: Array.isArray(j.message) ? j.message.join('; ') : String(j.message), reqId: j.request_id || '' };
    if (j.return === true || j.request_id) return { reason: 'Accepted by gateway', reqId: j.request_id || '' };
    if (j.return === false) return { reason: 'Rejected by gateway', reqId: '' };
    return { reason: '', reqId: '' };
  } catch (e) { return { reason: '', reqId: '' }; }
}

// Build the WHERE clause from the query filters. includeStatus=false is used
// for the summary tiles so every status bucket is counted.
function buildWhere(f, includeStatus) {
  const where = ["channel='sms'"]; const params = [];
  if (includeStatus && (f.status === 'sent' || f.status === 'failed')) { where.push('status=?'); params.push(f.status); }
  if (f.event) { where.push('template=?'); params.push(f.event); }
  if (f.from) { where.push('date(created_at)>=date(?)'); params.push(f.from); }
  if (f.to) { where.push('date(created_at)<=date(?)'); params.push(f.to); }
  if (f.q) { where.push('(to_phone LIKE ? OR message LIKE ?)'); params.push('%' + f.q + '%', '%' + f.q + '%'); }
  return { sql: 'WHERE ' + where.join(' AND '), params };
}

router.get('/', (req, res) => {
  const f = req.query;
  const flt = buildWhere(f, true);
  const sum = buildWhere(f, false);

  // Summary buckets (ignore the status filter so all buckets always show).
  const sCount = (st) => db.prepare(`SELECT COUNT(*) AS n FROM notifications_log ${sum.sql}${st ? ' AND status=?' : ''}`).get(...sum.params, ...(st ? [st] : [])).n;
  const totalAll = sCount(null), sent = sCount('sent'), failed = sCount('failed');
  const successRate = (sent + failed) ? Math.round(sent / (sent + failed) * 100) : 0;

  // In-progress (queued) — dealers still pending across running bulk jobs.
  const running = db.prepare("SELECT COALESCE(SUM(total - sent - skipped - failed),0) AS q, COUNT(*) AS j FROM sms_jobs WHERE status='running'").get();

  // Per-event breakdown.
  const byEvent = db.prepare(`SELECT COALESCE(template,'(other)') AS event, COUNT(*) AS total,
      SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
    FROM notifications_log ${sum.sql} GROUP BY template ORDER BY total DESC`).all(...sum.params);

  // Detailed, paginated log.
  const per = 100, page = Math.max(1, parseInt(f.page) || 1), offset = (page - 1) * per;
  const matched = db.prepare(`SELECT COUNT(*) AS n FROM notifications_log ${flt.sql}`).get(...flt.params).n;
  const rows = db.prepare(`SELECT n.*, d.name AS dealer_name FROM notifications_log n
      LEFT JOIN dealers d ON d.id=n.related_dealer_id ${flt.sql} ORDER BY n.id DESC LIMIT ? OFFSET ?`).all(...flt.params, per, offset)
    .map(r => Object.assign(r, parseResp(r.provider_response)));

  // Distinct events for the filter dropdown.
  const events = db.prepare("SELECT DISTINCT template AS e FROM notifications_log WHERE channel='sms' AND template IS NOT NULL ORDER BY template").all().map(r => r.e);

  res.render('sms-reports/index', {
    title: 'SMS Reports', f, rows, byEvent, events,
    summary: { totalAll, sent, failed, successRate, queued: running.q, runningJobs: running.j },
    page, per, matched, pages: Math.max(1, Math.ceil(matched / per)),
  });
});

// Bulk-job history (broadcasts / ledger / survey pushes).
router.get('/jobs', (req, res) => {
  const jobs = db.prepare('SELECT * FROM sms_jobs ORDER BY id DESC LIMIT 100').all();
  res.render('sms-reports/jobs', { title: 'SMS Reports — Bulk jobs', jobs });
});

// CSV export of the filtered message log.
router.get('/export.csv', (req, res) => {
  const flt = buildWhere(req.query, true);
  const rows = db.prepare(`SELECT n.*, d.name AS dealer_name FROM notifications_log n
      LEFT JOIN dealers d ON d.id=n.related_dealer_id ${flt.sql} ORDER BY n.id DESC LIMIT 20000`).all(...flt.params)
    .map(r => { const p = parseResp(r.provider_response); return {
      Date: r.created_at, To: r.to_phone, Dealer: r.dealer_name || '', Event: r.template || '',
      Status: r.status, Reason: p.reason, RequestID: p.reqId, Message: r.message };
    });
  const cols = ['Date', 'To', 'Dealer', 'Event', 'Status', 'Reason', 'RequestID', 'Message'];
  sendCsv(res, 'sms-report.csv', toCsv(rows, cols));
});

module.exports = router;
