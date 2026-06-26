// Public marketing website (sharvexports.com).
// No authentication — open to the world. Renders standalone premium
// pages from the site_* tables only; never touches ERP business data.
const express = require('express');
const { db } = require('../db');
const router = express.Router();

function safeJson(s, fallback) {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : fallback; } catch (_) { return fallback; }
}
function content() { return db.prepare('SELECT * FROM site_content WHERE id=1').get() || {}; }
function logoPath() { const r = db.prepare("SELECT value FROM app_settings WHERE key='COMPANY_LOGO'").get(); return r ? r.value : ''; }
function ga4Id() { const r = db.prepare("SELECT value FROM app_settings WHERE key='GA4_MEASUREMENT_ID'").get(); return r && r.value ? r.value : ''; }

// Expose the GA4 tag id to every public page (read by _head.ejs).
router.use((req, res, next) => { res.locals.ga4 = ga4Id(); next(); });
function baseUrlOf(req) { return (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host'); }
function publishedPosts(limit) {
  const sql = `SELECT * FROM site_posts WHERE status='published' ORDER BY COALESCE(published_at, created_at) DESC, id DESC` + (limit ? ' LIMIT ' + parseInt(limit) : '');
  return db.prepare(sql).all();
}

// ── Home ──────────────────────────────────────────────────────
function renderHome(req, res, extra) {
  const c = content();
  res.render('site/home', Object.assign({
    layout: false, c, logo: logoPath(), baseUrl: baseUrlOf(req),
    products: db.prepare('SELECT * FROM site_products WHERE active=1 ORDER BY sort, id').all(),
    certs: db.prepare('SELECT * FROM site_certifications WHERE active=1 ORDER BY sort, id').all(),
    instagram: db.prepare('SELECT * FROM site_instagram WHERE active=1 ORDER BY sort, id').all(),
    posts: publishedPosts(3),
    stats: safeJson(c.stats_json, []), why: safeJson(c.why_json, []), process: safeJson(c.process_json, []),
    sent: false, formError: null,
  }, extra || {}));
}
router.get('/', (req, res) => renderHome(req, res, { sent: req.query.sent === '1' }));

// Buyer enquiry — public, honeypot + light validation → site_enquiries.
router.post('/enquiry', (req, res) => {
  const f = req.body || {};
  const backTo = f.redirect === '/contact' ? '/contact?sent=1' : '/?sent=1#contact';
  if (f.website && f.website.trim()) return res.redirect(backTo);  // honeypot
  const name = (f.name || '').trim(), phone = (f.phone || '').trim(), email = (f.email || '').trim();
  if (!name || (!phone && !email)) {
    const c = content();
    const common = { layout:false, c, logo: logoPath(), baseUrl: baseUrlOf(req),
      products: db.prepare('SELECT * FROM site_products WHERE active=1 ORDER BY sort, id').all(),
      stats: safeJson(c.stats_json, []), sent:false,
      formError: 'Please enter your name and a phone or email so we can reach you.' };
    if (f.redirect === '/contact') return res.render('site/contact', common);
    return renderHome(req, res, { formError: common.formError });
  }
  db.prepare(`INSERT INTO site_enquiries (name, company, phone, email, product_interest, message, ip) VALUES (?,?,?,?,?,?,?)`)
    .run(name, (f.company||'').trim()||null, phone||null, email||null, (f.product_interest||'').trim()||null, (f.message||'').trim()||null, req.ip);
  res.redirect(backTo);
});

// ── Inner pages ───────────────────────────────────────────────
router.get('/about', (req, res) => {
  const c = content();
  res.render('site/about', { layout:false, c, logo: logoPath(), baseUrl: baseUrlOf(req), stats: safeJson(c.stats_json, []) });
});
router.get('/contact', (req, res) => {
  const c = content();
  res.render('site/contact', { layout:false, c, logo: logoPath(), baseUrl: baseUrlOf(req),
    products: db.prepare('SELECT * FROM site_products WHERE active=1 ORDER BY sort, id').all(),
    sent: req.query.sent === '1', formError: null });
});

// ── Blog ──────────────────────────────────────────────────────
router.get('/blog', (req, res) => {
  res.render('site/blog', { layout:false, c: content(), logo: logoPath(), baseUrl: baseUrlOf(req), posts: publishedPosts() });
});
router.get('/blog/:slug', (req, res) => {
  const post = db.prepare("SELECT * FROM site_posts WHERE slug=? AND status='published'").get(req.params.slug);
  if (!post) return res.redirect('/blog');
  res.render('site/post', { layout:false, c: content(), logo: logoPath(), baseUrl: baseUrlOf(req), post });
});

// ── SEO files ─────────────────────────────────────────────────
router.get('/robots.txt', (req, res) => {
  const host = req.get('host');
  res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${(req.headers['x-forwarded-proto']||req.protocol)}://${host}/sitemap.xml\n`);
});
router.get('/sitemap.xml', (req, res) => {
  const base = baseUrlOf(req);
  const urls = ['/', '/about', '/contact', '/blog'];
  publishedPosts().forEach(p => urls.push('/blog/' + p.slug));
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map(u => `<url><loc>${base}${u}</loc></url>`).join('\n') + `\n</urlset>\n`;
  res.type('application/xml').send(body);
});

// ── Public survey ─────────────────────────────────────────────
function surveyQuestions(id) {
  return db.prepare('SELECT * FROM survey_questions WHERE survey_id=? ORDER BY position, id').all(id)
    .map(q => Object.assign(q, { options: q.options_json ? JSON.parse(q.options_json) : [] }));
}
// Extract a question's submitted answer; multi-choice arrives as an array.
function answerOf(body, q) {
  const v = body['q_' + q.id];
  if (q.qtype === 'multi') return Array.isArray(v) ? v.join(' | ') : (v || '');
  return (v == null ? '' : String(v)).trim();
}
router.get('/survey/:slug', (req, res) => {
  const survey = db.prepare("SELECT * FROM surveys WHERE slug=? AND active=1").get(req.params.slug);
  if (!survey) return res.redirect('/');
  res.render('site/survey', { layout: false, c: content(), logo: logoPath(), baseUrl: baseUrlOf(req),
    survey, questions: surveyQuestions(survey.id), source: req.query.src === 'sms' ? 'sms' : 'web', done: false, error: null });
});
router.post('/survey/:slug', (req, res) => {
  const survey = db.prepare("SELECT * FROM surveys WHERE slug=? AND active=1").get(req.params.slug);
  if (!survey) return res.redirect('/');
  const questions = surveyQuestions(survey.id);
  const f = req.body || {};
  if (f.website && f.website.trim()) return res.redirect('/survey/' + survey.slug); // honeypot
  const render = (extra) => res.render('site/survey', Object.assign({ layout: false, c: content(), logo: logoPath(), baseUrl: baseUrlOf(req), survey, questions, source: 'web', done: false, error: null }, extra));
  for (const q of questions) {
    if (q.required && !answerOf(f, q)) return render({ error: 'Please answer all required questions.' });
  }
  const source = ['sms', 'link', 'web'].includes(f.source) ? f.source : 'web';
  const rid = db.prepare('INSERT INTO survey_responses (survey_id,name,phone,source) VALUES (?,?,?,?)')
    .run(survey.id, (f.resp_name || '').trim() || null, (f.resp_phone || '').trim() || null, source).lastInsertRowid;
  const insA = db.prepare('INSERT INTO survey_answers (response_id,question_id,value) VALUES (?,?,?)');
  questions.forEach(q => { const v = answerOf(f, q); if (v) insA.run(rid, q.id, v); });
  render({ done: true });
});

// Any other public path → home.
router.use((req, res) => res.redirect('/'));

module.exports = router;
