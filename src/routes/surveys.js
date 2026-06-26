const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { slugify } = require('../db/surveySeed');
const { toCsv, sendCsv } = require('../utils/csv');
const router = express.Router();

const QTYPES = ['rating', 'nps', 'single', 'multi', 'yesno', 'text'];
const CHOICE = new Set(['single', 'multi']);

function uniqueSlug(base, excludeId) {
  let slug = base || 'survey', n = 1;
  while (true) {
    const row = db.prepare('SELECT id FROM surveys WHERE slug=?').get(slug);
    if (!row || row.id === excludeId) return slug;
    slug = (base || 'survey') + '-' + (++n);
  }
}
function publicUrl(slug) {
  let origin = 'https://sharvexports.com';
  try { origin = require('../utils/seoAudit').siteOrigin(); } catch (_) {}
  return origin + '/survey/' + slug;
}
function getSurvey(id) { return db.prepare('SELECT * FROM surveys WHERE id=?').get(id); }
function questionsOf(id) {
  return db.prepare('SELECT * FROM survey_questions WHERE survey_id=? ORDER BY position, id').all(id)
    .map(q => Object.assign(q, { options: q.options_json ? JSON.parse(q.options_json) : [], options_hi: q.options_hi_json ? JSON.parse(q.options_hi_json) : [] }));
}
function respCount(id) { return db.prepare('SELECT COUNT(*) AS n FROM survey_responses WHERE survey_id=?').get(id).n; }
// Find the SMS template that carries the survey link. Primary match is
// event='survey'; fall back to the {link} body in case its event was changed.
function surveyTemplate() {
  return db.prepare("SELECT id FROM sms_templates WHERE active=1 AND (event='survey' OR label='Survey invitation' OR body LIKE '%{link}%') ORDER BY (event='survey') DESC LIMIT 1").get();
}

// Build per-question aggregates for the report.
function aggregate(surveyId) {
  const qs = questionsOf(surveyId);
  return qs.map(q => {
    const vals = db.prepare(`SELECT a.value AS v FROM survey_answers a JOIN survey_responses r ON r.id=a.response_id
                             WHERE r.survey_id=? AND a.question_id=? AND a.value IS NOT NULL AND a.value<>''`).all(surveyId, q.id).map(r => r.v);
    const out = { q, n: vals.length };
    if (q.qtype === 'rating') {
      const nums = vals.map(Number).filter(n => !isNaN(n));
      out.avg = nums.length ? (nums.reduce((a, b) => a + b, 0) / nums.length) : 0;
      out.dist = [1, 2, 3, 4, 5].map(s => ({ s, c: nums.filter(n => n === s).length }));
    } else if (q.qtype === 'nps') {
      const nums = vals.map(Number).filter(n => !isNaN(n));
      const prom = nums.filter(n => n >= 9).length, det = nums.filter(n => n <= 6).length;
      out.avg = nums.length ? (nums.reduce((a, b) => a + b, 0) / nums.length) : 0;
      out.nps = nums.length ? Math.round((prom - det) / nums.length * 100) : 0;
      out.promoters = prom; out.passives = nums.length - prom - det; out.detractors = det;
    } else if (q.qtype === 'multi') {
      const counts = {};
      vals.forEach(v => String(v).split(' | ').forEach(o => { o = o.trim(); if (o) counts[o] = (counts[o] || 0) + 1; }));
      out.options = (q.options.length ? q.options : Object.keys(counts)).map(o => ({ o, c: counts[o] || 0 }));
    } else if (q.qtype === 'single' || q.qtype === 'yesno') {
      const counts = {};
      vals.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
      const keys = q.qtype === 'yesno' ? ['Yes', 'No'] : (q.options.length ? q.options : Object.keys(counts));
      out.options = keys.map(o => ({ o, c: counts[o] || 0 }));
    } else { // text
      out.texts = vals.slice(-30).reverse();
    }
    return out;
  });
}

