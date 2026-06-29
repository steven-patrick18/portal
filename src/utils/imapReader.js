// Reads incoming replies from the hr@ mailbox via IMAP (Titan / any IMAP host)
// and stores them in email_inbox, matched to candidates by from-address.
// Server blocks SMTP ports but IMAP 993 is open, so this is how we receive.
const { db } = require('../db');

function setting(k) { const r = db.prepare('SELECT value FROM app_settings WHERE key=?').get(k); return r ? r.value : ''; }
function config() {
  return {
    host: (setting('IMAP_HOST') || 'imap.titan.email').trim(),
    port: parseInt(setting('IMAP_PORT')) || 993,
    user: (setting('IMAP_USER') || '').trim(),
    pass: setting('IMAP_PASS') || '',
  };
}
function isConfigured() { const c = config(); return !!(c.host && c.user && c.pass); }

// Pull recent messages FROM a given address into email_inbox (dedup by message-id).
// Returns { ok, count, error }. Never throws.
async function syncFrom(fromEmail, { days = 120 } = {}) {
  if (!isConfigured()) return { ok: false, error: 'IMAP not set up. Add it in Settings → Email.' };
  if (!fromEmail) return { ok: false, error: 'No candidate email to look up.' };
  const c = config();
  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');
  const client = new ImapFlow({ host: c.host, port: c.port, secure: true, auth: { user: c.user, pass: c.pass }, logger: false });
  const ins = db.prepare(`INSERT OR IGNORE INTO email_inbox (message_id, from_email, from_name, subject, body, received_at) VALUES (?,?,?,?,?,?)`);
  let count = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - days * 864e5);
      // Server-side search: only messages FROM this candidate, recent.
      const uids = await client.search({ from: fromEmail, since }, { uid: true });
      const list = (uids || []).slice(-50); // cap
      for (const uid of list) {
        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const p = await simpleParser(msg.source);
        const addr = (p.from && p.from.value && p.from.value[0]) || {};
        ins.run(
          p.messageId || ('uid:' + c.user + ':' + uid),
          (addr.address || fromEmail).toLowerCase(),
          addr.name || null,
          p.subject || '(no subject)',
          (p.text || p.html || '').toString().slice(0, 20000),
          (p.date ? p.date.toISOString() : new Date().toISOString())
        );
        count++;
      }
    } finally { lock.release(); }
    return { ok: true, count };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try { await client.logout(); } catch (_) {}
  }
}

module.exports = { isConfigured, syncFrom, config };
