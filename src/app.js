const path = require('path');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const helmet = require('helmet');
const compression = require('compression');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(morgan('dev'));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
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
  res.locals.fmtDate = fmt.fmtDate;
  res.locals.todayLocal = fmt.todayLocal;
  res.locals.path = req.path;
  next();
});

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
