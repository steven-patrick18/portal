// SMTP email sender (GoDaddy / any SMTP) for HR & candidate communication.
// Config lives in app_settings; templates in email_templates; every send is
// recorded in email_log. Never throws to the caller — returns {ok,error}.
const nodemailer = require('nodemailer');
const { db } = require('../db');

function setting(k) { const r = db.prepare('SELECT value FROM app_settings WHERE key=?').get(k); return r ? r.value : ''; }
function isConfigured() { return !!(setting('SMTP_HOST') && setting('SMTP_USER') && setting('SMTP_PASS')); }

function config() {
  const port = parseInt(setting('SMTP_PORT')) || 465;
  return {
    host: (setting('SMTP_HOST') || '').trim(),
    port,
    secure: setting('SMTP_SECURE') ? setting('SMTP_SECURE') === '1' : port === 465,
    user: (setting('SMTP_USER') || '').trim(),
    pass: setting('SMTP_PASS') || '',
    fromName: (setting('SMTP_FROM_NAME') || '').trim(),
    fromEmail: (setting('SMTP_FROM_EMAIL') || setting('SMTP_USER') || '').trim(),
  };
}

function transport() {
  const c = config();
  return nodemailer.createTransport({
    host: c.host, port: c.port, secure: c.secure,
    auth: { user: c.user, pass: c.pass },
  });
}

// Replace {placeholders} with provided values. Unknown placeholders are left
// blank so a half-filled template never leaks a literal "{date}".
function render(text, vars = {}) {
  return String(text || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : ''));
}

function fromAddress() {
  const c = config();
  return c.fromName ? `"${c.fromName}" <${c.fromEmail}>` : c.fromEmail;
}

// opts: { to, toName, subject, body, templateKey, contextType, contextId, sentBy }
async function send(opts) {
  const ctxType = opts.contextType || opts.context_type || null;
  const ctxId = opts.contextId != null ? opts.contextId : (opts.context_id != null ? opts.context_id : null);
  const log = (status, error) => {
    try {
      db.prepare(`INSERT INTO email_log (to_email,to_name,subject,body,template_key,context_type,context_id,status,error,sent_by)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(opts.to || null, opts.toName || null, opts.subject || null,
        opts.body || null, opts.templateKey || null, ctxType, ctxId,
        status, error || null, opts.sentBy || null);
    } catch (_) {}
  };
  if (!isConfigured()) { log('failed', 'Email not configured'); return { ok: false, error: 'Email is not set up yet. Add SMTP details in Settings → Email.' }; }
  if (!opts.to) { log('failed', 'No recipient'); return { ok: false, error: 'No recipient email address.' }; }
  try {
    await transport().sendMail({
      from: fromAddress(),
      to: opts.toName ? `"${opts.toName}" <${opts.to}>` : opts.to,
      subject: opts.subject || '(no subject)',
      text: opts.body || '',
      html: '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1e293b;line-height:1.6">'
        + String(opts.body || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
        + '</div>',
    });
    log('sent', null);
    return { ok: true };
  } catch (e) {
    log('failed', e.message);
    return { ok: false, error: e.message };
  }
}

// Verify the SMTP connection (used by the "send test" button).
async function verify() {
  if (!isConfigured()) return { ok: false, error: 'Not configured' };
  try { await transport().verify(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { isConfigured, render, send, verify, config };
