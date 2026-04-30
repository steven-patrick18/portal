const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db } = require('../db');
const { requireRole, flash } = require('../middleware/auth');
const router = express.Router();
router.use(requireRole('admin'));

const BRAND_DIR = path.join(__dirname, '..', '..', 'public', 'uploads', 'branding');
if (!fs.existsSync(BRAND_DIR)) fs.mkdirSync(BRAND_DIR, { recursive: true });
const brandUpload = multer({
  storage: multer.diskStorage({
    destination: BRAND_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.png';
      cb(null, 'logo_' + Date.now() + ext);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g|webp|svg\+xml|gif)$/i.test(file.mimetype)),
});

function getSetting(key, fallback) {
  const r = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  return r ? r.value : (fallback !== undefined ? fallback : (process.env[key] || ''));
}
function setSetting(key, value, userId) {
  db.prepare(`INSERT INTO app_settings (key, value, updated_by) VALUES (?,?,?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now'), updated_by=excluded.updated_by`)
    .run(key, value || '', userId || null);
}

router.get('/', (req, res) => res.redirect('/settings/branding'));

// ---------- Company Branding (white-label) ----------
function getBranding() {
  return {
    name:    getSetting('COMPANY_NAME',    process.env.COMPANY_NAME    || 'Portal ERP'),
    logo:    getSetting('COMPANY_LOGO',    ''),
    address: getSetting('COMPANY_ADDRESS', process.env.COMPANY_ADDRESS || ''),
    phone:   getSetting('COMPANY_PHONE',   process.env.COMPANY_PHONE   || ''),
    email:   getSetting('COMPANY_EMAIL',   process.env.COMPANY_EMAIL   || ''),
    gstin:   getSetting('COMPANY_GSTIN',   process.env.COMPANY_GSTIN   || ''),
    state:   getSetting('COMPANY_STATE',   process.env.COMPANY_STATE   || ''),
  };
}

router.get('/branding', (req, res) => {
  res.render('settings/branding', { title: 'Company Branding', cfg: getBranding() });
});

