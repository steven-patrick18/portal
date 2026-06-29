const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const { db } = require('../db');
const { requireRole, requireOwner, flash } = require('../middleware/auth');
const router = express.Router();
router.use(requireRole('admin'));

// Company branding (logo/legal info) and System & Updates (git pull,
// backups, restart) are sensitive. They now require FULL access on the
// Settings feature rather than the owner role — so the owner can delegate
// them to a trusted admin from Settings → Access & Roles (grant Settings =
// Full). Owner is always Full.
router.use(['/branding', '/system'], (req, res, next) => {
  if (require('../middleware/permissions').getUserLevel(req.session.user, 'settings') !== 'full') {
    return res.status(403).render('error', { title: 'Forbidden', message: 'Full Settings access required for branding & system updates.', code: 403 });
  }
  next();
});

const BRAND_DIR = path.join(__dirname, '..', '..', 'public', 'uploads', 'branding');
if (!fs.existsSync(BRAND_DIR)) fs.mkdirSync(BRAND_DIR, { recursive: true });
const brandUpload = multer({
  storage: multer.diskStorage({
    destination: BRAND_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.png';
      cb(null, 'logo_' + Date.now() + ext);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g|webp|svg\+xml|gif)$/i.test(file.mimetype)),
});

function getSetting(key, fallback) {
  const r = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  return r ? r.value : (fallback !== undefined ? fallback : (process.env[key] || ''));
}
function setSetting(key, value, userId) {
  db.prepare(`INSERT INTO app_settings (key, value, updated_by) VALUES (?,?,?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now'), updated_by=excluded.updated_by`)
    .run(key, value || '', userId || null);
}

router.get('/', (req, res) => res.redirect('/settings/branding'));

// ---------- Company Branding (white-label) ----------
function getBranding() {
  return {
    name:    getSetting('COMPANY_NAME',    process.env.COMPANY_NAME    || 'Portal ERP'),
    logo:    getSetting('COMPANY_LOGO',    ''),
    address: getSetting('COMPANY_ADDRESS', process.env.COMPANY_ADDRESS || ''),
    phone:   getSetting('COMPANY_PHONE',   process.env.COMPANY_PHONE   || ''),
    email:   getSetting('COMPANY_EMAIL',   process.env.COMPANY_EMAIL   || ''),
    gstin:   getSetting('COMPANY_GSTIN',   process.env.COMPANY_GSTIN   || ''),
    state:   getSetting('COMPANY_STATE',   process.env.COMPANY_STATE   || ''),
  };
}

router.get('/branding', (req, res) => {
  res.render('settings/branding', { title: 'Company Branding', cfg: getBranding() });
});

