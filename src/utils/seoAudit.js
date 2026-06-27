// Live SEO audit for the public website. Fetches the homepage, sitemap.xml
// and robots.txt and runs the on-page + technical checks an SEO pro would,
// returning a 0-100 health score, a categorised checklist (pass/warn/fail
// each with a plain-English fix), a prioritised "boost" action plan, and
// keyword opportunities derived from real Search Console data.
const { db } = require('../db');

function setting(key) {
  const r = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  return r ? r.value : '';
}

// Where the public site lives. Prefer the Search Console URL; fall back to a
// SITE_URL setting, else the known domain.
function siteOrigin() {
  let u = setting('GSC_SITE_URL') || setting('SITE_URL') || 'https://sharvexports.com/';
  u = String(u).replace(/^sc-domain:/, 'https://');
  try { return new URL(u).origin; } catch (_) { return 'https://sharvexports.com'; }
}

async function fetchText(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'SharvSEOAudit/1.0' } });
    const body = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, body, url: res.url || url };
  } catch (e) {
    return { ok: false, status: 0, body: '', error: e.message };
  } finally { clearTimeout(t); }
}

function metaContent(html, attr, val) {
  const re = new RegExp('<meta[^>]+' + attr + '=["\']' + val + '["\'][^>]*>', 'i');
  const tag = (html.match(re) || [])[0];
  if (!tag) return '';
  const m = tag.match(/content=["']([^"']*)["']/i);
  return m ? m[1].trim() : '';
}

// status: 'pass' | 'warn' | 'fail'. weight: importance for the score.
function check(key, label, status, detail, fix, weight) {
  return { key, label, status, detail, fix: fix || '', weight: weight || 1, cat: 'on' };
}

// Score a set of checks → { score, counts }.
function scoreChecks(checks) {
  const sv = { pass: 1, warn: 0.5, fail: 0 };
  const totW = checks.reduce((a, c) => a + c.weight, 0) || 1;
  const got = checks.reduce((a, c) => a + c.weight * sv[c.status], 0);
  return {
    score: Math.round((got / totW) * 100),
    counts: {
      pass: checks.filter(c => c.status === 'pass').length,
      warn: checks.filter(c => c.status === 'warn').length,
      fail: checks.filter(c => c.status === 'fail').length,
    },
  };
}

