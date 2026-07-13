// Website module — manage the public marketing site (sharvexport.com)
// content from inside the ERP. Edits site_content + site_products +
// site_certifications; the public /site route renders from them.
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { nextCode } = require('../utils/codegen');
const googleApi = require('../utils/googleApi');
const { getUserLevel, LEVEL_ORDER, requireFeature } = require('../middleware/permissions');
const router = express.Router();

function lvl(req, key) { return LEVEL_ORDER[getUserLevel(req.session.user, key)] || 0; }

// ── Per-section access (the Website module is split three ways) ──
// website            → CMS: content/SEO, products, certifications, blog,
//                      Instagram, brand kit, status
// website_enquiries  → buyer-enquiry inbox + convert-to-dealer
// website_insights   → Analytics visitors + Search Console ranking
// All three are children of `website`, so granting website=full covers all.

// Gate the whole module: need at least "view" on one website-family feature.
router.use((req, res, next) => {
  if (Math.max(lvl(req, 'website'), lvl(req, 'website_enquiries'), lvl(req, 'website_insights'),
               lvl(req, 'website_careers'), lvl(req, 'website_brand')) >= LEVEL_ORDER.view) return next();
  return requireFeature('website')(req, res, next); // standard 403 page
});
// CMS pages: "view" to open, "full" to write (post editors are GET-only).
router.use(['/content', '/products', '/certifications', '/posts', '/instagram'],
  (req, res, next) => requireFeature('website', req.method === 'GET' ? 'view' : 'full')(req, res, next));
// Brand kit + Careers are their own grantable sub-features (e.g. for HR).
router.use('/brand',   (req, res, next) => requireFeature('website_brand',   req.method === 'GET' ? 'view' : 'full')(req, res, next));
router.use('/careers', (req, res, next) => requireFeature('website_careers', req.method === 'GET' ? 'view' : 'full')(req, res, next));
// Buyer enquiries: "limited" to act on a lead.
router.use('/enquiries', requireFeature('website_enquiries', 'limited'));
// Insights: "view" to read (the config save additionally requires full, below).
router.use('/insights', requireFeature('website_insights'));

function setKV(key, value) {
  db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value);
}

const UP_ROOT = path.join(__dirname, '..', '..', 'public', 'uploads', 'website');
function upDir() { if (!fs.existsSync(UP_ROOT)) fs.mkdirSync(UP_ROOT, { recursive: true }); return UP_ROOT; }
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, upDir()),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg';
      cb(null, (file.fieldname || 'img') + '_' + Date.now() + '_' + require('crypto').randomBytes(3).toString('hex') + ext);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//i.test(file.mimetype)),
});
const rel = (p) => '/uploads/website/' + path.relative(UP_ROOT, p).replace(/\\/g, '/');

function content() {
  return db.prepare('SELECT * FROM site_content WHERE id=1').get() || {};
}