router.post('/branding', brandUpload.single('logo'), (req, res) => {
  const u = req.session.user.id;
  setSetting('COMPANY_NAME',    (req.body.name||'').trim() || 'Portal ERP', u);
  setSetting('COMPANY_ADDRESS', req.body.address, u);
  setSetting('COMPANY_PHONE',   req.body.phone, u);
  setSetting('COMPANY_EMAIL',   req.body.email, u);
  setSetting('COMPANY_GSTIN',   req.body.gstin, u);
  setSetting('COMPANY_STATE',   req.body.state, u);
  if (req.file) {
    // Delete previous logo file (if any) to keep the uploads dir tidy
    const prev = getSetting('COMPANY_LOGO', '');
    if (prev) {
      const prevPath = path.join(__dirname, '..', '..', 'public', prev.replace(/^\//, ''));
      if (fs.existsSync(prevPath)) { try { fs.unlinkSync(prevPath); } catch(_) {} }
    }
    setSetting('COMPANY_LOGO', '/uploads/branding/' + req.file.filename, u);
  } else if (req.body.remove_logo === '1') {
    const prev = getSetting('COMPANY_LOGO', '');
    if (prev) {
      const prevPath = path.join(__dirname, '..', '..', 'public', prev.replace(/^\//, ''));
      if (fs.existsSync(prevPath)) { try { fs.unlinkSync(prevPath); } catch(_) {} }
    }
    setSetting('COMPANY_LOGO', '', u);
  }
  req.audit('settings_save', 'branding', null, `name=${req.body.name||''} · logo=${req.file?req.file.filename:'(unchanged)'}`);
  flash(req, 'success', 'Branding updated.');
  res.redirect('/settings/branding');
});

// MSG91 was removed — SMS now goes only through the Capcom Android phone
// gateway. /settings/msg91 redirects to the unified /settings/sms page.
router.get('/msg91', (_req, res) => res.redirect('/settings/sms'));

// ---------- Fast2SMS (DLT) settings + templates ----------
router.get('/sms', (req, res) => {
  const cfg = {
    provider:      getSetting('SMS_PROVIDER',        'off'),
    sender_id:     getSetting('FAST2SMS_SENDER_ID',  ''),
    route:         getSetting('FAST2SMS_ROUTE',      'dlt'),
    flash:         getSetting('FAST2SMS_FLASH',      '0') === '1',
    entity_id:     getSetting('FAST2SMS_ENTITY_ID',  ''),
    key_saved:     !!getSetting('FAST2SMS_API_KEY',  ''),
    auto_payment:  getSetting('SMS_AUTO_SEND_PAYMENT',  'true') !== 'false',
    auto_invoice:  getSetting('SMS_AUTO_SEND_INVOICE',  'true') !== 'false',
    auto_dispatch: getSetting('SMS_AUTO_SEND_DISPATCH', 'true') !== 'false',
  };
  const templates = db.prepare("SELECT * FROM sms_templates ORDER BY (event='manual'), event, id").all();
  const recent = db.prepare(`SELECT n.*, d.name AS dealer_name FROM notifications_log n LEFT JOIN dealers d ON d.id=n.related_dealer_id WHERE n.channel='sms' ORDER BY n.id DESC LIMIT 12`).all();
  const ledger = {
    enabled:     getSetting('LEDGER_SMS_ENABLED', '0') === '1',
    frequency:   getSetting('LEDGER_SMS_FREQUENCY', 'weekly'),
    time:        getSetting('LEDGER_SMS_TIME', '10:00'),
    day:         parseInt(getSetting('LEDGER_SMS_DAY', '1')) || 0,
    only_out:    getSetting('LEDGER_SMS_ONLY_OUTSTANDING', '1') === '1',
    template_id: getSetting('LEDGER_SMS_TEMPLATE_ID', ''),
    last_run:    getSetting('LEDGER_SMS_LAST_RUN', ''),
    targets:     (() => { try { return require('../utils/ledgerSchedule').targetCount(); } catch (_) { return 0; } })(),
  };
  const offices = db.prepare("SELECT id, name FROM locations WHERE active=1 AND is_office=1 ORDER BY id").all();
  const broadcasts = db.prepare("SELECT b.*, t.label AS tpl_label FROM scheduled_broadcasts b LEFT JOIN sms_templates t ON t.id=b.template_id WHERE b.status='pending' ORDER BY b.run_at").all();
  let bc = { all: 0, outstanding: 0 };
  try { const B = require('../utils/broadcast'); bc = { all: B.targetCount('all'), outstanding: B.targetCount('outstanding') }; } catch (_) {}
  res.render('settings/sms', { title: 'SMS Settings', cfg, templates, recent, ledger, offices, broadcasts, bc });
});

router.post('/sms', (req, res) => {
  const u = req.session.user.id;
  setSetting('SMS_PROVIDER',       req.body.provider === 'fast2sms' ? 'fast2sms' : 'off', u);
  setSetting('FAST2SMS_SENDER_ID', (req.body.sender_id || '').trim().toUpperCase(), u);
  setSetting('FAST2SMS_ROUTE',     req.body.route || 'dlt', u);
  setSetting('FAST2SMS_FLASH',     req.body.flash === '1' ? '1' : '0', u);
  setSetting('FAST2SMS_ENTITY_ID', (req.body.entity_id || '').trim(), u);
  if (req.body.api_key && req.body.api_key.trim()) setSetting('FAST2SMS_API_KEY', req.body.api_key.trim(), u);
  setSetting('SMS_AUTO_SEND_PAYMENT',  req.body.auto_payment  === '1' ? 'true' : 'false', u);
  setSetting('SMS_AUTO_SEND_INVOICE',  req.body.auto_invoice  === '1' ? 'true' : 'false', u);
  setSetting('SMS_AUTO_SEND_DISPATCH', req.body.auto_dispatch === '1' ? 'true' : 'false', u);
  req.audit('settings_save', 'sms', null, `provider=${req.body.provider}`);
  flash(req, 'success', 'SMS settings saved.');
  res.redirect('/settings/sms');
});

// ---------- SMS templates CRUD ----------
router.post('/sms/templates', (req, res) => {
  const f = req.body;
  if (!f.label || !f.body) { flash(req, 'danger', 'Label and message body are required.'); return res.redirect('/settings/sms'); }
  db.prepare(`INSERT INTO sms_templates (event,label,dlt_template_id,body,var_order,active,sender_id) VALUES (?,?,?,?,?,?,?)`)
    .run(f.event || 'manual', f.label.trim(), (f.dlt_template_id || '').trim() || null, f.body.trim(), (f.var_order || '').trim() || null, f.active === '1' ? 1 : 0, (f.sender_id || '').trim());
  flash(req, 'success', 'Template added.');
  res.redirect('/settings/sms');
});
router.post('/sms/templates/:id', (req, res) => {
  const f = req.body;
  db.prepare(`UPDATE sms_templates SET event=?, label=?, dlt_template_id=?, body=?, var_order=?, active=?, sender_id=? WHERE id=?`)
    .run(f.event || 'manual', (f.label || '').trim(), (f.dlt_template_id || '').trim() || null, (f.body || '').trim(), (f.var_order || '').trim() || null, f.active === '1' ? 1 : 0, (f.sender_id || '').trim(), req.params.id);
  flash(req, 'success', 'Template updated.');
  res.redirect('/settings/sms');
});
router.post('/sms/templates/:id/delete', (req, res) => {
  db.prepare('DELETE FROM sms_templates WHERE id=?').run(req.params.id);
  flash(req, 'success', 'Template deleted.');
  res.redirect('/settings/sms');
});
router.post('/sms/templates/:id/toggle', (req, res) => {
  db.prepare('UPDATE sms_templates SET active = 1 - active WHERE id=?').run(req.params.id);
  res.redirect('/settings/sms');
});

// ---------- Email (SMTP) settings + templates ----------
router.get('/email', (req, res) => {
  const cfg = {
    host:       getSetting('SMTP_HOST', ''),
    port:       getSetting('SMTP_PORT', '465'),
    secure:     getSetting('SMTP_SECURE', '1') === '1',
    user:       getSetting('SMTP_USER', ''),
    pass_saved: !!getSetting('SMTP_PASS', ''),
    from_name:  getSetting('SMTP_FROM_NAME', ''),
    from_email: getSetting('SMTP_FROM_EMAIL', ''),
    configured: require('../utils/mailer').isConfigured(),
  };
  const templates = db.prepare("SELECT * FROM email_templates ORDER BY category, sort, id").all();
  const recent = db.prepare("SELECT * FROM email_log ORDER BY id DESC LIMIT 15").all();
  res.render('settings/email', { title: 'Email Settings', cfg, templates, recent });
});
router.post('/email', (req, res) => {
  const u = req.session.user.id, f = req.body;
  setSetting('SMTP_HOST',       (f.host || '').trim(), u);
  setSetting('SMTP_PORT',       (f.port || '465').replace(/\D/g, '') || '465', u);
  setSetting('SMTP_SECURE',     f.secure === '1' ? '1' : '0', u);
  setSetting('SMTP_USER',       (f.user || '').trim(), u);
  setSetting('SMTP_FROM_NAME',  (f.from_name || '').trim(), u);
  setSetting('SMTP_FROM_EMAIL', (f.from_email || '').trim(), u);
  if (f.pass && f.pass.trim()) setSetting('SMTP_PASS', f.pass, u);   // only overwrite when a new one is pasted
  req.audit('settings_save', 'email', null, `host=${f.host}`);
  flash(req, 'success', 'Email settings saved.');
  res.redirect('/settings/email');
});
router.post('/email/test', async (req, res) => {
  const to = (req.body.to || '').trim();
  if (!to) { flash(req, 'danger', 'Enter an email address to send the test to.'); return res.redirect('/settings/email'); }
  const mailer = require('../utils/mailer');
  const r = await mailer.send({ to, toName: 'Test', subject: 'Test email from your portal',
    body: 'This is a test email from your Sharv Enterprises portal. If you received this, SMTP is working. ✅',
    templateKey: 'test', context_type: 'test', sentBy: req.session.user.id });
  flash(req, r.ok ? 'success' : 'danger', r.ok ? ('Test email sent to ' + to + '.') : ('Failed: ' + r.error));
  res.redirect('/settings/email');
});
// Email templates CRUD
router.post('/email/template', (req, res) => {
  const f = req.body;
  if (!f.label || !f.subject || !f.body) { flash(req, 'danger', 'Label, subject and body are required.'); return res.redirect('/settings/email'); }
  if (f.id) {
    db.prepare('UPDATE email_templates SET label=?, category=?, subject=?, body=?, active=? WHERE id=?')
      .run(f.label.trim(), f.category || 'candidate', f.subject.trim(), f.body, f.active === '0' ? 0 : 1, f.id);
    flash(req, 'success', 'Template updated.');
  } else {
    const tkey = (f.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'tpl') + '_' + Date.now().toString(36);
    db.prepare('INSERT INTO email_templates (tkey,label,category,subject,body) VALUES (?,?,?,?,?)')
      .run(tkey, f.label.trim(), f.category || 'candidate', f.subject.trim(), f.body);
    flash(req, 'success', 'Template added.');
  }
  res.redirect('/settings/email');
});
router.post('/email/template/:id/delete', (req, res) => {
  db.prepare('DELETE FROM email_templates WHERE id=?').run(req.params.id);
  flash(req, 'success', 'Template deleted.');
  res.redirect('/settings/email');
});

// ---------- Scheduled ledger-balance broadcast ----------
router.post('/sms/ledger', (req, res) => {
  const u = req.session.user.id;
  setSetting('LEDGER_SMS_ENABLED',          req.body.enabled === '1' ? '1' : '0', u);
  setSetting('LEDGER_SMS_FREQUENCY',        ['daily', 'weekly', 'monthly'].includes(req.body.frequency) ? req.body.frequency : 'weekly', u);
  setSetting('LEDGER_SMS_TIME',             /^\d{1,2}:\d{2}$/.test(req.body.time || '') ? req.body.time : '10:00', u);
  setSetting('LEDGER_SMS_DAY',              String(parseInt(req.body.day) || 0), u);
  setSetting('LEDGER_SMS_ONLY_OUTSTANDING', req.body.only_out === '1' ? '1' : '0', u);
  setSetting('LEDGER_SMS_TEMPLATE_ID',      (req.body.template_id || '').trim(), u);
  req.audit('settings_save', 'sms_ledger_schedule', null, `enabled=${req.body.enabled === '1'} ${req.body.frequency} ${req.body.time}`);
  flash(req, 'success', 'Ledger reminder schedule saved.');
  res.redirect('/settings/sms');
});

router.post('/sms/ledger/run', (req, res) => {
  const jobId = require('../utils/ledgerSchedule').startRun(req.session.user.id);
  flash(req, 'success', 'Ledger reminder started — sending in the background. Live status is shown below.');
  res.redirect('/settings/sms?job=' + jobId);
});

// Live status for a background SMS job (polled by the page).
router.get('/sms/job/:id', (req, res) => {
  const j = require('../utils/smsJobs').get(req.params.id);
  if (!j) return res.json({ ok: false });
  res.json({ ok: true, id: j.id, label: j.label, total: j.total, sent: j.sent, skipped: j.skipped, failed: j.failed, status: j.status, error: j.error });
});

// ---------- Campaign / promotional broadcast (any template → audience) ----------
router.post('/sms/broadcast/run', (req, res) => {
  const { template_id, audience, office_id, festival } = req.body;
  if (!template_id) { flash(req, 'danger', 'Pick a template to broadcast.'); return res.redirect('/settings/sms'); }
  const extra = {}; if ((festival || '').trim()) extra.festival = festival.trim();
  const tpl = db.prepare('SELECT label FROM sms_templates WHERE id=?').get(template_id);
  const jobId = require('../utils/broadcast').startBroadcast(
    { templateId: template_id, audience: audience || 'all', officeId: office_id || null, extra },
    { userId: req.session.user.id, label: 'Campaign: ' + ((tpl && tpl.label) || 'template') + ' → ' + (audience || 'all') });
  try { require('../utils/insights').logEvent('campaign', 'SMS broadcast started'); } catch (_) {}
  flash(req, 'success', 'Broadcast started — sending in the background. Live status is shown below.');
  res.redirect('/settings/sms?job=' + jobId);
});

router.post('/sms/broadcast/schedule', (req, res) => {
  const { template_id, audience, office_id, festival, run_at } = req.body;
  if (!template_id || !run_at) { flash(req, 'danger', 'Template and date/time are required.'); return res.redirect('/settings/sms'); }
  const runAt = String(run_at).replace('T', ' ').slice(0, 16); // 'YYYY-MM-DD HH:MM' (IST)
  const extra = {}; if ((festival || '').trim()) extra.festival = festival.trim();
  db.prepare(`INSERT INTO scheduled_broadcasts (template_id,audience,office_id,extra_json,run_at,created_by) VALUES (?,?,?,?,?,?)`)
    .run(template_id, audience || 'all', office_id || null, JSON.stringify(extra), runAt, req.session.user.id);
  flash(req, 'success', 'Broadcast scheduled for ' + runAt + ' (IST).');
  res.redirect('/settings/sms');
});

router.post('/sms/broadcast/:id/cancel', (req, res) => {
  db.prepare("UPDATE scheduled_broadcasts SET status='cancelled' WHERE id=? AND status='pending'").run(req.params.id);
  flash(req, 'success', 'Scheduled broadcast cancelled.');
  res.redirect('/settings/sms');
});

// ---------- Status (Fast2SMS wallet) + recent log JSON ----------
router.get('/sms/health', async (req, res) => {
  const provider = getSetting('SMS_PROVIDER', 'off');
  if (provider !== 'fast2sms') return res.json({ provider, status: 'off', message: 'SMS Mode is Off / Test — no live provider to check.' });
  const apiKey = getSetting('FAST2SMS_API_KEY', '');
  if (!apiKey) return res.json({ provider, status: 'no_key', message: 'Fast2SMS API key is not set.' });
  const w = await require('../utils/fast2sms').wallet({ apiKey });
  res.json({ provider, status: w.ok ? 'ok' : 'auth_failed', balance: w.balance, message: w.error });
});

router.get('/sms/recent', (req, res) => {
  const rows = db.prepare(`SELECT n.id, n.created_at, n.to_phone, n.message, n.status, n.provider_response, d.name AS dealer_name FROM notifications_log n LEFT JOIN dealers d ON d.id=n.related_dealer_id WHERE n.channel='sms' ORDER BY n.id DESC LIMIT 15`).all();
  res.json({ rows: rows.map(r => { let stub = false; try { stub = !!JSON.parse(r.provider_response || '{}').stub; } catch (_) {} return { id: r.id, created_at: r.created_at, to_phone: r.to_phone, dealer_name: r.dealer_name, message: r.message, status: r.status, stub }; }) });
});

// ---------- System Health: updates from git + backups ----------
const { spawn, execFile } = require('child_process');

// Find a usable `bash` for spawn(). On Linux VPS it's /bin/bash; on Windows
// dev it's typically inside the Git for Windows install. Cache the result.
let _bashPath = null;
function bashPath() {
  if (_bashPath) return _bashPath;
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe', 'bash']
    : ['/bin/bash', '/usr/bin/bash', 'bash'];
  for (const p of candidates) { if (p === 'bash' || fs.existsSync(p)) { _bashPath = p; return p; } }
  return 'bash';   // last-ditch — let spawn fail with ENOENT and surface the error
}

function runShell(cmd, args, cb) {
  execFile(cmd, args, { cwd: path.join(__dirname, '..', '..'), timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    cb(err, (stdout || '').toString().trim(), (stderr || '').toString().trim());
  });
}

router.get('/system', (req, res) => {
  const APP_DIR = path.join(__dirname, '..', '..');
  const tasks = [];
  const result = { app_dir: APP_DIR };

  // Current git commit
  tasks.push(new Promise(resolve => {
    runShell('git', ['log', '-1', '--format=%h|%s|%ci|%an'], (err, out) => {
      if (out) {
        const [hash, subject, date, author] = out.split('|');
        result.current = { hash, subject, date, author };
      } else {
        result.current = { error: 'Not a git repo or git not installed' };
      }
      resolve();
    });
  }));

  // Updates available — uses cached fetch result (don't actually fetch here, that's a separate endpoint)
  tasks.push(new Promise(resolve => {
    runShell('git', ['log', '--oneline', 'HEAD..origin/main'], (err, out) => {
      result.updates_available = out ? out.split('\n').filter(Boolean) : [];
      resolve();
    });
  }));

  // Backups — list .gz files in backups/, newest first
  result.backups = [];
  try {
    const dir = path.join(APP_DIR, 'backups');
    if (fs.existsSync(dir)) {
      result.backups = fs.readdirSync(dir)
        .filter(f => f.endsWith('.gz'))
        .map(f => {
          const stat = fs.statSync(path.join(dir, f));
          return { name: f, size: stat.size, mtime: stat.mtime };
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 20);
    }
  } catch (_) {}

  // Disk usage of the data + uploads + backups dirs
  result.disk = { data: 0, uploads: 0, backups: 0 };
  try { result.disk.data    = dirSize(path.join(APP_DIR, 'data')); } catch(_) {}
  try { result.disk.uploads = dirSize(path.join(APP_DIR, 'public', 'uploads')); } catch(_) {}
  try { result.disk.backups = dirSize(path.join(APP_DIR, 'backups')); } catch(_) {}

  // Process info
  result.proc = {
    node: process.version,
    env: process.env.NODE_ENV || 'development',
    uptime_s: Math.floor(process.uptime()),
    pid: process.pid,
    memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };

  Promise.all(tasks).then(() => {
    res.render('settings/system', { title: 'System Health', sys: result });
  });
});

function dirSize(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else { try { total += fs.statSync(p).size; } catch(_) {} }
  }
  return total;
}

// Manually trigger `git fetch` to refresh the "updates available" count.
router.post('/system/check-updates', (req, res) => {
  runShell('git', ['fetch', '--quiet', 'origin', 'main'], (err) => {
    if (err) return res.json({ ok: false, error: err.message });
    runShell('git', ['log', '--oneline', 'HEAD..origin/main'], (err2, out) => {
      const list = out ? out.split('\n').filter(Boolean) : [];
      res.json({ ok: true, behind: list.length, commits: list });
    });
  });
});

// Run the backup script synchronously (it's quick — sqlite .backup + tar uploads).
router.post('/system/backup-now', (req, res) => {
  const APP_DIR = path.join(__dirname, '..', '..');
  const script = path.join(APP_DIR, 'deploy', 'backup.sh');
  if (!fs.existsSync(script)) return res.json({ ok: false, error: 'deploy/backup.sh not found' });
  execFile(bashPath(), [script], { cwd: APP_DIR, timeout: 120000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    const out = ((stdout||'') + (stderr ? '\n' + stderr : '')).trim();
    req.audit('backup_run', 'system', null, err ? 'failed: ' + err.message : 'ok');
    res.json({
      ok: !err,
      error: err ? (err.message || 'unknown') : null,
      output: out || (err ? 'No output. ' + err.message : 'Done.'),
    });
  });
});

// Trigger update.sh DETACHED so the running app can be reloaded by it without
// killing the response mid-flight. Output is streamed to logs/update-web.log.
router.post('/system/update-now', (req, res) => {
  const APP_DIR = path.join(__dirname, '..', '..');
  const script = path.join(APP_DIR, 'update.sh');
  if (!fs.existsSync(script)) return res.json({ ok: false, error: 'update.sh not found' });
  const logDir = path.join(APP_DIR, 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'update-web.log');
  // Truncate the log so only this run's output shows.
  fs.writeFileSync(logPath, `[$(date)] update-now triggered by ${req.session.user.email}\n`);
  const out = fs.openSync(logPath, 'a');
  const child = spawn(bashPath(), [script, '--skip-backup'], { cwd: APP_DIR, detached: true, stdio: ['ignore', out, out] });
  child.unref();
  req.audit('update_run', 'system', null, `pid ${child.pid}`);
  res.json({ ok: true, started: true, pid: child.pid });
});

router.get('/system/update-log', (req, res) => {
  const logPath = path.join(__dirname, '..', '..', 'logs', 'update-web.log');
  if (!fs.existsSync(logPath)) return res.type('text/plain').send('(no update log yet)');
  // Cap to last 200 lines
  const data = fs.readFileSync(logPath, 'utf8').split('\n').slice(-200).join('\n');
  res.type('text/plain').send(data);
});

// ─── Live server stats (CPU, RAM, disk, uptime) ────────────────
// Polled by the System Health page every 5 seconds. Read-only and
// cheap — uses node's `os` + `fs.statfsSync`. CPU usage is computed
// from a delta between two snapshots ~200ms apart.
let cpuSnapshotPrev = null;
function cpuSnapshot() {
  // Sum idle + total ticks across all CPUs at the moment of call.
  let idle = 0, total = 0;
  for (const cpu of os.cpus()) {
    for (const t of Object.values(cpu.times)) total += t;
    idle += cpu.times.idle;
  }
  return { idle, total };
}
function cpuUsagePct() {
  const cur = cpuSnapshot();
  if (!cpuSnapshotPrev) { cpuSnapshotPrev = cur; return null; }
  const dIdle  = cur.idle  - cpuSnapshotPrev.idle;
  const dTotal = cur.total - cpuSnapshotPrev.total;
  cpuSnapshotPrev = cur;
  if (dTotal <= 0) return null;
  return Math.max(0, Math.min(100, Math.round(100 * (1 - dIdle / dTotal))));
}
// Prime the snapshot so the first poll has something to diff against.
cpuSnapshot();

router.get('/system/stats.json', (req, res) => {
  // CPU
  const cpus = os.cpus();
  const cpuPct = cpuUsagePct();   // null on cold start — UI shows "…"
  const load = os.loadavg();      // [1m, 5m, 15m] — zeros on Windows
  // Memory (system-wide, not just node process)
  const totalMem = os.totalmem();
  const freeMem  = os.freemem();
  const usedMem  = totalMem - freeMem;
  // Disk — root mount on Linux, app dir on Windows. statfsSync is in
  // Node 18.15+ / 19+ — wrap in try so older runtimes don't crash.
  let disk = null;
  try {
    const target = os.platform() === 'win32' ? path.parse(process.cwd()).root : '/';
    const s = fs.statfsSync(target);
    const total = s.blocks * s.bsize;
    const free  = s.bfree  * s.bsize;
    const used  = total - free;
    disk = { totalB: total, freeB: free, usedB: used, pct: total > 0 ? Math.round(100 * used / total) : 0, target };
  } catch (_) { /* statfs unavailable */ }
  // Process
  const mem = process.memoryUsage();

  res.json({
    when: new Date().toISOString(),
    cpu: {
      model: (cpus[0] && cpus[0].model) || 'unknown',
      cores: cpus.length,
      speed_mhz: (cpus[0] && cpus[0].speed) || 0,
      load_1m:  load[0] || 0,
      load_5m:  load[1] || 0,
      load_15m: load[2] || 0,
      usage_pct: cpuPct,
    },
    memory: {
      total_b: totalMem,
      free_b: freeMem,
      used_b: usedMem,
      pct: totalMem > 0 ? Math.round(100 * usedMem / totalMem) : 0,
    },
    disk,
    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      uptime_s: os.uptime(),
    },
    process: {
      rss_mb:    Math.round(mem.rss      / 1024 / 1024),
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
      external_mb:  Math.round((mem.external || 0) / 1024 / 1024),
      uptime_s: Math.floor(process.uptime()),
    },
  });
});

router.post('/sms/test', async (req, res) => {
  const { sendSMS, fillTemplate } = require('../utils/sms');
  const phone = req.body.test_phone;
  if (!phone) { flash(req, 'danger', 'Enter a phone number to test'); return res.redirect('/settings/sms'); }
  // Use a chosen template (real DLT test) when given; else a plain stub.
  const t = req.body.template_id ? db.prepare('SELECT * FROM sms_templates WHERE id=?').get(req.body.template_id) : null;
  let payload;
  if (t) {
    const keys = String(t.var_order || '').split(',').map(s => s.trim()).filter(Boolean);
    const sample = {};
    keys.forEach(k => { sample[k] = (k === 'amount' || k === 'outstanding') ? '100.00' : (k === 'count' ? '1' : 'Test'); });
    const vars = Object.assign({ company: getSetting('COMPANY_NAME', 'Sharv Enterprises') }, sample);
    payload = { to: phone, message: fillTemplate(t.body, vars), template: t.event, dlt_template_id: t.dlt_template_id, sender_id: t.sender_id, variables_values: keys.map(k => sample[k]).join('|') };
  } else {
    payload = { to: phone, message: 'Portal ERP test message — SMS config is working.' };
  }
  const r = await sendSMS(payload);
  if (r.stub)    flash(req, 'warning', 'Test/Off mode — message logged only. Switch SMS Mode to Fast2SMS to send real SMS.');
  else if (r.ok) flash(req, 'success', 'Test SMS dispatched via Fast2SMS. Check the phone in a moment.');
  else           flash(req, 'danger', 'Failed: ' + (r.error || 'unknown error'));
  res.redirect('/settings/sms');
});

// ---------- Access Control / Roles overview (editable matrix) ----------
// Features are organized into sections so the matrix is scannable. Adding
// a new module? Add an entry here AND an entry in db/index.js featureDefaults
// (so existing role_permissions get the column).
// Each feature can declare a `parent` to indicate it's a fine-grained
// sub-feature of an umbrella key (e.g. `hr_payroll` falls under `hr`).
// Parents are still listed as their own row — useful for legacy guards and
// as a "set everything in this area" shortcut. Sub-features inherit from
// the parent at runtime (see middleware/permissions.js) when no explicit
// row exists, so the matrix remains consistent for existing installs.
const FEATURE_SECTIONS = [
  { title: 'Core', features: [
    { key: 'dashboard', label: 'Dashboard',          desc: 'Home page with KPI cards' },
  ]},
  { title: 'Inventory & Production', features: [
    { key: 'products',     label: 'Products / Categories', desc: 'Product master, hangtags, BOM' },
    { key: 'materials',    label: 'Raw Materials / Suppliers', desc: 'Raw stock + supplier prices' },
    { key: 'bom',          label: 'BOM (per product)',     desc: 'Bill of materials editor' },
    { key: 'production',   label: 'Production Batches',    desc: 'Batches, stages, worker entries' },
    { key: 'fabric_costs', label: 'Fabric Cost / Mfg Expenses', desc: 'Costing tools + monthly expenses' },
    { key: 'stock',        label: 'Ready Stock & Movements', desc: 'Finished-goods stock, piece tracking' },
  ]},
  { title: 'Sales', features: [
    { key: 'dealers',        label: 'Dealers',                 desc: 'Customer master, credit limits' },
    { key: 'sales',          label: 'Sales — overall',         desc: 'Umbrella; granular controls below' },
    { key: 'sales_orders',   label: 'Sales Orders',            desc: 'Quotes, draft orders, discounts',                   parent: 'sales' },
    { key: 'sales_invoices', label: 'GST Invoices',            desc: 'Final tax invoices — usually accountant/admin only', parent: 'sales' },
    { key: 'payments',       label: 'Payments',                desc: 'Receive, verify, reconcile' },
    { key: 'dispatch',       label: 'Dispatch & Returns',      desc: 'Shipping + customer returns' },
    { key: 'visits',         label: 'Field Visits & Prospects', desc: 'Geo-tagged visits, photos, Route Plan, prospect → dealer conversion' },
    { key: 'factory_log',    label: 'Factory In/Out (attendance)', desc: 'GPS-verified punch in/out with photo. "limited" = own only, "full" = see whole team log' },
  ]},
  { title: 'Purchasing', features: [
    { key: 'purchasing', label: 'Purchasing & Vendor Prices', desc: 'POs, vendor compare' },
  ]},
  { title: 'HR & Payroll', features: [
    { key: 'hr',            label: 'HR — overall',  desc: 'Umbrella; granular controls below' },
    { key: 'hr_employees',  label: 'Employees & KYC', desc: 'Employee master, photo/KYC, work-types',  parent: 'hr' },
    { key: 'hr_attendance', label: 'Attendance / Pieces / KM', desc: 'Daily marking, biometric sync, per-piece work, mileage', parent: 'hr' },
    { key: 'hr_payroll',    label: 'Payroll & Advances', desc: 'Salary slips + register, advances, incentives — sensitive', parent: 'hr' },
    { key: 'hr_documents',  label: 'Documents, Handbook & Compliance', desc: 'Offer/appointment/exit letters, Policy Handbook, probation & document compliance, documents register', parent: 'hr' },
  ]},
  { title: 'Reports & Audit', features: [
    { key: 'reports',            label: 'Reports — overall',   desc: 'Umbrella; granular controls below' },
    { key: 'reports_sales',      label: 'Sales reports',       desc: 'Sales / dealer / product / salesperson / geo / by-office', parent: 'reports' },
    { key: 'reports_production', label: 'Production reports',  desc: 'Production, efficiency, stock, material consumption',       parent: 'reports' },
    { key: 'reports_finance',    label: 'Finance reports',     desc: 'Collection, outstanding, aged AR, dealer statement, GST summary, invoice register — sensitive',  parent: 'reports' },
    { key: 'activity',           label: 'Activity Log (audit trail)', desc: 'Who did what, when' },
  ]},
  { title: 'Tasks & Workflow', features: [
    { key: 'tasks', label: 'Tasks / To-dos', desc: 'Assignable tasks with deadline, status & comments. "full" assigns to others & deletes; "limited" = own tasks only' },
    { key: 'admin_funds', label: 'Admin Funds (cash floats)', desc: 'Per-admin cash float for mfg expenses. "full" = set up funds, record top-ups & see all funds (grant this to delegate the owner\'s fund control). "view" = see own balance + transactions only.' },
  ]},
  { title: 'Communication & Help', features: [
    { key: 'notifications', label: 'Notifications (SMS)', desc: 'Outbound messages to dealers' },
    { key: 'surveys',       label: 'Surveys & Feedback',  desc: 'Build surveys, share the public link / push via SMS, view responses & reports. "view" = see results; "limited"+ = create & send.' },
    { key: 'sms_reports',   label: 'SMS Reports',         desc: 'Read-only deep report of every SMS — sent/failed/queued, gateway reason, request id, per-event breakdown & bulk-job history.' },
    { key: 'training',      label: 'Training Module',     desc: 'Read-only learning slides + guides' },
  ]},
  { title: 'AI / Catalogue', features: [
    { key: 'catalogue', label: 'AI Catalogue', desc: 'Generate model-on / multi-angle catalogue photos via fal.ai (paid per image)' },
  ]},
  { title: 'Website', features: [
    { key: 'website',            label: 'Website — overall',  desc: 'Umbrella; granular controls below. "full" = edit content, SEO, products, certifications, blog, Instagram & brand kit of the public site (sharvexports.com)' },
    { key: 'website_enquiries',  label: 'Website — Buyer Enquiries', desc: 'Leads inbox from the public site + convert a lead to a dealer. "limited" lets a salesperson work & convert leads.', parent: 'website' },
    { key: 'website_insights',   label: 'Website — Insights (Analytics & ranking)', desc: 'Google Analytics visitors + Search Console ranking. "view" = see the numbers; "full" = change the Google connection settings.', parent: 'website' },
    { key: 'website_careers',    label: 'Website — Careers & Hiring', desc: 'Public job openings + applications inbox (view CVs, update status). "view" = read applicants; "full" = add/edit openings & manage applications. Good for HR.', parent: 'website' },
    { key: 'website_brand',      label: 'Website — Logo & Brand Kit', desc: 'Open & download brand stationery (letterhead, business card, envelope) and the logo/brand-kit page. "view" = open/print.', parent: 'website' },
  ]},
  { title: 'Admin (granular)', features: [
    { key: 'settings',               label: 'Settings — overall', desc: 'Umbrella; granular controls below' },
    { key: 'settings_users',         label: 'User management',    desc: 'Create / edit / disable users',           parent: 'settings' },
    { key: 'settings_access',        label: 'Roles & access matrix', desc: 'Edit this very page',                   parent: 'settings' },
    { key: 'settings_locations',     label: 'Offices / Locations', desc: 'Head office, regional offices, warehouses (drives stock pools & route plans)', parent: 'settings' },
    { key: 'settings_payment_modes', label: 'Payment modes',      desc: 'Cash / UPI / cheque / bank list',         parent: 'settings' },
    { key: 'settings_categories',    label: 'Categories',         desc: 'Product/material categories',             parent: 'settings' },
    { key: 'settings_sms',           label: 'SMS settings',       desc: 'Capcom gateway, templates, test SMS',     parent: 'settings' },
    { key: 'settings_stages',        label: 'Production stages',  desc: 'Custom stages master',                    parent: 'settings' },
    { key: 'settings_import',        label: 'Data import',        desc: 'CSV bulk import',                         parent: 'settings' },
  ]},
];
// Flat list for backward-compat (used by the validation in /access/update)
const FEATURES = FEATURE_SECTIONS.flatMap(s => s.features);
const LEVELS = ['none', 'view', 'limited', 'full'];

// Roles are now stored in the `roles` table (custom roles can be added by
// the owner). currentRoles() returns the canonical ordered list every time
// it's called so it reflects the live DB state without restart.
function currentRoles() {
  return db.prepare('SELECT role_key FROM roles ORDER BY sort_order, id').all().map(r => r.role_key);
}
function currentRoleRecords() {
  return db.prepare('SELECT id, role_key, label, is_system, sort_order FROM roles ORDER BY sort_order, id').all();
}

router.get('/access', (req, res) => {
  const users = db.prepare('SELECT id,name,email,phone,role,active FROM users ORDER BY role, name').all();
  const rows = db.prepare('SELECT role, feature_key, level FROM role_permissions').all();
  const roles = currentRoles();
  const roleRecords = currentRoleRecords();
  // Build a lookup: matrix[role][feature_key] = level
  const matrix = {};
  roles.forEach(r => { matrix[r] = {}; });
  rows.forEach(r => { if (matrix[r.role]) matrix[r.role][r.feature_key] = r.level; });
  res.render('settings/access', {
    title: 'User Access & Roles',
    users, matrix,
    features: FEATURES, sections: FEATURE_SECTIONS,
    roles, roleRecords, levels: LEVELS,
  });
});

router.post('/access/update', (req, res) => {
  const { role, feature_key, level } = req.body;
  const validRoles = currentRoles();
  if (!validRoles.includes(role) || !FEATURES.find(f => f.key === feature_key) || !LEVELS.includes(level)) {
    return res.status(400).json({ ok: false, error: 'invalid' });
  }
  if (role === 'owner') return res.status(400).json({ ok: false, error: 'owner permissions cannot be changed' });
  db.prepare(`INSERT INTO role_permissions (role, feature_key, level, updated_by) VALUES (?,?,?,?)
              ON CONFLICT(role, feature_key) DO UPDATE SET level=excluded.level, updated_at=datetime('now'), updated_by=excluded.updated_by`)
    .run(role, feature_key, level, req.session.user.id);
  req.audit('permission_change', 'role_permissions', null, `${role} / ${feature_key} → ${level}`);
  res.json({ ok: true });
});

// ── Custom roles management (owner-only sub-section) ──
// Only the owner can create/rename/delete roles — keeps the access
// hierarchy from being modified by admin-level escalation.
function ownerOnly(req, res, next) {
  if (req.session.user && req.session.user.role === 'owner') return next();
  return res.status(403).json({ ok: false, error: 'owner only' });
}

router.post('/access/roles', ownerOnly, (req, res) => {
  const label = (req.body.label || '').trim();
  // Slugify: lowercase, alphanumerics + underscores only, max 32 chars.
  const role_key = (req.body.role_key || label).toLowerCase().trim().replace(/[^a-z0-9_]/g, '_').slice(0, 32);
  if (!label || !role_key) return res.status(400).json({ ok: false, error: 'label required' });
  try {
    const r = db.prepare('INSERT INTO roles (role_key, label, is_system, sort_order) VALUES (?,?,0,?)')
      .run(role_key, label, 100 + db.prepare('SELECT COUNT(*) AS n FROM roles').get().n);
    // Seed default permissions for the new role — start with everything 'none'
    // so the owner explicitly grants what's needed.
    const features = FEATURES.map(f => f.key);
    const ins = db.prepare('INSERT OR IGNORE INTO role_permissions (role, feature_key, level) VALUES (?,?,?)');
    features.forEach(fk => ins.run(role_key, fk, 'none'));
    req.audit('role_create', 'roles', r.lastInsertRowid, `${role_key} (${label})`);
    res.json({ ok: true, role: { id: r.lastInsertRowid, role_key, label } });
  } catch (e) {
    res.status(400).json({ ok: false, error: /UNIQUE/.test(e.message) ? 'role_key already exists' : e.message });
  }
});

router.post('/access/roles/:id', ownerOnly, (req, res) => {
  const target = db.prepare('SELECT id, role_key, is_system FROM roles WHERE id=?').get(req.params.id);
  if (!target) return res.status(404).json({ ok: false, error: 'not found' });
  if (target.is_system) return res.status(400).json({ ok: false, error: 'system roles cannot be renamed' });
  const label = (req.body.label || '').trim();
  if (!label) return res.status(400).json({ ok: false, error: 'label required' });
  db.prepare("UPDATE roles SET label=?, updated_at=datetime('now') WHERE id=?").run(label, req.params.id);
  req.audit('role_rename', 'roles', target.id, `${target.role_key} → "${label}"`);
  res.json({ ok: true });
});

router.post('/access/roles/:id/delete', ownerOnly, (req, res) => {
  const target = db.prepare('SELECT id, role_key, is_system FROM roles WHERE id=?').get(req.params.id);
  if (!target) return res.status(404).json({ ok: false, error: 'not found' });
  if (target.is_system) return res.status(400).json({ ok: false, error: 'built-in roles cannot be deleted' });
  const inUse = db.prepare('SELECT COUNT(*) AS n FROM users WHERE role=?').get(target.role_key).n;
  if (inUse > 0) return res.status(400).json({ ok: false, error: `${inUse} user(s) still use this role` });
  db.prepare('DELETE FROM role_permissions WHERE role=?').run(target.role_key);
  db.prepare('DELETE FROM roles WHERE id=?').run(req.params.id);
  req.audit('role_delete', 'roles', target.id, target.role_key);
  res.json({ ok: true });
});

// ── Per-user permission overrides ──
// JSON endpoints used by the "Custom Access" panel on the user edit page.
router.get('/access/user/:id', (req, res) => {
  // Only owner+admin (already gated by router.use(requireRole('admin'))) get here.
  const u = db.prepare('SELECT id, name, email, role FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ ok: false, error: 'not found' });
  if (u.role === 'owner' && req.session.user.role !== 'owner') {
    return res.status(403).json({ ok: false, error: 'owner overrides are owner-only' });
  }
  const overrides = db.prepare('SELECT feature_key, level FROM user_permissions WHERE user_id=?').all(u.id);
  // Build current effective map for context.
  const { getAllPermsForUser } = require('../middleware/permissions');
  res.json({ ok: true, user: u, overrides, effective: getAllPermsForUser(u), features: FEATURES });
});

router.post('/access/user/:id', (req, res) => {
  const u = db.prepare('SELECT id, role FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ ok: false, error: 'not found' });
  if (u.role === 'owner' && req.session.user.role !== 'owner') {
    return res.status(403).json({ ok: false, error: 'owner overrides are owner-only' });
  }
  const { feature_key, level } = req.body;
  if (!FEATURES.find(f => f.key === feature_key)) return res.status(400).json({ ok: false, error: 'unknown feature' });
  // 'inherit' = remove the override (revert to role default)
  if (level === 'inherit') {
    db.prepare('DELETE FROM user_permissions WHERE user_id=? AND feature_key=?').run(u.id, feature_key);
    req.audit('user_perm_clear', 'user_permissions', u.id, `${feature_key} → inherit`);
    return res.json({ ok: true, level: 'inherit' });
  }
  if (!LEVELS.includes(level)) return res.status(400).json({ ok: false, error: 'invalid level' });
  db.prepare(`INSERT INTO user_permissions (user_id, feature_key, level, updated_by) VALUES (?,?,?,?)
              ON CONFLICT(user_id, feature_key) DO UPDATE SET level=excluded.level, updated_at=datetime('now'), updated_by=excluded.updated_by`)
    .run(u.id, feature_key, level, req.session.user.id);
  req.audit('user_perm_set', 'user_permissions', u.id, `${feature_key} → ${level}`);
  res.json({ ok: true, level });
});

// Helper used elsewhere to check a user's level for a feature
function getUserLevel(userRole, featureKey) {
  if (userRole === 'owner') return 'full';
  const r = db.prepare('SELECT level FROM role_permissions WHERE role=? AND feature_key=?').get(userRole, featureKey);
  return r ? r.level : 'none';
}


// ---------- Custom Production Stages ----------
router.get('/stages', (req, res) => {
  const stages = db.prepare('SELECT * FROM production_stages_master ORDER BY sort_order, id').all();
  res.render('settings/stages', { title: 'Production Stages', stages });
});

router.post('/stages', (req, res) => {
  const { stage_key, label, sort_order } = req.body;
  const key = (stage_key || label).toLowerCase().trim().replace(/[^a-z0-9_]/g, '_');
  if (!key || !label) { flash(req, 'danger', 'Need stage key and label'); return res.redirect('/settings/stages'); }
  try {
    db.prepare('INSERT INTO production_stages_master (stage_key, label, sort_order) VALUES (?,?,?)').run(key, label, parseInt(sort_order || 100));
    flash(req, 'success', 'Stage added.');
  } catch (e) {
    flash(req, 'danger', /UNIQUE/.test(e.message) ? 'A stage with that key already exists.' : e.message);
  }
  res.redirect('/settings/stages');
});

router.post('/stages/:id/update', (req, res) => {
  const { label, sort_order, active } = req.body;
  db.prepare('UPDATE production_stages_master SET label=?, sort_order=?, active=? WHERE id=?')
    .run(label, parseInt(sort_order || 100), active ? 1 : 0, req.params.id);
  flash(req, 'success', 'Stage updated.');
  res.redirect('/settings/stages');
});

router.post('/stages/:id/delete', (req, res) => {
  const s = db.prepare('SELECT * FROM production_stages_master WHERE id=?').get(req.params.id);
  if (!s) return res.redirect('/settings/stages');
  if (s.is_default) { flash(req, 'danger', 'Cannot delete a default stage; deactivate instead.'); return res.redirect('/settings/stages'); }
  db.prepare('DELETE FROM production_stages_master WHERE id=?').run(req.params.id);
  flash(req, 'success', 'Stage deleted.');
  res.redirect('/settings/stages');
});

// Helper function exported for use elsewhere
function getActiveStages() {
  return db.prepare('SELECT * FROM production_stages_master WHERE active=1 ORDER BY sort_order, id').all();
}

module.exports = router;
module.exports.getSetting = getSetting;
module.exports.setSetting = setSetting;
module.exports.getActiveStages = getActiveStages;
module.exports.getUserLevel = getUserLevel;
module.exports.getBranding = getBranding;
