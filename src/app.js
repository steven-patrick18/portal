const path = require('path');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const helmet = require('helmet');
const compression = require('compression');

const app = express();

// ── PRODUCTION SAFETY: hard-fail if SESSION_SECRET is unset or default ──
const isProd = process.env.NODE_ENV === 'production';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
if (isProd && (SESSION_SECRET === 'dev-secret-change-me' || SESSION_SECRET.length < 32)) {
  console.error('FATAL: SESSION_SECRET is missing or too weak in production. Generate one with:');
  console.error('  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64\'))"');
  console.error('Then set it in .env and restart.');
  process.exit(1);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

// Behind nginx/proxy: trust X-Forwarded-* so secure-cookie detection,
// req.ip, and rate-limiter keying all work correctly. '1' = trust the
// first hop (the local nginx), not arbitrary headers from the wider net.
app.set('trust proxy', 1);

// Helmet with a sensible CSP that allows the CDNs we actually use
// (Bootstrap, Bootstrap Icons, Tom Select) plus inline styles/scripts
// the EJS templates emit. Adjust if you add more CDNs.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://www.googletagmanager.com', 'https://www.google-analytics.com'],
      // scriptSrcAttr governs INLINE event handlers (onclick="…",
      // onsubmit="…" etc.). Helmet defaults this to 'none' which silently
      // breaks every onclick="window.print()" on the site. We allow
      // 'unsafe-inline' here to match scriptSrc — consistent with the
      // legacy templates that still emit inline handlers.
      scriptSrcAttr: ["'unsafe-inline'"],
      // styleSrcElem governs <link rel="stylesheet"> + <style> blocks
      // specifically. Without it, Helmet's defaults block Google Fonts.
      // Mirror styleSrc + fonts.googleapis.com so the Plus Jakarta Sans /
      // JetBrains Mono @import in app.css actually loads.
      styleSrc:    ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://fonts.googleapis.com'],
      styleSrcElem:["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://fonts.googleapis.com'],
      fontSrc:    ["'self'", 'data:', 'https://cdn.jsdelivr.net', 'https://fonts.gstatic.com'],
      imgSrc:     ["'self'", 'data:', 'https://cdn.jsdelivr.net', 'https://maps.google.com', 'https://*.googleusercontent.com', 'https://*.tile.openstreetmap.org', 'https://www.googletagmanager.com', 'https://*.google-analytics.com'],
      connectSrc: ["'self'", 'https://*.google-analytics.com', 'https://*.analytics.google.com', 'https://www.googletagmanager.com'],
      // Allow the public website to embed factory/product videos.
      frameSrc:   ["'self'", 'https://www.youtube.com', 'https://www.youtube-nocookie.com', 'https://player.vimeo.com'],
      frameAncestors: ["'self'"],
      objectSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,  // allows the favicon SVG data: URL
}));
app.use(compression());
app.use(morgan(isProd ? 'combined' : 'dev'));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Cache-bust token for /css/app.css and /js/app.js — the browser will
// refetch them automatically every time we deploy because the URL
// changes. Computed once at boot from each file's mtime. Without this,
// users see stale CSS/JS for days (e.g. print-styles fix not applying
// because /css/app.css is cached).
const _fs = require('fs');
function _assetVer(rel) {
  try { return String(_fs.statSync(path.join(__dirname, '..', 'public', rel)).mtimeMs | 0); }
  catch (_) { return Date.now().toString(); }
}
const ASSET_VER_CSS = _assetVer('css/app.css');
const ASSET_VER_JS  = _assetVer('js/app.js');

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  // 'auto' lets express-session decide per-request: it sets Secure only when
  // the connection actually is HTTPS (using the trust-proxy setting above to
  // honour X-Forwarded-Proto from nginx). A static `secure: true` would refuse
  // the cookie if any single request looked non-HTTPS to Express — a footgun
  // we hit on first deploy when the Set-Cookie was being silently dropped.
  proxy: true,
  cookie: {
    httpOnly: true,
    secure: isProd ? 'auto' : false,
    sameSite: 'lax',           // primary CSRF defense — modern browsers won't send the cookie on cross-site POSTs
    maxAge: 1000 * 60 * 60 * 12, // 12h
  },
}));

