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
  res.locals.companyName = process.env.COMPANY_NAME || 'Portal ERP';
  res.locals.fmtINR = require('./utils/format').fmtINR;
  res.locals.fmtDate = require('./utils/format').fmtDate;
  res.locals.path = req.path;
  next();
});

// Routes
app.use('/', require('./routes/auth'));
const { requireAuth } = require('./middleware/auth');
app.use(requireAuth);

app.use('/', require('./routes/dashboard'));
app.use('/users', require('./routes/users'));
app.use('/products', require('./routes/products'));
app.use('/categories', require('./routes/categories'));
app.use('/raw-materials', require('./routes/rawMaterials'));
app.use('/suppliers', require('./routes/suppliers'));
app.use('/fabric-cost', require('./routes/fabricCost'));
app.use('/expenses', require('./routes/expenses'));
app.use('/production', require('./routes/production'));
app.use('/stock', require('./routes/stock'));
app.use('/dealers', require('./routes/dealers'));
app.use('/sales-orders', require('./routes/salesOrders'));
app.use('/invoices', require('./routes/invoices'));
app.use('/payments', require('./routes/payments'));
app.use('/payment-modes', require('./routes/paymentModes'));
app.use('/dispatch', require('./routes/dispatch'));
app.use('/returns', require('./routes/returns'));
app.use('/reports', require('./routes/reports'));
app.use('/import', require('./routes/import'));
app.use('/notifications', require('./routes/notifications'));
app.use('/mobile', require('./routes/mobile'));

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
