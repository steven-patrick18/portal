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
  if (Math.max(lvl(req, 'website'), lvl(req, 'website_enquiries'), lvl(req, 'website_insights')) >= LEVEL_ORDER.view) return next();
  return requireFeature('website')(req, res, next); // standard 403 page
});
// CMS pages: "view" to open, "full" to write (post editors / brand are GET-only).
router.use(['/content', '/products', '/certifications', '/posts', '/instagram', '/brand'],
  (req, res, next) => requireFeature('website', req.method === 'GET' ? 'view' : 'full')(req, res, next));
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
  };
  // Someone with only Insights access has no tabs here — send them straight in.
  if (!wperm.cms && !wperm.enquiries && wperm.insights) return res.redirect('/website/insights');
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

  res.render('website/index', { title: 'Website', c, products, certs, enquiries, newCount, instagram, posts, status, wperm });
});

// ── Logo & Brand Kit ──────────────────────────────────────────
// A self-service page that previews the Sharv logo and exports every
// social / favicon / print size on demand (rasterised in the browser).
router.get('/brand', (req, res) => {
  res.render('website/brand', { title: 'Logo & Brand Kit', c: content() });
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
  res.render('website/insights', {
    title: 'Website Insights',
    data, days,
    cfg: {
      ga4_measurement_id: googleApi.setting('GA4_MEASUREMENT_ID'),
      ga4_property_id: googleApi.setting('GA4_PROPERTY_ID'),
      gsc_site_url: googleApi.setting('GSC_SITE_URL'),
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

router.post('/insights/config', requireFeature('website_insights', 'full'), (req, res) => {
  const f = req.body;
  setKV('GA4_MEASUREMENT_ID', (f.ga4_measurement_id || '').trim());
  setKV('GA4_PROPERTY_ID', (f.ga4_property_id || '').replace(/\D/g, ''));
  setKV('GSC_SITE_URL', (f.gsc_site_url || '').trim());
  // Only overwrite the secret when a new one is pasted; "clear" wipes it.
  if (f.clear_sa === '1') setKV('GOOGLE_SA_JSON', '');
  else if (f.sa_json && f.sa_json.trim()) setKV('GOOGLE_SA_JSON', f.sa_json.trim());
  googleApi.clearCache();
  flash(req, 'success', 'Insights settings saved.');
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
  flash(req,'success','Post updated.');
  res.redirect('/website#tab-blog');
});
router.post('/posts/:id/delete', (req, res) => {
  db.prepare('DELETE FROM site_posts WHERE id=?').run(req.params.id);
  flash(req,'success','Post deleted.');
  res.redirect('/website#tab-blog');
});
// New-post editor (blank) and edit-post editor reuse the same view.
router.get('/posts/new', (req, res) => {
  res.render('website/post-edit', { title: 'New Post', post: null });
});
router.get('/posts/:id/edit', (req, res) => {
  const post = db.prepare('SELECT * FROM site_posts WHERE id=?').get(req.params.id);
  if (!post) return res.redirect('/website#tab-blog');
  res.render('website/post-edit', { title: 'Edit Post', post });
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
    instagram=?, linkedin=?, facebook=?, youtube=?,
    meta_title=?, meta_desc=?, google_verification=?, bing_verification=?, published=?, updated_by=?, updated_at=datetime('now')
    WHERE id=1`)
    .run(
      f.company_name||null, f.tagline||null, f.hero_title||null, f.hero_subtitle||null, f.hero_cta_text||null, f.hero_video_url||null,
      f.about_title||null, f.about_html||null, f.stats_json||null, f.why_json||null, f.process_json||null,
      f.phone||null, f.email||null, f.whatsapp||null, (f.wa_greeting||'').trim()||null, f.address||null,
      f.instagram||null, f.linkedin||null, f.facebook||null, f.youtube||null,
      f.meta_title||null, f.meta_desc||null, f.google_verification||null, f.bing_verification||null, f.published ? 1 : 0, req.session.user.id);
  req.audit('update', 'website', 1, 'site content updated');
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