router.post('/branding', brandUpload.single('logo'), (req, res) => {
  const u = req.session.user.id;
  setSetting('COMPANY_NAME',    (req.body.name||'').trim() || 'Portal ERP', u);
  setSetting('COMPANY_ADDRESS', req.body.address, u);
  setSetting('COMPANY_PHONE',   req.body.phone, u);
  setSetting('COMPANY_EMAIL',   req.body.email, u);
  setSetting('COMPANY_GSTIN',   req.body.gstin, u);
  setSetting('COMPANY_STATE',   req.body.state, u);
  if (req.file) {
    // Delete previous logo file (if any) to keep the uploads dir tidy
    const prev = getSetting('COMPANY_LOGO', '');
    if (prev) {
      const prevPath = path.join(__dirname, '..', '..', 'public', prev.replace(/^\//, ''));
      if (fs.existsSync(prevPath)) { try { fs.unlinkSync(prevPath); } catch(_) {} }
    }
    setSetting('COMPANY_LOGO', '/uploads/branding/' + req.file.filename, u);
  } else if (req.body.remove_logo === '1') {
    const prev = getSetting('COMPANY_LOGO', '');
    if (prev) {
      const prevPath = path.join(__dirname, '..', '..', 'public', prev.replace(/^\//, ''));
      if (fs.existsSync(prevPath)) { try { fs.unlinkSync(prevPath); } catch(_) {} }
    }
    setSetting('COMPANY_LOGO', '', u);
  }
  req.audit('settings_save', 'branding', null, `name=${req.body.name||''} · logo=${req.file?req.file.filename:'(unchanged)'}`);
  flash(req, 'success', 'Branding updated.');
  res.redirect('/settings/branding');
});

// MSG91 was removed — SMS now goes only through the Capcom Android phone
// gateway. /settings/msg91 redirects to the unified /settings/sms page.
router.get('/msg91', (_req, res) => res.redirect('/settings/sms'));

// ---------- SMS provider selection + Capcom Gateway settings ----------
router.get('/sms', (req, res) => {
  const cfg = {
    provider:      getSetting('SMS_PROVIDER',         'off'),
    gateway_url:   getSetting('SMS_GATEWAY_URL',      'https://api.sms-gate.app/3rdparty/v1'),
    gateway_user:  getSetting('SMS_GATEWAY_USERNAME', ''),
    gateway_pass:  getSetting('SMS_GATEWAY_PASSWORD', ''),
    tpl_invoice:   getSetting('SMS_TEMPLATE_INVOICE',     'Hi {dealer}, invoice {invoice_no} of Rs.{amount} ready. Outstanding now Rs.{outstanding}. Thanks - {company}'),
    tpl_payment:   getSetting('SMS_TEMPLATE_PAYMENT',     'Hi {dealer}, payment of Rs.{amount} received on {date} (ref {ref}). Outstanding balance now Rs.{outstanding}. Thank you for your business — visit us for our latest collection! - {company}'),
    tpl_dispatch:  getSetting('SMS_TEMPLATE_DISPATCH',    'Hi {dealer}, your order has been dispatched. Vehicle: {vehicle}, LR: {lr}. Thanks - {company}'),
    tpl_outstand:  getSetting('SMS_TEMPLATE_OUTSTANDING', 'Hi {dealer}, your outstanding balance is Rs.{amount} across {count} invoice(s). Please clear at earliest. - {company}'),
    auto_payment:  getSetting('SMS_AUTO_SEND_PAYMENT',    'true') !== 'false',
    auto_invoice:  getSetting('SMS_AUTO_SEND_INVOICE',    'true') !== 'false',
    auto_dispatch: getSetting('SMS_AUTO_SEND_DISPATCH',   'true') !== 'false',
  };
  const recent = db.prepare(`SELECT n.*, d.name AS dealer_name FROM notifications_log n LEFT JOIN dealers d ON d.id=n.related_dealer_id ORDER BY n.id DESC LIMIT 10`).all();
  res.render('settings/sms', { title: 'SMS Settings', cfg, recent });
});

router.post('/sms', (req, res) => {
  const u = req.session.user.id;
  setSetting('SMS_PROVIDER',         req.body.provider, u);
  setSetting('SMS_GATEWAY_URL',      req.body.gateway_url, u);
  setSetting('SMS_GATEWAY_USERNAME', req.body.gateway_user, u);
  if (req.body.gateway_pass)         setSetting('SMS_GATEWAY_PASSWORD', req.body.gateway_pass, u);
  setSetting('SMS_TEMPLATE_INVOICE',     req.body.tpl_invoice, u);
  setSetting('SMS_TEMPLATE_PAYMENT',     req.body.tpl_payment, u);
  setSetting('SMS_TEMPLATE_DISPATCH',    req.body.tpl_dispatch, u);
  setSetting('SMS_TEMPLATE_OUTSTANDING', req.body.tpl_outstand, u);
  setSetting('SMS_AUTO_SEND_PAYMENT',    req.body.auto_payment  === '1' ? 'true' : 'false', u);
  setSetting('SMS_AUTO_SEND_INVOICE',    req.body.auto_invoice  === '1' ? 'true' : 'false', u);
  setSetting('SMS_AUTO_SEND_DISPATCH',   req.body.auto_dispatch === '1' ? 'true' : 'false', u);
  req.audit('settings_save', 'sms', null, `provider=${req.body.provider}`);
  flash(req, 'success', 'SMS settings saved.');
  res.redirect('/settings/sms');
});

router.post('/sms/test', async (req, res) => {
  const { sendSMS } = require('../utils/sms');
  const phone = req.body.test_phone;
  if (!phone) { flash(req, 'danger', 'Enter a phone number to test'); return res.redirect('/settings/sms'); }
  const r = await sendSMS({ to: phone, message: 'Portal ERP test message — SMS config is working.' });
  if (r.stub)         flash(req, 'warning', 'Test/Off mode — message logged only. Switch SMS Mode to "Android Phone Gateway" to send real SMS.');
  else if (r.ok)      flash(req, 'success', 'Test SMS dispatched. Check the recipient phone in a moment.');
  else                flash(req, 'danger', 'Failed: ' + (r.error || 'unknown error'));
  res.redirect('/settings/sms');
});

// ---------- Access Control / Roles overview (editable matrix) ----------
// Features are organized into sections so the matrix is scannable. Adding
// a new module? Add an entry here AND an entry in db/index.js featureDefaults
// (so existing role_permissions get the column).
const FEATURE_SECTIONS = [
  { title: 'Core', features: [
    { key: 'dashboard', label: 'Dashboard',          desc: 'Home page with KPI cards' },
  ]},
  { title: 'Inventory & Production', features: [
    { key: 'products',     label: 'Products / Categories', desc: 'Product master, hangtags, BOM' },
    { key: 'materials',    label: 'Raw Materials / Suppliers', desc: 'Raw stock + supplier prices' },
    { key: 'bom',          label: 'BOM (per product)',     desc: 'Bill of materials editor' },
    { key: 'production',   label: 'Production Batches',    desc: 'Batches, stages, worker entries' },
    { key: 'fabric_costs', label: 'Fabric Cost / Mfg Expenses', desc: 'Costing tools + monthly expenses' },
    { key: 'stock',        label: 'Ready Stock & Movements', desc: 'Finished-goods stock, piece tracking' },
  ]},
  { title: 'Sales', features: [
    { key: 'dealers',  label: 'Dealers',                 desc: 'Customer master, credit limits' },
    { key: 'sales',    label: 'Sales Orders / Invoices', desc: 'Quotes, orders, GST invoices, discounts' },
    { key: 'payments', label: 'Payments',                desc: 'Receive, verify, reconcile' },
    { key: 'dispatch', label: 'Dispatch & Returns',      desc: 'Shipping + customer returns' },
  ]},
  { title: 'Purchasing', features: [
    { key: 'purchasing', label: 'Purchasing & Vendor Prices', desc: 'POs, vendor compare' },
  ]},
  { title: 'HR & Payroll', features: [
    { key: 'hr', label: 'HR / Payroll', desc: 'Employees, attendance, per-piece, KM, advances, incentives, salary' },
  ]},
  { title: 'Reports & Audit', features: [
    { key: 'reports',  label: 'Reports',                          desc: 'Sales, production, GST, P&L' },
    { key: 'activity', label: 'Activity Log (audit trail)',       desc: 'Who did what, when' },
  ]},
  { title: 'Communication & Help', features: [
    { key: 'notifications', label: 'Notifications (SMS/WhatsApp)', desc: 'Outbound messages to dealers' },
    { key: 'training',      label: 'Training Module',              desc: 'Read-only learning slides + guides' },
  ]},
  { title: 'Admin', features: [
    { key: 'settings', label: 'Users / Settings / Branding / Import', desc: 'User management, company logo, payment modes, categories, role matrix' },
  ]},
];
// Flat list for backward-compat (used by the validation in /access/update)
const FEATURES = FEATURE_SECTIONS.flatMap(s => s.features);
const ROLES = ['owner', 'admin', 'accountant', 'salesperson', 'production', 'store', 'purchaser'];
const LEVELS = ['none', 'view', 'limited', 'full'];

router.get('/access', (req, res) => {
  const users = db.prepare('SELECT id,name,email,phone,role,active FROM users ORDER BY role, name').all();
  const rows = db.prepare('SELECT role, feature_key, level FROM role_permissions').all();
  // Build a lookup: matrix[role][feature_key] = level
  const matrix = {};
  ROLES.forEach(r => { matrix[r] = {}; });
  rows.forEach(r => { if (matrix[r.role]) matrix[r.role][r.feature_key] = r.level; });
  res.render('settings/access', { title: 'User Access & Roles', users, matrix, features: FEATURES, sections: FEATURE_SECTIONS, roles: ROLES, levels: LEVELS });
});

router.post('/access/update', (req, res) => {
  const { role, feature_key, level } = req.body;
  if (!ROLES.includes(role) || !FEATURES.find(f => f.key === feature_key) || !LEVELS.includes(level)) {
    return res.status(400).json({ ok: false, error: 'invalid' });
  }
  if (role === 'owner') return res.status(400).json({ ok: false, error: 'owner permissions cannot be changed' });
  db.prepare(`INSERT INTO role_permissions (role, feature_key, level, updated_by) VALUES (?,?,?,?)
              ON CONFLICT(role, feature_key) DO UPDATE SET level=excluded.level, updated_at=datetime('now'), updated_by=excluded.updated_by`)
    .run(role, feature_key, level, req.session.user.id);
  req.audit('permission_change', 'role_permissions', null, `${role} / ${feature_key} → ${level}`);
  res.json({ ok: true });
});

// Helper used elsewhere to check a user's level for a feature
function getUserLevel(userRole, featureKey) {
  if (userRole === 'owner') return 'full';
  const r = db.prepare('SELECT level FROM role_permissions WHERE role=? AND feature_key=?').get(userRole, featureKey);
  return r ? r.level : 'none';
}


// ---------- Custom Production Stages ----------
router.get('/stages', (req, res) => {
  const stages = db.prepare('SELECT * FROM production_stages_master ORDER BY sort_order, id').all();
  res.render('settings/stages', { title: 'Production Stages', stages });
});

router.post('/stages', (req, res) => {
  const { stage_key, label, sort_order } = req.body;
  const key = (stage_key || label).toLowerCase().trim().replace(/[^a-z0-9_]/g, '_');
  if (!key || !label) { flash(req, 'danger', 'Need stage key and label'); return res.redirect('/settings/stages'); }
  try {
    db.prepare('INSERT INTO production_stages_master (stage_key, label, sort_order) VALUES (?,?,?)').run(key, label, parseInt(sort_order || 100));
    flash(req, 'success', 'Stage added.');
  } catch (e) {
    flash(req, 'danger', /UNIQUE/.test(e.message) ? 'A stage with that key already exists.' : e.message);
  }
  res.redirect('/settings/stages');
});

router.post('/stages/:id/update', (req, res) => {
  const { label, sort_order, active } = req.body;
  db.prepare('UPDATE production_stages_master SET label=?, sort_order=?, active=? WHERE id=?')
    .run(label, parseInt(sort_order || 100), active ? 1 : 0, req.params.id);
  flash(req, 'success', 'Stage updated.');
  res.redirect('/settings/stages');
});

router.post('/stages/:id/delete', (req, res) => {
  const s = db.prepare('SELECT * FROM production_stages_master WHERE id=?').get(req.params.id);
  if (!s) return res.redirect('/settings/stages');
  if (s.is_default) { flash(req, 'danger', 'Cannot delete a default stage; deactivate instead.'); return res.redirect('/settings/stages'); }
  db.prepare('DELETE FROM production_stages_master WHERE id=?').run(req.params.id);
  flash(req, 'success', 'Stage deleted.');
  res.redirect('/settings/stages');
});

// Helper function exported for use elsewhere
function getActiveStages() {
  return db.prepare('SELECT * FROM production_stages_master WHERE active=1 ORDER BY sort_order, id').all();
}

module.exports = router;
module.exports.getSetting = getSetting;
module.exports.setSetting = setSetting;
module.exports.getActiveStages = getActiveStages;
module.exports.getUserLevel = getUserLevel;
module.exports.getBranding = getBranding;