// Flash messages (super-light, no extra dep)
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || null;
  req.session.flash = null;
  res.locals.user = req.session.user || null;
  // Brand (logo + company info) — pulled from app_settings, with env-var fallback.
  // Cheap query (1 row × 7 keys) but cached per-request to avoid duplicate hits.
  let _brand;
  try { _brand = require('./routes/settings').getBranding(); }
  catch (_) { _brand = { name: process.env.COMPANY_NAME || 'Portal ERP', logo: '', address:'', phone:'', email:'', gstin:'', state:'' }; }
  res.locals.brand = _brand;
  res.locals.companyName = _brand.name;
  const fmt = require('./utils/format');
  res.locals.fmtINR = fmt.fmtINR;
  res.locals.fmtRate = fmt.fmtRate;
  res.locals.fmtDate = fmt.fmtDate;
  res.locals.fmtDateTime = fmt.fmtDateTime;
  res.locals.fmtTime = fmt.fmtTime;
  res.locals.todayLocal = fmt.todayLocal;
  res.locals.amountInWordsINR = fmt.amountInWordsINR;
  res.locals.path = req.path;
  res.locals.assetVerCss = ASSET_VER_CSS;
  res.locals.assetVerJs  = ASSET_VER_JS;
  next();
});

// CSRF defense for this app is handled silently at the cookie layer:
//   sameSite='lax' on the session cookie (set in the session middleware
//   above) means modern browsers already refuse to send the cookie on
//   cross-site POSTs — no token, no Origin check, no user friction.
//
// We previously added a strict Origin/Referer same-host check on top,
// but it was rejecting legitimate users when their browser stripped or
// changed those headers (privacy modes, opening from address bar after
// a cached redirect, etc.). For an internal-network ERP that's not
// worth the support pain — sameSite=lax is sufficient.

// ── Public-domain routing ────────────────────────────────────────
// When a request arrives on the public marketing domain (sharvexport.com),
// serve ONLY the website — never the ERP. The ERP stays exclusively on
// portal.firelockfashion.com. One Node process, two faces, decided by the
// Host header. Configure the public host(s) via PUBLIC_SITE_HOSTS.
const PUBLIC_SITE_HOSTS = (process.env.PUBLIC_SITE_HOSTS || 'sharvexports.com,www.sharvexports.com,sharvexport.com,www.sharvexport.com')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
app.use((req, res, next) => {
  const host = (req.hostname || '').toLowerCase();
  if (!PUBLIC_SITE_HOSTS.includes(host)) return next();   // ERP domain → unchanged
  const p = req.path;
  // Static assets + already-namespaced site paths pass straight through.
  // NOTE the segment boundary on /site — without it, '/sitemap.xml'
  // (which starts with "site") would wrongly skip the rewrite.
  if (p === '/site' || p.startsWith('/site/') || p.startsWith('/uploads/') ||
      p.startsWith('/css/') || p.startsWith('/js/') || p.startsWith('/favicon')) return next();
  // Everything else on the public domain is the website: rewrite the path
  // under /site so the site router serves it (/, /about, /contact, /blog,
  // /blog/:slug, /robots.txt, /sitemap.xml, /enquiry). The site router's
  // catch-all redirects anything unknown back to home, so the ERP (login,
  // dashboard, …) is never reachable on the public domain.
  req.url = '/site' + (req.url === '/' ? '' : req.url);
  return next();
});

// Routes
app.use('/', require('./routes/auth'));
// Public marketing website (sharvexport.com) — mounted BEFORE the auth
// gate so it's open to the world. Reads only the site_content / products
// / certifications tables; never touches ERP business data.
app.use('/site', require('./routes/site'));
const { requireAuth } = require('./middleware/auth');
const { requireFeature, requireWrite, getAllPermsForUser, canWrite } = require('./middleware/permissions');
const { auditMiddleware } = require('./utils/audit');
app.use(requireAuth);
app.use(auditMiddleware);

// Expose user's permission map + canWrite() to all views
app.use((req, res, next) => {
  if (req.session.user) {
    res.locals.perms = getAllPermsForUser(req.session.user);
    res.locals.canWrite = (feature) => canWrite(req.session.user, feature);
  } else {
    res.locals.perms = {};
    res.locals.canWrite = () => false;
  }
  next();
});