// ── List ──────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const surveys = db.prepare('SELECT * FROM surveys ORDER BY active DESC, id DESC').all()
    .map(s => Object.assign(s, { responses: respCount(s.id), questions: db.prepare('SELECT COUNT(*) AS n FROM survey_questions WHERE survey_id=?').get(s.id).n, url: publicUrl(s.slug) }));
  res.render('surveys/index', { title: 'Surveys & Feedback', surveys });
});

router.get('/new', (req, res) => {
  res.render('surveys/form', { title: 'New Survey', survey: null, questions: [], QTYPES });
});
router.post('/', (req, res) => {
  const f = req.body;
  if (!f.title || !f.title.trim()) { flash(req, 'danger', 'Survey title is required.'); return res.redirect('/surveys/new'); }
  const slug = uniqueSlug(slugify(f.slug || f.title));
  const id = db.prepare('INSERT INTO surveys (slug,title,title_hi,description,description_hi,thank_you,thank_you_hi,active,created_by) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(slug, f.title.trim(), (f.title_hi || '').trim() || null, (f.description || '').trim() || null, (f.description_hi || '').trim() || null,
      (f.thank_you || '').trim() || 'Thank you for your feedback!', (f.thank_you_hi || '').trim() || null, f.active === '0' ? 0 : 1, req.session.user.id).lastInsertRowid;
  req.audit('create', 'survey', id, f.title.trim());
  flash(req, 'success', 'Survey created — now add your questions.');
  res.redirect('/surveys/' + id + '/edit');
});

// ── Report (default) ──────────────────────────────────────────
router.get('/:id', (req, res) => {
  const survey = getSurvey(req.params.id);
  if (!survey) return res.redirect('/surveys');
  res.render('surveys/report', {
    title: survey.title, survey, url: publicUrl(survey.slug),
    total: respCount(survey.id), report: aggregate(survey.id),
    recent: db.prepare('SELECT * FROM survey_responses WHERE survey_id=? ORDER BY id DESC LIMIT 10').all(survey.id),
    smsTemplate: surveyTemplate(),
    offices: db.prepare("SELECT id, name FROM locations WHERE active=1 AND is_office=1 ORDER BY id").all(),
  });
});

// ── Editor ────────────────────────────────────────────────────
router.get('/:id/edit', (req, res) => {
  const survey = getSurvey(req.params.id);
  if (!survey) return res.redirect('/surveys');
  res.render('surveys/form', { title: 'Edit Survey', survey, questions: questionsOf(survey.id), QTYPES });
});
router.post('/:id', (req, res) => {
  const survey = getSurvey(req.params.id);
  if (!survey) return res.redirect('/surveys');
  const f = req.body;
  const slug = f.slug ? uniqueSlug(slugify(f.slug), survey.id) : survey.slug;
  db.prepare("UPDATE surveys SET slug=?, title=?, title_hi=?, description=?, description_hi=?, thank_you=?, thank_you_hi=?, active=?, updated_at=datetime('now') WHERE id=?")
    .run(slug, (f.title || survey.title).trim(), (f.title_hi || '').trim() || null, (f.description || '').trim() || null, (f.description_hi || '').trim() || null,
      (f.thank_you || '').trim() || null, (f.thank_you_hi || '').trim() || null, f.active === '0' ? 0 : 1, survey.id);
  flash(req, 'success', 'Survey saved.');
  res.redirect('/surveys/' + survey.id + '/edit');
});

