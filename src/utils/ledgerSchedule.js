// Scheduled "ledger / balance awareness" SMS broadcast. At a configured
// time (daily/weekly/monthly, IST) it texts each dealer their official
// outstanding balance — so dealers always know the true figure and a
// salesperson can't mis-state a payment. In-process timer (the server is
// long-running); last-run date is persisted so a restart never double-sends.
const { db } = require('../db');
const { sendSMS, fillTemplate, setting } = require('./sms');
const { outstandingForDealer, buildValues } = require('./notify');

function get(key, fb) {
  const r = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  return (r && r.value != null && r.value !== '') ? r.value : fb;
}
function set(key, value) {
  db.prepare(`INSERT INTO app_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value);
}
function brand() { return get('COMPANY_NAME', 'Sharv Enterprises'); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Which template the broadcast uses: explicit pick → active 'ledger' →
// active 'outstanding' as a last resort.
function ledgerTemplate() {
  const id = get('LEDGER_SMS_TEMPLATE_ID', '');
  if (id) { const t = db.prepare('SELECT * FROM sms_templates WHERE id=?').get(id); if (t) return t; }
  return db.prepare("SELECT * FROM sms_templates WHERE event='ledger' AND active=1 ORDER BY id LIMIT 1").get()
      || db.prepare("SELECT * FROM sms_templates WHERE event='outstanding' AND active=1 ORDER BY id LIMIT 1").get();
}

// How many dealers a run would currently text (for the settings preview).
function targetCount() {
  const onlyOut = get('LEDGER_SMS_ONLY_OUTSTANDING', '1') === '1';
  const dealers = db.prepare('SELECT id FROM dealers WHERE active=1 AND phone IS NOT NULL').all();
  if (!onlyOut) return dealers.length;
  return dealers.filter((d) => outstandingForDealer(d.id) > 0).length;
}

async function runBroadcast() {
  const t = ledgerTemplate();
  if (!t) return { ok: false, error: 'No ledger template configured', sent: 0, skipped: 0 };
  const onlyOut = get('LEDGER_SMS_ONLY_OUTSTANDING', '1') === '1';
  const dealers = db.prepare('SELECT id,name,phone FROM dealers WHERE active=1 AND phone IS NOT NULL').all();
  let sent = 0, skipped = 0;
  for (const d of dealers) {
    const out = outstandingForDealer(d.id);
    if (onlyOut && out <= 0) { skipped++; continue; }
    const count = db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE dealer_id=? AND status IN ('unpaid','partial')").get(d.id).n;
    const vars = { dealer: d.name, outstanding: out.toFixed(2), amount: out.toFixed(2), count, company: brand() };
    try {
      await sendSMS({ to: d.phone, message: fillTemplate(t.body, vars), template: 'ledger', dlt_template_id: t.dlt_template_id, variables_values: buildValues(t.var_order, vars), dealer_id: d.id });
      sent++;
    } catch (_) { /* sendSMS already logs failures */ }
    await sleep(250); // gentle throttle so we don't hammer the gateway
  }
  return { ok: true, sent, skipped };
}

// "Now" in IST wall-clock as a Date whose getHours()/getDate() read IST.
function istNow() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })); }
function dayKey(d) { return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }

async function ledgerTick() {
  if (get('LEDGER_SMS_ENABLED', '0') !== '1') return;
  if (setting('SMS_PROVIDER', 'off') !== 'fast2sms') return; // only when SMS is live
  const ist = istNow();
  const freq = get('LEDGER_SMS_FREQUENCY', 'weekly');
  const day = parseInt(get('LEDGER_SMS_DAY', '1')) || 0; // weekly: 0=Sun..6=Sat ; monthly: 1..28
  if (freq === 'weekly' && ist.getDay() !== day) return;
  if (freq === 'monthly' && ist.getDate() !== day) return;
  const [H, M] = String(get('LEDGER_SMS_TIME', '10:00')).split(':').map((n) => parseInt(n) || 0);
  if (ist.getHours() * 60 + ist.getMinutes() < H * 60 + M) return;  // time not reached yet
  if (get('LEDGER_SMS_LAST_RUN', '') === dayKey(ist)) return;       // already ran today
  set('LEDGER_SMS_LAST_RUN', dayKey(ist));                          // mark before sending (no double-fire)
  const r = await runBroadcast();
  console.log('[ledger-sms] scheduled broadcast:', JSON.stringify(r));
}

// Fire due one-time campaign broadcasts, only inside the 9am–9pm IST
// promotional window. Each is marked 'sent' before firing (no double-send).
async function broadcastTick() {
  if (setting('SMS_PROVIDER', 'off') !== 'fast2sms') return;
  const ist = istNow();
  if (ist.getHours() < 9 || ist.getHours() >= 21) return;
  const pad = (n) => String(n).padStart(2, '0');
  const nowStr = ist.getFullYear() + '-' + pad(ist.getMonth() + 1) + '-' + pad(ist.getDate()) + ' ' + pad(ist.getHours()) + ':' + pad(ist.getMinutes());
  const due = db.prepare("SELECT * FROM scheduled_broadcasts WHERE status='pending' AND run_at <= ? ORDER BY id LIMIT 3").all(nowStr);
  if (!due.length) return;
  const broadcast = require('./broadcast');
  for (const b of due) {
    db.prepare("UPDATE scheduled_broadcasts SET status='sent' WHERE id=?").run(b.id);
    let extra = {}; try { extra = JSON.parse(b.extra_json || '{}'); } catch (_) {}
    const r = await broadcast.runBroadcast({ templateId: b.template_id, audience: b.audience, officeId: b.office_id, extra });
    db.prepare("UPDATE scheduled_broadcasts SET result=? WHERE id=?").run(JSON.stringify(r), b.id);
    console.log('[broadcast] scheduled #' + b.id, JSON.stringify(r));
  }
}

async function tick() {
  try { await ledgerTick(); } catch (e) { console.error('[ledger-sms] tick error:', e.message); }
  try { await broadcastTick(); } catch (e) { console.error('[broadcast] tick error:', e.message); }
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(tick, 60 * 1000); // check every minute
  tick();
}

module.exports = { start, runBroadcast, targetCount };
