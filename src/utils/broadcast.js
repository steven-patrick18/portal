// Campaign / promotional broadcast — sends ANY template to a chosen
// audience (all dealers / only-outstanding / one office), on demand or
// from a scheduled row. Reuses the same DLT send path as the rest of SMS.
const { db } = require('../db');
const { sendSMS, fillTemplate, setting } = require('./sms');
const { outstandingForDealer, buildValues } = require('./notify');

function brand() { return setting('COMPANY_NAME', 'Sharv Enterprises'); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function audienceDealers(audience, officeId) {
  if (audience === 'office' && officeId) {
    return db.prepare('SELECT id,name,phone FROM dealers WHERE active=1 AND phone IS NOT NULL AND office_id=? ORDER BY name').all(officeId);
  }
  return db.prepare('SELECT id,name,phone FROM dealers WHERE active=1 AND phone IS NOT NULL ORDER BY name').all();
}

// How many dealers a given audience would currently reach.
function targetCount(audience, officeId) {
  const list = audienceDealers(audience, officeId);
  if (audience === 'outstanding') return list.filter((d) => outstandingForDealer(d.id) > 0).length;
  return list.length;
}

// extra: literal values for non-dealer template vars (e.g. {festival:'Diwali'}).
// jobId: when set, live progress is written to sms_jobs for the UI to poll.
async function runBroadcast({ templateId, audience = 'all', officeId = null, extra = {}, jobId = null }) {
  const jobs = jobId ? require('./smsJobs') : null;
  const t = db.prepare('SELECT * FROM sms_templates WHERE id=?').get(templateId);
  if (!t) { if (jobs) jobs.finish(jobId, 'error', 'Template not found'); return { ok: false, error: 'Template not found', sent: 0, skipped: 0 }; }
  const dealers = audienceDealers(audience, officeId);
  if (jobs) jobs.setTotal(jobId, dealers.length);
  let sent = 0, skipped = 0, failed = 0;
  for (const d of dealers) {
    const out = outstandingForDealer(d.id);
    if (audience === 'outstanding' && out <= 0) { skipped++; if (jobs) jobs.bump(jobId, 'skipped'); continue; }
    const count = db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE dealer_id=? AND status IN ('unpaid','partial')").get(d.id).n;
    const vars = Object.assign({ dealer: d.name, outstanding: out.toFixed(2), amount: out.toFixed(2), count, company: brand() }, extra || {});
    try {
      const r = await sendSMS({ to: d.phone, message: fillTemplate(t.body, vars), template: t.event, dlt_template_id: t.dlt_template_id, sender_id: t.sender_id, variables_values: buildValues(t.var_order, vars), dealer_id: d.id });
      if (r && r.ok === false) { failed++; if (jobs) jobs.bump(jobId, 'failed'); }
      else { sent++; if (jobs) jobs.bump(jobId, 'sent'); }
    } catch (_) { failed++; if (jobs) jobs.bump(jobId, 'failed'); }
    await sleep(250);
  }
  if (jobs) jobs.finish(jobId, 'done');
  return { ok: true, sent, skipped, failed };
}

// Kick a broadcast off in the BACKGROUND and return the job id immediately, so
// the request doesn't block while hundreds of dealers are texted.
function startBroadcast(opts, { userId, label } = {}) {
  const jobs = require('./smsJobs');
  const jobId = jobs.create({ kind: opts.kind || 'broadcast', label, userId });
  setImmediate(() => {
    runBroadcast(Object.assign({}, opts, { jobId })).catch((e) => jobs.finish(jobId, 'error', e.message));
  });
  return jobId;
}

module.exports = { runBroadcast, startBroadcast, targetCount, audienceDealers };