router.get('/', (req, res) => {
  const wperm = {
    cms:       lvl(req, 'website') >= LEVEL_ORDER.view,
    cmsWrite:  lvl(req, 'website') >= LEVEL_ORDER.full,
    enquiries: lvl(req, 'website_enquiries') >= LEVEL_ORDER.view,
    enqWrite:  lvl(req, 'website_enquiries') >= LEVEL_ORDER.limited,
    insights:  lvl(req, 'website_insights') >= LEVEL_ORDER.view,
    careers:   lvl(req, 'website_careers') >= LEVEL_ORDER.view,
    brand:     lvl(req, 'website_brand') >= LEVEL_ORDER.view,
  };
  // Users with only a single sub-feature have no tabs on this page — send them straight in.
  if (!wperm.cms && !wperm.enquiries) {
    if (wperm.insights) return res.redirect('/website/insights');
    if (wperm.careers)  return res.redirect('/website/careers');
    if (wperm.brand)    return res.redirect('/website/brand');
  }
  const c = content();
  const products = db.prepare('SELECT * FROM site_products ORDER BY sort, id').all();
  const certs = db.prepare('SELECT * FROM site_certifications ORDER BY sort, id').all();
  // Lead data is PII — only load it for users who can see enquiries.
  const enquiries = wperm.enquiries
    ? db.prepare(`SELECT e.*, d.name AS dealer_name FROM site_enquiries e LEFT JOIN dealers d ON d.id=e.converted_dealer_id ORDER BY e.id DESC LIMIT 300`).all()
    : [];
  const newCount = wperm.enquiries ? db.prepare("SELECT COUNT(*) AS n FROM site_enquiries WHERE status='new'").get().n : 0;
  const instagram = db.prepare('SELECT * FROM site_instagram ORDER BY sort, id').all();
  const posts = db.prepare('SELECT * FROM site_posts ORDER BY COALESCE(published_at, created_at) DESC, id DESC').all();

  // ── Website status / SEO readiness (no external API needed) ──
  const logoRow = db.prepare("SELECT value FROM app_settings WHERE key='COMPANY_LOGO'").get();
  const logo = logoRow ? logoRow.value : '';
  const pubPosts = posts.filter(p => p.status === 'published');
  const liveCerts = certs.filter(ct => ct.active);
  const liveProducts = products.filter(p => p.active);
  // The exact URL set the public sitemap publishes (keep in sync with site.js).
  const sitemapUrls = ['/', '/about', '/contact', '/blog'].concat(pubPosts.map(p => '/blog/' + p.slug));
  const checklist = [
    { label: 'Site is published (visible to public)', ok: !!c.published, hint: 'Toggle "Site published" below in Content & SEO.' },
    { label: 'Meta title set (Google tab title)', ok: !!c.meta_title, hint: 'Content & SEO → SEO / META.' },
    { label: 'Meta description set (Google snippet)', ok: !!c.meta_desc, hint: 'Content & SEO → SEO / META.' },
    { label: 'Google Search Console verified', ok: !!c.google_verification, hint: 'Paste the verification code in Content & SEO.' },
    { label: 'Bing verification set', ok: !!c.bing_verification, hint: 'Optional — catches Microsoft / Copilot search.' },
    { label: 'Company logo uploaded', ok: !!logo, hint: 'Settings → Company → Logo. Used on the site + social shares.' },
    { label: 'WhatsApp number set (for enquiries)', ok: !!c.whatsapp, hint: 'Content & SEO → Contact.' },
    { label: 'At least 1 product listed', ok: liveProducts.length > 0, hint: 'Products tab.' },
    { label: 'Factory / product video added', ok: !!c.hero_video_url, hint: 'Content & SEO → Hero → Factory Video.' },
    { label: 'At least 1 blog post published', ok: pubPosts.length > 0, hint: 'Blog tab → New Post → Published. Great for SEO.' },
    { label: 'Instagram feed (3+ posts)', ok: instagram.length >= 3, hint: 'Instagram tab.' },
  ];
  const status = {
    logo, sitemapUrls,
    publishedPosts: pubPosts.length, draftPosts: posts.length - pubPosts.length,
    liveProducts: liveProducts.length, liveCerts: liveCerts.length, instagram: instagram.length,
    enquiriesTotal: enquiries.length, enquiriesNew: newCount,
    checklist, score: checklist.filter(x => x.ok).length, total: checklist.length,
  };

  // Evergreen topic ideas for the Blog tab (no Google data needed).
  const blogIdeas = require('../utils/insights').blogIdeas(6);

  res.render('website/index', { title: 'Website', c, products, certs, enquiries, newCount, instagram, posts, status, wperm, blogIdeas });
});

// ── Logo & Brand Kit ──────────────────────────────────────────
// A self-service page that previews the Sharv logo and exports every
// social / favicon / print size on demand (rasterised in the browser).
router.get('/brand', (req, res) => {
  res.render('website/brand', { title: 'Logo & Brand Kit', c: content() });
});