// The on-page checks that apply to ANY single page's HTML.
function onPageChecks(html, origin) {
  const checks = [];
  // ── Title ──
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] ? (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)[1]).trim() : '';
    if (!title) checks.push(check('title', 'Page title', 'fail', 'No <title> tag found.', 'Add a clear title like "Sharv Enterprises — Bulk Garment Manufacturer & Exporter, India".', 3));
    else if (title.length < 30 || title.length > 65) checks.push(check('title', 'Page title', 'warn', `Title is ${title.length} chars: "${title}"`, 'Aim for 50–60 characters with your main keyword + brand.', 3));
    else checks.push(check('title', 'Page title', 'pass', `"${title}"`, '', 3));

    // ── Meta description ──
    const desc = metaContent(html, 'name', 'description');
    if (!desc) checks.push(check('desc', 'Meta description', 'fail', 'No meta description.', 'Add a 150-char summary with keywords — it’s the grey text shown under your link in Google.', 3));
    else if (desc.length < 70 || desc.length > 165) checks.push(check('desc', 'Meta description', 'warn', `${desc.length} chars.`, 'Aim for 140–160 characters.', 2));
    else checks.push(check('desc', 'Meta description', 'pass', `${desc.length} chars.`, '', 2));

    // ── H1 ──
    const h1s = (html.match(/<h1[\s>]/gi) || []).length;
    if (h1s === 0) checks.push(check('h1', 'Main heading (H1)', 'fail', 'No H1 on the page.', 'Add exactly one H1 with your primary keyword.', 2));
    else if (h1s > 1) checks.push(check('h1', 'Main heading (H1)', 'warn', `${h1s} H1 tags found.`, 'Use a single H1 per page.', 2));
    else checks.push(check('h1', 'Main heading (H1)', 'pass', 'One H1.', '', 2));

    // ── Indexable ──
    const noindex = /<meta[^>]+name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(html);
    checks.push(noindex
      ? check('index', 'Indexable by Google', 'fail', 'Page has a noindex tag — Google will not show it!', 'Remove the noindex robots meta tag immediately.', 3)
      : check('index', 'Indexable by Google', 'pass', 'No noindex blocking.', '', 3));

    // ── Mobile viewport ──
    checks.push(/<meta[^>]+name=["']viewport["']/i.test(html)
      ? check('viewport', 'Mobile-friendly viewport', 'pass', 'Viewport tag present.', '', 2)
      : check('viewport', 'Mobile-friendly viewport', 'fail', 'No viewport meta tag.', 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.', 2));

    // ── Canonical ──
    checks.push(/<link[^>]+rel=["']canonical["']/i.test(html)
      ? check('canonical', 'Canonical URL', 'pass', 'Canonical link present.', '', 1)
      : check('canonical', 'Canonical URL', 'warn', 'No canonical tag.', 'Add a canonical link to avoid duplicate-content confusion.', 1));

    // ── Open Graph (social sharing) ──
    const ogOk = !!metaContent(html, 'property', 'og:title') && !!metaContent(html, 'property', 'og:image');
    checks.push(ogOk
      ? check('og', 'Social share preview (Open Graph)', 'pass', 'og:title + og:image set.', '', 1)
      : check('og', 'Social share preview (Open Graph)', 'warn', 'Missing og:title / og:image.', 'Add Open Graph tags so WhatsApp/Facebook show a nice preview with your logo.', 1));

    // ── Structured data (LocalBusiness/Organization) ──
    const ld = (html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || []).join(' ');
    const hasOrg = /"@type"\s*:\s*"(Organization|LocalBusiness|Corporation|Manufacturer)"/i.test(ld);
    checks.push(hasOrg
      ? check('schema', 'Structured data (business info)', 'pass', 'Organization/LocalBusiness schema found.', '', 2)
      : check('schema', 'Structured data (business info)', 'warn', 'No Organization schema.', 'Add JSON-LD Organization markup (name, logo, address, phone) so Google shows your business details.', 2));

    // ── Image alt coverage ──
    // Only judge *content* images. Tracking/analytics pixels (the 1×1 Meta &
    // GA beacons) and intentionally-decorative images (alt="") must not count
    // against coverage — otherwise the invisible Pixel drags the score down.
    const isNonContent = (t) =>
      /\b(width|height)\s*=\s*["']?1\b/i.test(t) ||           // 1×1 pixel
      /display\s*:\s*none/i.test(t) ||                          // hidden
      /facebook\.com\/tr|google-analytics|googletagmanager|doubleclick|\/(pixel|beacon)\b/i.test(t) || // tracking src
      /\balt\s*=\s*["']\s*["']/i.test(t);                       // alt="" → decorative, by design
    const imgs = (html.match(/<img\b[^>]*>/gi) || []).filter((t) => !isNonContent(t));
    const withAlt = imgs.filter((i) => /\balt=["'][^"']+["']/i.test(i)).length;
    if (imgs.length === 0) checks.push(check('alt', 'Image alt text', 'warn', 'No images detected.', 'Add product images with descriptive alt text.', 1));
    else if (withAlt / imgs.length >= 0.8) checks.push(check('alt', 'Image alt text', 'pass', `${withAlt}/${imgs.length} images have alt text.`, '', 1));
    else checks.push(check('alt', 'Image alt text', 'warn', `Only ${withAlt}/${imgs.length} images have alt text.`, 'Describe every image in its alt attribute (helps image search + accessibility).', 1));

    // ── Content depth ──
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
    const words = (text.match(/\b[\p{L}]{2,}\b/gu) || []).length;
    if (words >= 350) checks.push(check('content', 'Enough content', 'pass', `~${words} words on the homepage.`, '', 1));
    else checks.push(check('content', 'Enough content', 'warn', `Only ~${words} words.`, 'Add more text (300+ words) describing your products, capacity and markets — Google ranks thin pages lower.', 1));

    // ── HTTPS ──
    checks.push(origin.startsWith('https')
      ? check('https', 'Secure (HTTPS)', 'pass', 'Served over HTTPS.', '', 2)
      : check('https', 'Secure (HTTPS)', 'fail', 'Site is not on HTTPS.', 'Install an SSL certificate — Google penalises non-HTTPS sites.', 2));

    // ── lang ──
    checks.push(/<html[^>]+lang=/i.test(html)
      ? check('lang', 'Language declared', 'pass', 'html lang set.', '', 1)
      : check('lang', 'Language declared', 'warn', 'No lang attribute.', 'Add lang="en" to the <html> tag.', 1));
  return checks;
}

let auditCache = null;            // { at, origin, data }  — homepage audit
let siteCache = null;             // { at, origin, data }  — site-wide audit
const AUDIT_TTL = 30 * 60 * 1000; // re-fetch the live site at most every 30 min

const GROWTH_TIPS = [
  { label: 'Create a free Google Business Profile', fix: 'List "Sharv Enterprises" on Google Maps with photos, phone and hours — wins local + brand searches fast.', severity: 'tip' },
  { label: 'Publish buyer-intent blog posts', fix: 'Write articles targeting what wholesalers search: "bulk kurti manufacturer Bihar", "garment exporter MOQ", etc. Each post is a new way to be found.', severity: 'tip' },
  { label: 'Get listed on B2B directories', fix: 'Add your site to IndiaMART, ExportersIndia, TradeIndia and JustDial — these backlinks raise your authority with Google.', severity: 'tip' },
  { label: 'Add product pages with specs', fix: 'A page per product category (fabric, sizes, MOQ, price band) gives Google more keywords to rank you for.', severity: 'tip' },
];

async function runAudit({ force } = {}) {
  const origin = siteOrigin();
  if (!force && auditCache && auditCache.origin === origin && Date.now() - auditCache.at < AUDIT_TTL) return auditCache.data;
  const [home, sitemap, robots] = await Promise.all([
    fetchText(origin + '/'),
    fetchText(origin + '/sitemap.xml'),
    fetchText(origin + '/robots.txt'),
  ]);
  const html = home.body || '';
  const reachable = home.ok && html.length > 0;
  const checks = reachable ? onPageChecks(html, origin) : [];

  // ── Off-page / settings-based (work even if the fetch failed) ──
  checks.push(/(googletagmanager\.com|gtag\(|G-[A-Z0-9]{6,})/.test(html) || setting('GA4_MEASUREMENT_ID')
    ? check('ga', 'Google Analytics installed', 'pass', 'GA4 tag detected / configured.', '', 2)
    : check('ga', 'Google Analytics installed', 'warn', 'No GA4 tag found.', 'Add your GA4 Measurement ID in Connection settings and deploy.', 2));
  checks.push(setting('google_verification') || /google-site-verification/i.test(html)
    ? check('gsc', 'Google Search Console verified', 'pass', 'Verification present.', '', 3)
    : check('gsc', 'Google Search Console verified', 'fail', 'Not verified.', 'Verify the site in Search Console so Google reports your ranking.', 3));
  checks.push(sitemap.ok
    ? check('sitemap', 'Sitemap (sitemap.xml)', 'pass', 'Reachable.', '', 3)
    : check('sitemap', 'Sitemap (sitemap.xml)', 'fail', 'sitemap.xml not reachable.', 'Publish a sitemap.xml and submit it in Search Console.', 3));
  const robotsHasSitemap = robots.ok && /sitemap\s*:/i.test(robots.body || '');
  checks.push(robots.ok
    ? check('robots', 'robots.txt', robotsHasSitemap ? 'pass' : 'warn', robotsHasSitemap ? 'Present and references the sitemap.' : 'Present but does not list the sitemap.', robotsHasSitemap ? '' : 'Add a "Sitemap: <url>" line to robots.txt.', 1)
    : check('robots', 'robots.txt', 'warn', 'No robots.txt.', 'Add a robots.txt that allows crawling and points to your sitemap.', 1));

  const { score, counts } = scoreChecks(checks);
  const actions = checks.filter(c => c.status !== 'pass')
    .sort((a, b) => (b.weight - a.weight) || (a.status === 'fail' ? -1 : 1))
    .map(c => ({ label: c.label, fix: c.fix, severity: c.status }));
  const data = {
    origin, fetchedAt: new Date().toISOString(), reachable,
    score, counts, checks, actions, growth: GROWTH_TIPS,
    fetchError: reachable ? null : (home.error || ('HTTP ' + home.status)),
  };
  auditCache = { at: Date.now(), origin, data };
  return data;
}

// ── Site-wide audit (#6): on-page score for every key page ──
async function runSiteAudit({ force } = {}) {
  const origin = siteOrigin();
  if (!force && siteCache && siteCache.origin === origin && Date.now() - siteCache.at < AUDIT_TTL) return siteCache.data;
  const paths = ['/', '/about', '/contact', '/blog'];
  try {
    db.prepare("SELECT slug FROM site_posts WHERE status='published' ORDER BY published_at DESC LIMIT 8").all()
      .forEach(p => paths.push('/blog/' + p.slug));
  } catch (_) { /* posts table may not exist in older installs */ }
  const pages = await Promise.all(paths.map(async (p) => {
    const r = await fetchText(origin + p);
    if (!r.ok || !r.body) return { path: p, reachable: false, score: null, issues: [] };
    const checks = onPageChecks(r.body, origin);
    const { score } = scoreChecks(checks);
    return { path: p, reachable: true, score, issues: checks.filter(c => c.status !== 'pass').map(c => c.label) };
  }));
  const data = { origin, fetchedAt: new Date().toISOString(), pages };
  siteCache = { at: Date.now(), origin, data };
  return data;
}

// Keyword opportunities from Search Console rows (gsc.queries).
function keywordOpportunities(gsc) {
  const q = (gsc && gsc.queries) || [];
  // "Striking distance": ranking 4–20 → a nudge can reach page 1 / top 3.
  const striking = q.filter(r => r.position > 3 && r.position <= 20)
    .sort((a, b) => b.impressions - a.impressions).slice(0, 8);
  // High impressions but few clicks → the listing shows but nobody clicks:
  // improve the title/description (CTR), not the ranking.
  const lowCtr = q.filter(r => r.impressions >= 5 && r.ctr < 0.03 && r.position <= 12)
    .sort((a, b) => b.impressions - a.impressions).slice(0, 8);
  return { striking, lowCtr, hasData: q.length > 0 };
}

module.exports = { runAudit, runSiteAudit, keywordOpportunities, siteOrigin };
