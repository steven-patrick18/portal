// Email sender for HR & candidate communication.
// Two delivery methods (cloud servers like DigitalOcean block SMTP ports, so
// the Brevo HTTP API over 443 is the reliable path):
//   EMAIL_METHOD = 'smtp'  → direct SMTP (nodemailer)   [own mailbox]
//   EMAIL_METHOD = 'brevo' → Brevo transactional API    [works behind blocks]
// Config lives in app_settings; templates in email_templates; every send is
// recorded in email_log. Never throws to the caller — returns {ok,error}.
const nodemailer = require('nodemailer');
const { db } = require('../db');

function setting(k) { const r = db.prepare('SELECT value FROM app_settings WHERE key=?').get(k); return r ? r.value : ''; }

function config() {
  const port = parseInt(setting('SMTP_PORT')) || 465;
  return {
    method:    (setting('EMAIL_METHOD') || 'smtp').toLowerCase(),
    host:      (setting('SMTP_HOST') || '').trim(),
    port,
    secure:    setting('SMTP_SECURE') ? setting('SMTP_SECURE') === '1' : port === 465,
    user:      (setting('SMTP_USER') || '').trim(),
    pass:      setting('SMTP_PASS') || '',
    brevoKey:  (setting('BREVO_API_KEY') || '').trim(),
    fromName:  (setting('SMTP_FROM_NAME') || '').trim(),
    fromEmail: (setting('SMTP_FROM_EMAIL') || setting('SMTP_USER') || '').trim(),
  };
}

function isConfigured() {
  const c = config();
  if (c.method === 'brevo') return !!(c.brevoKey && c.fromEmail);
  return !!(c.host && c.user && c.pass);
}

function render(text, vars = {}) {
  return String(text || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : ''));
}
function htmlWrap(body) {
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1e293b;line-height:1.6">'
    + String(body || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
    + '</div>';
}

// ── SMTP transport (direct) ──
function transport() {
  const c = config();
  return nodemailer.createTransport({
    host: c.host, port: c.port, secure: c.secure,
    auth: { user: c.user, pass: c.pass },
    connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000,
  });
}

// ── Brevo HTTP API (over 443 — works when SMTP ports are blocked) ──
async function sendViaBrevo(c, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': c.brevoKey, 'content-type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify({
        sender: c.fromName ? { name: c.fromName, email: c.fromEmail } : { email: c.fromEmail },
        to: [opts.toName ? { email: opts.to, name: opts.toName } : { email: opts.to }],
        subject: opts.subject || '(no subject)',
        textContent: opts.body || '',
        htmlContent: htmlWrap(opts.body),
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { const j = await res.json(); msg = (j && (j.message || j.code)) ? `${j.code || ''} ${j.message || ''}`.trim() : msg; } catch (_) {}
      throw new Error('Brevo: ' + msg);
    }
  } finally { clearTimeout(t); }
}

// opts: { to, toName, subject, body, templateKey, contextType|context_type, contextId|context_id, sentBy }
async function send(opts) {
  const c = config();
  const ctxType = opts.contextType || opts.context_type || null;
  const ctxId = opts.contextId != null ? opts.contextId : (opts.context_id != null ? opts.context_id : null);
  const log = (status, error) => {
    try {
      db.prepare(`INSERT INTO email_log (to_email,to_name,subject,body,template_key,context_type,context_id,status,error,sent_by)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(opts.to || null, opts.toName || null, opts.subject || null,
        opts.body || null, opts.templateKey || null, ctxType, ctxId, status, error || null, opts.sentBy || null);
    } catch (_) {}
  };
  if (!isConfigured()) { log('failed', 'Email not configured'); return { ok: false, error: 'Email is not set up yet. Add details in Settings → Email.' }; }
  if (!opts.to) { log('failed', 'No recipient'); return { ok: false, error: 'No recipient email address.' }; }
  try {
    if (c.method === 'brevo') {
      await sendViaBrevo(c, opts);
    } else {
      await transport().sendMail({
        from: c.fromName ? `"${c.fromName}" <${c.fromEmail}>` : c.fromEmail,
        to: opts.toName ? `"${opts.toName}" <${opts.to}>` : opts.to,
        subject: opts.subject || '(no subject)',
        text: opts.body || '', html: htmlWrap(opts.body),
      });
    }
    log('sent', null);
    return { ok: true };
  } catch (e) {
    log('failed', e.message);
    return { ok: false, error: e.message };
  }
}

async function verify() {
  const c = config();
  if (!isConfigured()) return { ok: false, error: 'Not configured' };
  if (c.method === 'brevo') return { ok: true };  // API key is verified on first send
  try { await transport().verify(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { isConfigured, render, send, verify, config };