app.use('/', require('./routes/dashboard'));
// /users/me + /users/me/password are open to any authenticated user (their
// own profile + password change). The admin user-CRUD sub-section is gated
// inside the router itself with requireRole('admin') + 'settings_users'.
app.use('/users',         require('./routes/users'));
app.use('/locations',     requireFeature('settings_locations'), requireWrite('settings_locations'), require('./routes/locations'));
app.use('/products',      requireFeature('products'),      requireWrite('products'),      require('./routes/products'));
app.use('/categories',    requireFeature('products'),      requireWrite('products'),      require('./routes/categories'));
app.use('/raw-materials', requireFeature('materials'),     requireWrite('materials'),     require('./routes/rawMaterials'));
app.use('/suppliers',     requireFeature('materials'),     requireWrite('materials'),     require('./routes/suppliers'));
app.use('/fabric-cost',   requireFeature('fabric_costs'),  requireWrite('fabric_costs'),  require('./routes/fabricCost'));
app.use('/expenses',      requireFeature('fabric_costs'),  requireWrite('fabric_costs'),  require('./routes/expenses'));
app.use('/production',    requireFeature('production'),    requireWrite('production'),    require('./routes/production'));
app.use('/stock',         requireFeature('stock'),         requireWrite('stock'),         require('./routes/stock'));
app.use('/dealers',       requireFeature('dealers'),       requireWrite('dealers'),       require('./routes/dealers'));
app.use('/sales-orders',  requireFeature('sales_orders'),  requireWrite('sales_orders'),  require('./routes/salesOrders'));
app.use('/invoices',      requireFeature('sales_invoices'),requireWrite('sales_invoices'),require('./routes/invoices'));
app.use('/payments',      requireFeature('payments'),      requireWrite('payments'),      require('./routes/payments'));
app.use('/payment-modes', requireFeature('settings_payment_modes'), requireWrite('settings_payment_modes'), require('./routes/paymentModes'));
app.use('/dispatch',      requireFeature('dispatch'),      requireWrite('dispatch'),      require('./routes/dispatch'));
app.use('/returns',       requireFeature('dispatch'),      requireWrite('dispatch'),      require('./routes/returns'));
app.use('/reports',       requireFeature('reports'),       require('./routes/reports'));
app.use('/import',        requireFeature('settings_import'),        requireWrite('settings_import'),        require('./routes/import'));
app.use('/notifications', requireFeature('notifications'), requireWrite('notifications'), require('./routes/notifications'));
app.use('/settings',      requireFeature('settings'),      requireWrite('settings'),      require('./routes/settings'));
app.use('/purchasing',    requireFeature('purchasing'),    requireWrite('purchasing'),    require('./routes/purchasing'));
app.use('/activity',      requireFeature('activity'),                                     require('./routes/activity'));
app.use('/hr',            requireFeature('hr'),            requireWrite('hr'),            require('./routes/hr'));
app.use('/website',       require('./routes/website')); // per-section gating (website / website_enquiries / website_insights) is inside the router
app.use('/training',      requireFeature('training'),                                     require('./routes/training'));
// Visits namespace splits into two permission spaces:
//   /visits/factory/*  → gated by the 'factory_log' feature (so production /
//                        store / accountant can do in/out without seeing
//                        dealer visits)
//   /visits/*          → gated by 'visits' (dealer visits, KM report, etc.)
function visitsAuth(req, res, next) {
  const isFactory = req.path.startsWith('/factory');
  const feature = isFactory ? 'factory_log' : 'visits';
  return requireFeature(feature)(req, res, () => requireWrite(feature)(req, res, next));
}
app.use('/visits',        visitsAuth,                                                    require('./routes/visits'));
app.use('/tasks',         requireFeature('tasks'),         requireWrite('tasks'),         require('./routes/tasks'));
app.use('/admin-funds',   requireFeature('admin_funds'),   requireWrite('admin_funds'),   require('./routes/adminFunds'));
// Catalogue / AI module — fully isolated. Drop this line to disable the
// entire module without affecting anything else.
app.use('/catalogue',     requireFeature('catalogue'),     requireWrite('catalogue'),     require('./routes/catalogue'));
app.use('/mobile',        require('./routes/mobile')); // always allowed for logged-in users

// ── Temporary debug endpoint (owner-only) ───────────────────────
// Returns the raw client info Express sees so we can diagnose why
// the activity log is showing 127.0.0.1 on the live VPS. Safe to
// leave in long-term — it leaks nothing the owner couldn't read
// from the activity log anyway, and is gated to owner role.
app.get('/_debug/whoami', (req, res) => {
  if (!req.session || !req.session.user || req.session.user.role !== 'owner') {
    return res.status(403).json({ error: 'owner only' });
  }
  res.json({
    'app.get(trust proxy)': app.get('trust proxy'),
    'req.ip':                req.ip,
    'req.ips':               req.ips,
    'req.protocol':          req.protocol,
    'req.secure':            req.secure,
    'req.connection.remoteAddress': req.connection ? req.connection.remoteAddress : null,
    'req.socket.remoteAddress':     req.socket ? req.socket.remoteAddress : null,
    headers: {
      'x-forwarded-for':   req.headers['x-forwarded-for']   || null,
      'x-real-ip':         req.headers['x-real-ip']         || null,
      'x-forwarded-proto': req.headers['x-forwarded-proto'] || null,
      'x-forwarded-host':  req.headers['x-forwarded-host']  || null,
      host:                req.headers['host']              || null,
      'user-agent':        req.headers['user-agent']        || null,
    },
  });
});

// 404
app.use((req, res) => {
  res.status(404).render('error', { title: 'Not Found', message: 'Page not found', code: 404 });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', {
    title: 'Server Error',
    message: process.env.NODE_ENV === 'production' ? 'Something went wrong.' : err.message,
    code: 500,
  });
});

module.exports = app;