// Print-ready brand stationery (letterhead, business card, envelope, email
// signature, with-compliments). Standalone page — Print → Save as PDF.
router.get('/brand/doc/:type', (req, res) => {
  const allowed = ['letterhead', 'business-card', 'envelope', 'email-signature', 'with-compliments'];
  const type = allowed.includes(req.params.type) ? req.params.type : 'letterhead';
  let web = '';
  try { web = (require('../utils/seoAudit').siteOrigin() || '').replace(/^https?:\/\//, '').replace(/\/$/, ''); } catch (_) {}
  res.render('website/brand-doc', { layout: false, type, c: content(), web });
});

// ── Employee ID Card maker (Brand Kit) ─────────────────────────
// Pick an employee, upload + position the photo, fill blood group /
// emergency contact, then export print-quality front & back cards.
// The /brand gate above applies: GET needs website_brand view,
// the POSTs need website_brand full (grant it to Accounts/Admin).
// Stricter than the rest of the brand kit: the card shows employee PII
// (photo, phone, emergency contact), so even viewing needs FULL access.
router.use('/brand/idcard', requireFeature('website_brand', 'full'));
const EMP_UP = path.join(__dirname, '..', '..', 'public', 'uploads', 'employees');
const empPhotoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { if (!fs.existsSync(EMP_UP)) fs.mkdirSync(EMP_UP, { recursive: true }); cb(null, EMP_UP); },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg';
      cb(null, 'idp_' + req.params.empId + '_' + Date.now() + ext);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//i.test(file.mimetype)),
});
router.get('/brand/idcard', (req, res) => {
  const employees = db.prepare("SELECT id, code, name, designation FROM employees WHERE active=1 ORDER BY code").all();
  const emp = req.query.emp ? db.prepare('SELECT * FROM employees WHERE id=? AND active=1').get(req.query.emp) : null;
  let card = {};
  if (emp) { try { card = JSON.parse(emp.id_card_json || '{}') || {}; } catch (_) {} }
  let brand;
  try { brand = require('./settings').getBranding(); }
  catch (_) { brand = { name: 'Sharv Enterprises', logo: '', address: '', phone: '', email: '' }; }
  let web = '';
  try { web = (require('../utils/seoAudit').siteOrigin() || '').replace(/^https?:\/\//, '').replace(/\/$/, ''); } catch (_) {}
  res.render('website/idcard', { title: 'Employee ID Card', employees, emp, card, brand, web });
});
router.post('/brand/idcard/:empId/photo', empPhotoUpload.single('photo'), (req, res) => {
  const e = db.prepare('SELECT id FROM employees WHERE id=?').get(req.params.empId);
  if (e && req.file) {
    db.prepare("UPDATE employees SET photo_path=?, updated_at=datetime('now') WHERE id=?")
      .run('/uploads/employees/' + path.basename(req.file.path), e.id);
    flash(req, 'success', 'Photo uploaded — drag to position, zoom, then Save.');
  } else flash(req, 'danger', 'No photo received.');
  res.redirect('/website/brand/idcard?emp=' + req.params.empId);
});
router.post('/brand/idcard/:empId/save', (req, res) => {
  const e = db.prepare('SELECT id FROM employees WHERE id=?').get(req.params.empId);
  if (e) {
    const f = req.body;
    const card = {
      zoom: Math.min(4, Math.max(0.5, parseFloat(f.zoom) || 1)),
      x: Math.max(-200, Math.min(200, parseFloat(f.x) || 0)),
      y: Math.max(-200, Math.min(200, parseFloat(f.y) || 0)),
      blood_group: (f.blood_group || '').trim().toUpperCase().slice(0, 4),
      emergency_name: (f.emergency_name || '').trim().slice(0, 40),
      emergency_phone: (f.emergency_phone || '').trim().slice(0, 15),
      valid_till: (f.valid_till || '').slice(0, 10),
    };
    db.prepare("UPDATE employees SET id_card_json=?, updated_at=datetime('now') WHERE id=?").run(JSON.stringify(card), e.id);
    flash(req, 'success', 'ID card saved.');
  }
  res.redirect('/website/brand/idcard?emp=' + req.params.empId);
});

// ── Insights (Google Analytics + Search Console) ──────────────
router.get('/insights', async (req, res) => {
  const days = [7, 28, 90].includes(parseInt(req.query.days)) ? parseInt(req.query.days) : 28;
  let data;
  try {
    data = await googleApi.getInsights({ days, force: req.query.refresh === '1' });
  } catch (e) {
    data = { configured: googleApi.isConfigured(), hasGSC: false, hasGA4: false, days, gsc: null, ga4: null, errors: [e.message] };
  }
  // Live SEO health audit (fetches the public site) + keyword opportunities.
  const seoAudit = require('../utils/seoAudit');
  const insightsUtil = require('../utils/insights');
  const force = req.query.refresh === '1';
  let audit = null, siteAudit = null;
  try { audit = await seoAudit.runAudit({ force }); }
  catch (e) { audit = { error: e.message, checks: [], actions: [], growth: [], score: null }; }
  try { siteAudit = await seoAudit.runSiteAudit({ force }); } catch (e) { siteAudit = { pages: [], error: e.message }; }
  const opportunities = seoAudit.keywordOpportunities(data.gsc);
  const suggestions = insightsUtil.blogSuggestions(data.gsc);
  const goals = insightsUtil.goalProgress(data);
  const alerts = insightsUtil.alerts(data, audit);
  const events = insightsUtil.recentEvents(12);
  const rankHistory = require('../utils/rankTracker').history();
  let pagespeed = null;
  try { pagespeed = await require('../utils/pagespeed').get({ run: req.query.pagespeed === '1' }); }
  catch (e) { pagespeed = { error: e.message }; }
  // Deep link to Google's full backlink (Links) report — only in the GSC UI.
  const gscSite = googleApi.setting('GSC_SITE_URL');
  const gscLinksUrl = gscSite ? 'https://search.google.com/search-console/links?resource_id=' + encodeURIComponent(gscSite) : null;
  res.render('website/insights', {
    title: 'Website Insights',
    data, days, audit, opportunities, siteAudit, suggestions, goals, alerts, events, rankHistory, pagespeed, gscLinksUrl,
    cfg: {
      ga4_measurement_id: googleApi.setting('GA4_MEASUREMENT_ID'),
      ga4_property_id: googleApi.setting('GA4_PROPERTY_ID'),
      meta_pixel_id: googleApi.setting('META_PIXEL_ID'),
      meta_ad_account_id: googleApi.setting('META_AD_ACCOUNT_ID'),
      meta_ads_token_set: !!googleApi.setting('META_ADS_TOKEN'),
      gsc_site_url: googleApi.setting('GSC_SITE_URL'),
      pagespeed_api_key: googleApi.setting('PAGESPEED_API_KEY'),
      sa_configured: !!googleApi.setting('GOOGLE_SA_JSON'),
      sa_email: (() => { try { return JSON.parse(googleApi.setting('GOOGLE_SA_JSON') || '{}').client_email || ''; } catch (_) { return ''; } })(),
    },
  });
});

// Live active-users count (polled by the dashboard every ~30s).
router.get('/insights/realtime', async (req, res) => {
  try { res.json({ users: await googleApi.realtimeUsers() }); }
  catch (e) { res.json({ users: null, error: e.message }); }
});

// Meta (Facebook/Instagram) ad performance — read-only, loaded lazily by the
// Insights page so the main render stays fast.
router.get('/insights/meta-ads', async (req, res) => {
  const days = [7, 28, 90].includes(parseInt(req.query.days)) ? parseInt(req.query.days) : 28;
  try { res.json(await require('../utils/metaAds').getInsights({ days, force: req.query.refresh === '1' })); }
  catch (e) { res.json({ configured: true, error: e.message }); }
});

router.post('/insights/config', requireFeature('website_insights', 'full'), (req, res) => {
  const f = req.body;
  setKV('GA4_MEASUREMENT_ID', (f.ga4_measurement_id || '').trim());
  setKV('GA4_PROPERTY_ID', (f.ga4_property_id || '').replace(/\D/g, ''));
  // Meta (Facebook/Instagram) Pixel — numeric dataset id; injected on the public site.
  setKV('META_PIXEL_ID', (f.meta_pixel_id || '').replace(/\D/g, ''));
  // Meta Ads — read-only performance. Account id is numeric; token is a secret
  // (only overwrite when a new one is pasted; the "disconnect" box wipes it).
  setKV('META_AD_ACCOUNT_ID', (f.meta_ad_account_id || '').replace(/\D/g, ''));
  if (f.clear_meta_token === '1') setKV('META_ADS_TOKEN', '');
  else if (f.meta_ads_token && f.meta_ads_token.trim()) setKV('META_ADS_TOKEN', f.meta_ads_token.trim());
  setKV('GSC_SITE_URL', (f.gsc_site_url || '').trim());
  // Keep the saved PageSpeed key unless a new one is pasted (field loads blank).
  if (f.pagespeed_api_key && f.pagespeed_api_key.trim()) setKV('PAGESPEED_API_KEY', f.pagespeed_api_key.trim());
  // Only overwrite the secret when a new one is pasted; "clear" wipes it.
  if (f.clear_sa === '1') setKV('GOOGLE_SA_JSON', '');
  else if (f.sa_json && f.sa_json.trim()) setKV('GOOGLE_SA_JSON', f.sa_json.trim());
  googleApi.clearCache();
  flash(req, 'success', 'Insights settings saved.');
  res.redirect('/website/insights');
});

// Live SEO health audit as JSON — lazily fetched by the "SEO Health" tab on
// the Website page so the main page stays fast. Cached by the util (1h TTL);
// ?refresh=1 forces a fresh crawl of the public site.
router.get('/seo.json', async (req, res) => {
  const seoAudit = require('../utils/seoAudit');
  const force = req.query.refresh === '1';
  let audit = null, siteAudit = null;
  try { audit = await seoAudit.runAudit({ force }); }
  catch (e) { audit = { error: e.message, checks: [], actions: [], score: null, reachable: false }; }
  try { siteAudit = await seoAudit.runSiteAudit({ force }); }
  catch (e) { siteAudit = { pages: [], error: e.message }; }
  res.json({ audit, siteAudit });
});

// Keyword Ideas — real Google autocomplete suggestions (India), lazily fetched
// by the Insights page. Free, no key. ?expand=0 for a quick single query.
router.get('/insights/keywords', async (req, res) => {
  const q = (req.query.q || '').toString().slice(0, 80);
  if (!q.trim()) return res.json({ q, ideas: [] });
  try {
    const list = await require('../utils/keywordTool').ideas(q, { expand: req.query.expand !== '0' });
    res.json({ q, ideas: list });
  } catch (e) { res.json({ q, ideas: [], error: e.message }); }
});

// Monthly goal targets (#2).
router.post('/insights/goals', (req, res) => {
  setKV('GOAL_VISITORS_MONTH', String(parseInt(req.body.goal_visitors) || 0));
  setKV('GOAL_ENQUIRIES_MONTH', String(parseInt(req.body.goal_enquiries) || 0));
  flash(req, 'success', 'Monthly goals saved.');
  res.redirect('/website/insights');
});

// ── Blog ──────────────────────────────────────────────────────
function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 80) || ('post-' + Date.now());
}
function uniqueSlug(base, excludeId) {
  let slug = base, n = 1;
  while (true) {
    const row = db.prepare('SELECT id FROM site_posts WHERE slug=?').get(slug);
    if (!row || row.id === excludeId) return slug;
    slug = base + '-' + (++n);
  }
}
router.post('/posts', upload.single('cover'), (req, res) => {
  const f = req.body;
  if (!f.title || !f.title.trim()) { flash(req,'danger','Post title required.'); return res.redirect('/website#tab-blog'); }
  const slug = uniqueSlug(f.slug ? slugify(f.slug) : slugify(f.title));
  const status = f.status === 'published' ? 'published' : 'draft';
  const publishedAt = status === 'published' ? (f.published_at || require('../utils/format').todayLocal()) : null;
  db.prepare(`INSERT INTO site_posts (slug, title, excerpt, body_html, cover_image, meta_title, meta_desc, status, published_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(slug, f.title.trim(), f.excerpt||null, f.body_html||null, req.file ? rel(req.file.path) : null,
         f.meta_title||null, f.meta_desc||null, status, publishedAt, req.session.user.id);
  req.audit('create', 'site_post', null, `${status}: ${f.title.trim()}`);
  if (status === 'published') require('../utils/insights').logEvent('blog', 'Published: ' + f.title.trim());
  flash(req,'success', status === 'published' ? 'Post published.' : 'Draft saved.');
  res.redirect('/website#tab-blog');
});
router.post('/posts/:id', upload.single('cover'), (req, res) => {
  const post = db.prepare('SELECT * FROM site_posts WHERE id=?').get(req.params.id);
  if (!post) return res.redirect('/website#tab-blog');
  const f = req.body;
  const status = f.status === 'published' ? 'published' : 'draft';
  // Stamp published_at the first time it goes live.
  const publishedAt = status === 'published' ? (post.published_at || f.published_at || require('../utils/format').todayLocal()) : post.published_at;
  const slug = f.slug ? uniqueSlug(slugify(f.slug), post.id) : post.slug;
  const cover = req.file ? rel(req.file.path) : post.cover_image;
  db.prepare(`UPDATE site_posts SET slug=?, title=?, excerpt=?, body_html=?, cover_image=?, meta_title=?, meta_desc=?, status=?, published_at=?, updated_by=?, updated_at=datetime('now') WHERE id=?`)
    .run(slug, f.title||post.title, f.excerpt||null, f.body_html||null, cover, f.meta_title||null, f.meta_desc||null, status, publishedAt, req.session.user.id, post.id);
  if (status === 'published' && post.status !== 'published') require('../utils/insights').logEvent('blog', 'Published: ' + (f.title || post.title));
  flash(req,'success','Post updated.');
  res.redirect('/website#tab-blog');
});
router.post('/posts/:id/delete', (req, res) => {
  db.prepare('DELETE FROM site_posts WHERE id=?').run(req.params.id);
  flash(req,'success','Post deleted.');
  res.redirect('/website#tab-blog');
});
// New-post editor (blank) and edit-post editor reuse the same view.
// A topic idea can pre-fill the title + meta via ?title=&meta= (from the Blog tab).
router.get('/posts/new', (req, res) => {
  const prefill = {
    title: (req.query.title || '').toString().slice(0, 140),
    meta: (req.query.meta || '').toString().slice(0, 170),
  };
  res.render('website/post-edit', { title: 'New Post', post: null, prefill });
});
router.get('/posts/:id/edit', (req, res) => {
  const post = db.prepare('SELECT * FROM site_posts WHERE id=?').get(req.params.id);
  if (!post) return res.redirect('/website#tab-blog');
  res.render('website/post-edit', { title: 'Edit Post', post, prefill: null });
});

// ── Enquiries inbox ───────────────────────────────────────────
const ENQ_STATUS = new Set(['new','contacted','converted','spam','archived']);
router.post('/enquiries/:id/status', (req, res) => {
  const e = db.prepare('SELECT * FROM site_enquiries WHERE id=?').get(req.params.id);
  if (!e) return res.redirect('/website');
  const st = ENQ_STATUS.has(req.body.status) ? req.body.status : e.status;
  db.prepare('UPDATE site_enquiries SET status=?, notes=?, handled_by=? WHERE id=?')
    .run(st, req.body.notes || e.notes || null, req.session.user.id, e.id);
  flash(req,'success','Enquiry updated.');
  res.redirect('/website#tab-enquiries');
});
router.post('/enquiries/:id/convert', (req, res) => {
  const e = db.prepare('SELECT * FROM site_enquiries WHERE id=?').get(req.params.id);
  if (!e) return res.redirect('/website');
  if (e.converted_dealer_id) { flash(req,'warning','Already converted.'); return res.redirect('/dealers/' + e.converted_dealer_id); }
  // Don't create a duplicate dealer if this enquiry's phone already exists.
  const dupErr = require('../utils/dealerDedup').duplicateDealerError(e.phone, null, null);
  if (dupErr) { flash(req, 'danger', dupErr + ' Link the enquiry to the existing dealer instead.'); return res.redirect('/website#tab-enquiries'); }
  const code = nextCode('dealers', 'code', 'DLR');
  // dealers has no notes column — the original enquiry (message,
  // product interest) stays on the site_enquiries row, linked via
  // converted_dealer_id, so the context is never lost.
  const r = db.prepare(`INSERT INTO dealers (code, name, contact_person, phone, email) VALUES (?,?,?,?,?)`)
    .run(code, e.company || e.name, e.name, e.phone || null, e.email || null);
  db.prepare("UPDATE site_enquiries SET status='converted', converted_dealer_id=?, handled_by=? WHERE id=?")
    .run(r.lastInsertRowid, req.session.user.id, e.id);
  req.audit('convert', 'site_enquiry', e.id, `enquiry "${e.name}" → dealer ${code}`);
  flash(req,'success', `Created dealer ${code} from the enquiry.`);
  res.redirect('/dealers/' + r.lastInsertRowid);
});
router.post('/enquiries/:id/delete', (req, res) => {
  db.prepare('DELETE FROM site_enquiries WHERE id=?').run(req.params.id);
  flash(req,'success','Enquiry deleted.');
  res.redirect('/website#tab-enquiries');
});

// ── Careers — manage openings + applications inbox ────────────
const APP_STATUS = new Set(['new', 'reviewed', 'shortlisted', 'rejected', 'hired', 'archived']);
router.get('/careers', (req, res) => {
  const jobs = db.prepare('SELECT j.*, (SELECT COUNT(*) FROM site_job_applications a WHERE a.job_id=j.id) AS app_count FROM site_jobs j ORDER BY j.active DESC, j.sort, j.id').all();
  const apps = db.prepare(`SELECT a.*, j.title AS job_title FROM site_job_applications a LEFT JOIN site_jobs j ON j.id=a.job_id ORDER BY a.id DESC LIMIT 500`).all();
  const newCount = db.prepare("SELECT COUNT(*) AS n FROM site_job_applications WHERE status='new'").get().n;
  const emailTemplates = db.prepare("SELECT tkey, label, subject, body FROM email_templates WHERE active=1 AND category IN ('candidate','general') ORDER BY category, sort, id").all();
  const company = content().company_name || 'Sharv Enterprises';
  const emailReady = require('../utils/mailer').isConfigured();
  res.render('website/careers', { title: 'Careers', jobs, apps, newCount, emailTemplates, company, emailReady, senderName: req.session.user.name || '' });
});
// Send an email to an applicant (uses the SMTP mailbox + a chosen template).
router.post('/careers/application/:id/email', async (req, res) => {
  const a = db.prepare('SELECT * FROM site_job_applications WHERE id=?').get(req.params.id);
  if (!a) return res.redirect('/website/careers');
  if (!a.email) { flash(req, 'danger', 'This applicant has no email on file.'); return res.redirect('/website/careers#apps'); }
  const mailer = require('../utils/mailer');
  const r = await mailer.send({
    to: a.email, toName: a.name,
    subject: (req.body.subject || '').trim(),
    body: req.body.body || '',
    templateKey: req.body.template_key || null,
    context_type: 'application', context_id: a.id, sentBy: req.session.user.id,
  });
  flash(req, r.ok ? 'success' : 'danger', r.ok ? ('Email sent to ' + a.name + '.') : ('Failed: ' + r.error));
  res.redirect('/website/careers#apps');
});
// Promote a reviewed application into the HR Applicant Portal (recruitment pipeline).
router.post('/careers/application/:id/promote', (req, res) => {
  const a = db.prepare('SELECT id, status FROM site_job_applications WHERE id=?').get(req.params.id);
  if (a) {
    db.prepare("UPDATE site_job_applications SET in_pipeline=1, status=CASE WHEN status='new' THEN 'reviewed' ELSE status END WHERE id=?").run(a.id);
    flash(req, 'success', 'Added to HR → Applicant Portal. Manage the candidate there.');
  }
  res.redirect('/website/careers#apps');
});
router.post('/careers/job', (req, res) => {
  const f = req.body;
  if (!f.title || !f.title.trim()) { flash(req,'danger','Job title is required.'); return res.redirect('/website/careers'); }
  if (f.id) {
    db.prepare('UPDATE site_jobs SET title=?, dept=?, location=?, type=?, summary=?, requirements=?, sort=? WHERE id=?')
      .run(f.title.trim(), f.dept||null, f.location||null, f.type||null, f.summary||null, f.requirements||null, parseInt(f.sort)||0, f.id);
    flash(req,'success','Opening updated.');
  } else {
    const maxSort = db.prepare('SELECT COALESCE(MAX(sort),0)+1 AS s FROM site_jobs').get().s;
    db.prepare('INSERT INTO site_jobs (title, dept, location, type, summary, requirements, sort) VALUES (?,?,?,?,?,?,?)')
      .run(f.title.trim(), f.dept||null, f.location||null, f.type||null, f.summary||null, f.requirements||null, maxSort);
    flash(req,'success','Opening added — it is now live on /careers.');
  }
  res.redirect('/website/careers');
});
router.post('/careers/job/:id/toggle', (req, res) => {
  db.prepare('UPDATE site_jobs SET active = CASE active WHEN 1 THEN 0 ELSE 1 END WHERE id=?').run(req.params.id);
  flash(req,'success','Opening visibility updated.');
  res.redirect('/website/careers');
});
router.post('/careers/job/:id/delete', (req, res) => {
  db.prepare('DELETE FROM site_jobs WHERE id=?').run(req.params.id);
  flash(req,'success','Opening removed.');
  res.redirect('/website/careers');
});
router.post('/careers/application/:id/status', (req, res) => {
  const a = db.prepare('SELECT * FROM site_job_applications WHERE id=?').get(req.params.id);
  if (!a) return res.redirect('/website/careers');
  const st = APP_STATUS.has(req.body.status) ? req.body.status : a.status;
  db.prepare('UPDATE site_job_applications SET status=?, notes=?, handled_by=? WHERE id=?')
    .run(st, req.body.notes || a.notes || null, req.session.user.id, a.id);
  flash(req,'success','Application updated.');
  res.redirect('/website/careers#apps');
});
router.post('/careers/application/:id/delete', (req, res) => {
  db.prepare('DELETE FROM site_job_applications WHERE id=?').run(req.params.id);
  flash(req,'success','Application deleted.');
  res.redirect('/website/careers#apps');
});

// ── Instagram feed (curated) ──────────────────────────────────
router.post('/instagram', upload.single('image'), (req, res) => {
  if (!req.file) { flash(req,'danger','Pick an image.'); return res.redirect('/website#tab-instagram'); }
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort),0)+1 AS s FROM site_instagram').get().s;
  db.prepare('INSERT INTO site_instagram (image_path, caption, link, sort) VALUES (?,?,?,?)')
    .run(rel(req.file.path), req.body.caption||null, req.body.link||null, maxSort);
  flash(req,'success','Instagram post added.');
  res.redirect('/website#tab-instagram');
});
router.post('/instagram/:id', upload.single('image'), (req, res) => {
  const ig = db.prepare('SELECT * FROM site_instagram WHERE id=?').get(req.params.id);
  if (!ig) return res.redirect('/website#tab-instagram');
  const img = req.file ? rel(req.file.path) : ig.image_path;
  db.prepare('UPDATE site_instagram SET image_path=?, caption=?, link=?, active=? WHERE id=?')
    .run(img, req.body.caption||null, req.body.link||null, req.body.active ? 1 : 0, ig.id);
  flash(req,'success','Updated.');
  res.redirect('/website#tab-instagram');
});
router.post('/instagram/:id/delete', (req, res) => {
  db.prepare('DELETE FROM site_instagram WHERE id=?').run(req.params.id);
  flash(req,'success','Removed.');
  res.redirect('/website#tab-instagram');
});

// Extract the bare verification token even if the owner pastes the whole
// <meta ... content="X"> tag — Google rejects a double-wrapped tag.
function verifyToken(v) {
  if (!v) return null;
  const m = String(v).match(/content\s*=\s*["']([^"']+)["']/i);
  return (m ? m[1] : String(v)).trim() || null;
}

// Save the main content / branding / contact / socials / SEO.
router.post('/content', (req, res) => {
  const f = req.body;
  f.google_verification = verifyToken(f.google_verification);
  f.bing_verification = verifyToken(f.bing_verification);
  db.prepare(`UPDATE site_content SET
    company_name=?, tagline=?, hero_title=?, hero_subtitle=?, hero_cta_text=?, hero_video_url=?,
    about_title=?, about_html=?, stats_json=?, why_json=?, process_json=?,
    phone=?, email=?, whatsapp=?, wa_greeting=?, address=?,
    instagram=?, linkedin=?, facebook=?, youtube=?, fb_page_url=?, ig_embed_code=?,
    meta_title=?, meta_desc=?, google_verification=?, bing_verification=?, published=?, updated_by=?, updated_at=datetime('now')
    WHERE id=1`)
    .run(
      f.company_name||null, f.tagline||null, f.hero_title||null, f.hero_subtitle||null, f.hero_cta_text||null, f.hero_video_url||null,
      f.about_title||null, f.about_html||null, f.stats_json||null, f.why_json||null, f.process_json||null,
      f.phone||null, f.email||null, f.whatsapp||null, (f.wa_greeting||'').trim()||null, f.address||null,
      f.instagram||null, f.linkedin||null, f.facebook||null, f.youtube||null, (f.fb_page_url||'').trim()||null, (f.ig_embed_code||'').trim()||null,
      f.meta_title||null, f.meta_desc||null, f.google_verification||null, f.bing_verification||null, f.published ? 1 : 0, req.session.user.id);
  req.audit('update', 'website', 1, 'site content updated');
  require('../utils/insights').logEvent('seo', 'Updated site content & SEO');
  flash(req, 'success', 'Website content saved. Open "View Public Site" to see it.');
  res.redirect('/website');
});

// ── Products ──────────────────────────────────────────────────
router.post('/products', upload.single('image'), (req, res) => {
  const f = req.body;
  if (!f.name || !f.name.trim()) { flash(req,'danger','Product name required.'); return res.redirect('/website'); }
  const img = req.file ? rel(req.file.path) : null;
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort),0)+1 AS s FROM site_products').get().s;
  db.prepare('INSERT INTO site_products (name, tagline, image_path, sort) VALUES (?,?,?,?)')
    .run(f.name.trim(), f.tagline||null, img, maxSort);
  flash(req,'success','Product added.');
  res.redirect('/website');
});
router.post('/products/:id', upload.single('image'), (req, res) => {
  const p = db.prepare('SELECT * FROM site_products WHERE id=?').get(req.params.id);
  if (!p) return res.redirect('/website');
  const f = req.body;
  const img = req.file ? rel(req.file.path) : p.image_path;
  db.prepare('UPDATE site_products SET name=?, tagline=?, image_path=?, active=? WHERE id=?')
    .run(f.name||p.name, f.tagline||null, img, f.active ? 1 : 0, p.id);
  flash(req,'success','Product updated.');
  res.redirect('/website');
});
router.post('/products/:id/delete', (req, res) => {
  db.prepare('DELETE FROM site_products WHERE id=?').run(req.params.id);
  flash(req,'success','Product removed.');
  res.redirect('/website');
});

// ── Certifications ────────────────────────────────────────────
router.post('/certifications', upload.single('image'), (req, res) => {
  const f = req.body;
  if (!f.name || !f.name.trim()) { flash(req,'danger','Certification name required.'); return res.redirect('/website'); }
  const img = req.file ? rel(req.file.path) : null;
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort),0)+1 AS s FROM site_certifications').get().s;
  db.prepare('INSERT INTO site_certifications (name, image_path, sort) VALUES (?,?,?)')
    .run(f.name.trim(), img, maxSort);
  flash(req,'success','Certification added.');
  res.redirect('/website');
});
router.post('/certifications/:id', upload.single('image'), (req, res) => {
  const ct = db.prepare('SELECT * FROM site_certifications WHERE id=?').get(req.params.id);
  if (!ct) return res.redirect('/website');
  const f = req.body;
  const img = req.file ? rel(req.file.path) : ct.image_path;
  db.prepare('UPDATE site_certifications SET name=?, image_path=?, active=? WHERE id=?')
    .run(f.name||ct.name, img, f.active ? 1 : 0, ct.id);
  flash(req,'success','Certification updated.');
  res.redirect('/website');
});
router.post('/certifications/:id/delete', (req, res) => {
  db.prepare('DELETE FROM site_certifications WHERE id=?').run(req.params.id);
  flash(req,'success','Certification removed.');
  res.redirect('/website');
});

module.exports = router;