// ── Questions ─────────────────────────────────────────────────
function parseOptions(qtype, raw) {
  if (!CHOICE.has(qtype)) return null;
  const arr = String(raw || '').split('\n').map(s => s.trim()).filter(Boolean);
  return arr.length ? JSON.stringify(arr) : null;
}
router.post('/:id/questions', (req, res) => {
  const survey = getSurvey(req.params.id);
  if (!survey) return res.redirect('/surveys');
  const f = req.body;
  const qtype = QTYPES.includes(f.qtype) ? f.qtype : 'rating';
  if (!f.qtext || !f.qtext.trim()) { flash(req, 'danger', 'Question text is required.'); return res.redirect('/surveys/' + survey.id + '/edit'); }
  const pos = (db.prepare('SELECT MAX(position) AS m FROM survey_questions WHERE survey_id=?').get(survey.id).m || 0) + 1;
  db.prepare('INSERT INTO survey_questions (survey_id,position,qtype,qtext,qtext_hi,options_json,options_hi_json,required) VALUES (?,?,?,?,?,?,?,?)')
    .run(survey.id, pos, qtype, f.qtext.trim(), (f.qtext_hi || '').trim() || null, parseOptions(qtype, f.options), parseOptions(qtype, f.options_hi), f.required === '0' ? 0 : 1);
  res.redirect('/surveys/' + survey.id + '/edit');
});
router.post('/:id/questions/:qid', (req, res) => {
  const f = req.body;
  const qtype = QTYPES.includes(f.qtype) ? f.qtype : 'rating';
  db.prepare('UPDATE survey_questions SET qtype=?, qtext=?, qtext_hi=?, options_json=?, options_hi_json=?, required=? WHERE id=? AND survey_id=?')
    .run(qtype, (f.qtext || '').trim(), (f.qtext_hi || '').trim() || null, parseOptions(qtype, f.options), parseOptions(qtype, f.options_hi), f.required === '0' ? 0 : 1, req.params.qid, req.params.id);
  flash(req, 'success', 'Question updated.');
  res.redirect('/surveys/' + req.params.id + '/edit');
});
router.post('/:id/questions/:qid/delete', (req, res) => {
  db.prepare('DELETE FROM survey_questions WHERE id=? AND survey_id=?').run(req.params.qid, req.params.id);
  res.redirect('/surveys/' + req.params.id + '/edit');
});
router.post('/:id/questions/:qid/move', (req, res) => {
  const dir = req.body.dir === 'up' ? -1 : 1;
  const q = db.prepare('SELECT * FROM survey_questions WHERE id=? AND survey_id=?').get(req.params.qid, req.params.id);
  if (q) {
    const sib = db.prepare(`SELECT * FROM survey_questions WHERE survey_id=? AND position ${dir < 0 ? '<' : '>'}? ORDER BY position ${dir < 0 ? 'DESC' : 'ASC'} LIMIT 1`).get(req.params.id, q.position);
    if (sib) {
      db.prepare('UPDATE survey_questions SET position=? WHERE id=?').run(sib.position, q.id);
      db.prepare('UPDATE survey_questions SET position=? WHERE id=?').run(q.position, sib.id);
    }
  }
  res.redirect('/surveys/' + req.params.id + '/edit');
});

// ── Toggle / duplicate / delete ───────────────────────────────
router.post('/:id/toggle', (req, res) => {
  db.prepare("UPDATE surveys SET active = CASE active WHEN 1 THEN 0 ELSE 1 END, updated_at=datetime('now') WHERE id=?").run(req.params.id);
  res.redirect('/surveys');
});
router.post('/:id/duplicate', (req, res) => {
  const s = getSurvey(req.params.id);
  if (!s) return res.redirect('/surveys');
  const slug = uniqueSlug(slugify(s.title + ' copy'));
  const nid = db.prepare('INSERT INTO surveys (slug,title,title_hi,description,description_hi,thank_you,thank_you_hi,active,created_by) VALUES (?,?,?,?,?,?,?,0,?)')
    .run(slug, s.title + ' (copy)', s.title_hi, s.description, s.description_hi, s.thank_you, s.thank_you_hi, req.session.user.id).lastInsertRowid;
  db.prepare('SELECT * FROM survey_questions WHERE survey_id=? ORDER BY position').all(s.id)
    .forEach(q => db.prepare('INSERT INTO survey_questions (survey_id,position,qtype,qtext,qtext_hi,options_json,options_hi_json,required) VALUES (?,?,?,?,?,?,?,?)')
      .run(nid, q.position, q.qtype, q.qtext, q.qtext_hi, q.options_json, q.options_hi_json, q.required));
  flash(req, 'success', 'Survey duplicated (as a draft).');
  res.redirect('/surveys/' + nid + '/edit');
});
router.post('/:id/delete', (req, res) => {
  const id = req.params.id;
  db.prepare('DELETE FROM survey_answers WHERE response_id IN (SELECT id FROM survey_responses WHERE survey_id=?)').run(id);
  db.prepare('DELETE FROM survey_responses WHERE survey_id=?').run(id);
  db.prepare('DELETE FROM survey_questions WHERE survey_id=?').run(id);
  db.prepare('DELETE FROM surveys WHERE id=?').run(id);
  req.audit('delete', 'survey', id, '');
  flash(req, 'success', 'Survey deleted.');
  res.redirect('/surveys');
});

