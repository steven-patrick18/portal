const path = require('path');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

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
      scriptSrc:  ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      styleSrc:   ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      fontSrc:    ["'self'", 'data:', 'https://cdn.jsdelivr.net'],
      imgSrc:     ["'self'", 'data:', 'https://cdn.jsdelivr.net', 'https://maps.google.com', 'https://*.googleusercontent.com'],
      connectSrc: ["'self'"],
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

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',           // primary CSRF defense — modern browsers won't send the cookie on cross-site POSTs
    maxAge: 1000 * 60 * 60 * 12, // 12h
  },
}));

// Rate-limit the login endpoint to slow down brute-force attempts.
// 5 attempts per IP per 15 minutes. We treat *only* the "302 → /"
// redirect (successful login) as not-counting; a failed login also
// returns 302 (redirect back to /login) and MUST count, otherwise the
// brute-forcer gets unlimited tries.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  requestWasSuccessful: (req, res) => {
    const loc = res.getHeader('Location');
    return res.statusCode === 302 && loc === '/';
  },
  handler: (req, res) => {
    res.status(429).type('text/plain').send('Too many login attempts from your IP. Please wait 15 minutes and try again.');
  },
});
// Only enforce the rate-limit in production. In dev/test we'd keep tripping
// it from local testing and have to restart the server to clear it.
app.use('/login', (req, res, next) => {
  if (req.method !== 'POST' || !isProd) return next();
  return loginLimiter(req, res, next);
});

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
  res.locals.fmtDate = fmt.fmtDate;
  res.locals.todayLocal = fmt.todayLocal;
  res.locals.path = req.path;
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

// Routes
app.use('/', require('./routes/auth'));
const { requireAuth } = require('./middleware/auth');
const { requireFeature, requireWrite, getAllPermsForRole, canWrite } = require('./middleware/permissions');
const { auditMiddleware } = require('./utils/audit');
app.use(requireAuth);
app.use(auditMiddleware);

// Expose user's permission map + canWrite() to all views
app.use((req, res, next) => {
  if (req.session.user) {
    res.locals.perms = getAllPermsForRole(req.session.user.role);
    res.locals.canWrite = (feature) => canWrite(req.session.user.role, feature);
  } else {
    res.locals.perms = {};
    res.locals.canWrite = () => false;
  }
  next();
});

app.use('/', require('./routes/dashboard'));
app.use('/users',         requireFeature('settings'),      requireWrite('settings'),      require('./routes/users'));
app.use('/products',      requireFeature('products'),      requireWrite('products'),      require('./routes/products'));
app.use('/categories',    requireFeature('products'),      requireWrite('products'),      require('./routes/categories'));
app.use('/raw-materials', requireFeature('materials'),     requireWrite('materials'),     require('./routes/rawMaterials'));
app.use('/suppliers',     requireFeature('materials'),     requireWrite('materials'),     require('./routes/suppliers'));
app.use('/fabric-cost',   requireFeature('fabric_costs'),  requireWrite('fabric_costs'),  require('./routes/fabricCost'));
app.use('/expenses',      requireFeature('fabric_costs'),  requireWrite('fabric_costs'),  require('./routes/expenses'));
app.use('/production',    requireFeature('production'),    requireWrite('production'),    require('./routes/production'));
app.use('/stock',         requireFeature('stock'),         requireWrite('stock'),         require('./routes/stock'));
app.use('/dealers',       requireFeature('dealers'),       requireWrite('dealers'),       require('./routes/dealers'));
app.use('/sales-orders',  requireFeature('sales'),         requireWrite('sales'),         require('./routes/salesOrders'));
app.use('/invoices',      requireFeature('sales'),         requireWrite('sales'),         require('./routes/invoices'));
app.use('/payments',      requireFeature('payments'),      requireWrite('payments'),      require('./routes/payments'));
app.use('/payment-modes', requireFeature('settings'),      requireWrite('settings'),      require('./routes/paymentModes'));
app.use('/dispatch',      requireFeature('dispatch'),      requireWrite('dispatch'),      require('./routes/dispatch'));
app.use('/returns',       requireFeature('dispatch'),      requireWrite('dispatch'),      require('./routes/returns'));
app.use('/reports',       requireFeature('reports'),       require('./routes/reports'));
app.use('/import',        requireFeature('settings'),      requireWrite('settings'),      require('./routes/import'));
app.use('/notifications', requireFeature('notifications'), requireWrite('notifications'), require('./routes/notifications'));
app.use('/settings',      requireFeature('settings'),      requireWrite('settings'),      require('./routes/settings'));
app.use('/purchasing',    requireFeature('purchasing'),    requireWrite('purchasing'),    require('./routes/purchasing'));
app.use('/activity',      requireFeature('activity'),                                     require('./routes/activity'));
app.use('/hr',            requireFeature('hr'),            requireWrite('hr'),            require('./routes/hr'));
app.use('/training',      requireFeature('training'),                                     require('./routes/training'));
app.use('/mobile',        require('./routes/mobile')); // always allowed for logged-in users

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