// ── Responses + CSV ───────────────────────────────────────────
router.get('/:id/responses', (req, res) => {
  const survey = getSurvey(req.params.id);
  if (!survey) return res.redirect('/surveys');
  const qs = questionsOf(survey.id);
  const responses = db.prepare('SELECT * FROM survey_responses WHERE survey_id=? ORDER BY id DESC LIMIT 300').all(survey.id)
    .map(r => {
      const ans = {};
      db.prepare('SELECT question_id, value FROM survey_answers WHERE response_id=?').all(r.id).forEach(a => { ans[a.question_id] = a.value; });
      return Object.assign(r, { ans });
    });
  res.render('surveys/responses', { title: survey.title + ' — Responses', survey, questions: qs, responses });
});
router.get('/:id/responses.csv', (req, res) => {
  const survey = getSurvey(req.params.id);
  if (!survey) return res.redirect('/surveys');
  const qs = questionsOf(survey.id);
  const rows = db.prepare('SELECT * FROM survey_responses WHERE survey_id=? ORDER BY id').all(survey.id).map(r => {
    const ans = {};
    db.prepare('SELECT question_id, value FROM survey_answers WHERE response_id=?').all(r.id).forEach(a => { ans[a.question_id] = a.value; });
    const row = { Date: r.submitted_at, Name: r.name || '', Phone: r.phone || '', Source: r.source };
    qs.forEach((q, i) => { row['Q' + (i + 1) + '. ' + q.qtext.slice(0, 40)] = ans[q.id] || ''; });
    return row;
  });
  const columns = ['Date', 'Name', 'Phone', 'Source', ...qs.map((q, i) => 'Q' + (i + 1) + '. ' + q.qtext.slice(0, 40))];
  sendCsv(res, (survey.slug || 'survey') + '-responses.csv', toCsv(rows, columns));
});

// ── Push the survey link via SMS (reuses the SMS broadcast engine) ──
router.post('/:id/send-sms', (req, res) => {
  const survey = getSurvey(req.params.id);
  if (!survey) return res.redirect('/surveys');
  const tpl = surveyTemplate();
  if (!tpl) { flash(req, 'danger', 'No active "survey" SMS template. Add one in Settings → SMS Settings.'); return res.redirect('/surveys/' + survey.id); }
  const jobId = require('../utils/broadcast').startBroadcast(
    { templateId: tpl.id, audience: req.body.audience || 'all', officeId: req.body.office_id || null, extra: { link: publicUrl(survey.slug) + '?src=sms' } },
    { userId: req.session.user.id, label: 'Survey: ' + survey.title + ' → ' + (req.body.audience || 'all') });
  flash(req, 'success', 'Survey link is sending in the background. Live status is shown below.');
  res.redirect('/surveys/' + survey.id + '?job=' + jobId);
});

// Live status for a background SMS job (polled by the survey report page).
router.get('/jobs/:id', (req, res) => {
  const j = require('../utils/smsJobs').get(req.params.id);
  if (!j) return res.json({ ok: false });
  res.json({ ok: true, total: j.total, sent: j.sent, skipped: j.skipped, failed: j.failed, status: j.status, error: j.error });
});

module.exports = router;
