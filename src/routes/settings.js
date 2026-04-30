const express = require('express');
const { db } = require('../db');
const { requireRole, flash } = require('../middleware/auth');
const router = express.Router();
router.use(requireRole('admin'));

function getSetting(key, fallback) {
  const r = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  return r ? r.value : (fallback !== undefined ? fallback : (process.env[key] || ''));
}
function setSetting(key, value, userId) {
  db.prepare(`INSERT INTO app_settings (key, value, updated_by) VALUES (?,?,?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now'), updated_by=excluded.updated_by`)
    .run(key, value || '', userId || null);
}

router.get('/', (req, res) => res.redirect('/settings/msg91'));

// ---------- MSG91 ----------
router.get('/msg91', (req, res) => {
  const cfg = {
    enabled: getSetting('MSG91_ENABLED', process.env.MSG91_ENABLED || 'false'),
    auth_key: getSetting('MSG91_AUTH_KEY', process.env.MSG91_AUTH_KEY || ''),
    sender_id: getSetting('MSG91_SENDER_ID', process.env.MSG91_SENDER_ID || 'PORTAL'),
    template_payment: getSetting('MSG91_DLT_TEMPLATE_PAYMENT', process.env.MSG91_DLT_TEMPLATE_PAYMENT || ''),
    template_outstanding: getSetting('MSG91_DLT_TEMPLATE_OUTSTANDING', process.env.MSG91_DLT_TEMPLATE_OUTSTANDING || ''),
    template_whatsapp: getSetting('MSG91_WHATSAPP_TEMPLATE', process.env.MSG91_WHATSAPP_TEMPLATE || ''),
  };
  const recent = db.prepare(`SELECT * FROM notifications_log ORDER BY id DESC LIMIT 5`).all();
  res.render('settings/msg91', { title: 'MSG91 Configuration', cfg, recent });
});

router.post('/msg91', (req, res) => {
  const u = req.session.user.id;
  setSetting('MSG91_ENABLED', req.body.enabled === '1' ? 'true' : 'false', u);
  setSetting('MSG91_AUTH_KEY', req.body.auth_key, u);
  setSetting('MSG91_SENDER_ID', req.body.sender_id, u);
  setSetting('MSG91_DLT_TEMPLATE_PAYMENT', req.body.template_payment, u);
  setSetting('MSG91_DLT_TEMPLATE_OUTSTANDING', req.body.template_outstanding, u);
  setSetting('MSG91_WHATSAPP_TEMPLATE', req.body.template_whatsapp, u);
  flash(req, 'success', 'MSG91 settings saved. Active immediately for new messages.');
  res.redirect('/settings/msg91');
});

router.post('/msg91/test', async (req, res) => {
  const { sendSMS } = require('../utils/msg91');
  const phone = req.body.test_phone;
  if (!phone) { flash(req, 'danger', 'Enter a phone number to test'); return res.redirect('/settings/msg91'); }
  try {
    const r = await sendSMS({ to: phone, message: 'Portal ERP test message — config is working ✓' });
    flash(req, r.ok ? 'success' : 'warning', r.stub ? 'Stub mode — message logged but not actually sent. Enable MSG91 in settings to send real messages.' : (r.ok ? 'Test message dispatched.' : 'Failed: ' + (r.error || 'unknown error')));
  } catch (e) { flash(req, 'danger', e.message); }
  res.redirect('/settings/msg91');
});

// ---------- Access Control / Roles overview (editable matrix) ----------
const FEATURES = [
  { key: 'dashboard',     label: 'Dashboard' },
  { key: 'products',      label: 'Products / Categories' },
  { key: 'materials',     label: 'Raw Materials / Suppliers' },
  { key: 'bom',           label: 'BOM (per product)' },
  { key: 'production',    label: 'Production Batches & Stages' },
  { key: 'fabric_costs',  label: 'Fabric Cost / Mfg Expenses' },
  { key: 'stock',         label: 'Ready Stock & Movements' },
  { key: 'dealers',       label: 'Dealers' },
  { key: 'sales',         label: 'Sales Orders / Invoices' },
  { key: 'payments',      label: 'Payments' },
  { key: 'dispatch',      label: 'Dispatch & Returns' },
  { key: 'reports',       label: 'Reports' },
  { key: 'notifications', label: 'Notifications (SMS/WhatsApp)' },
  { key: 'settings',      label: 'Users / Settings / Import' },
  { key: 'purchasing',    label: 'Purchasing & Vendor Prices' },
];
const ROLES = ['owner', 'admin', 'accountant', 'salesperson', 'production', 'store', 'purchaser'];
const LEVELS = ['none', 'view', 'limited', 'full'];

router.get('/access', (req, res) => {
  const users = db.prepare('SELECT id,name,email,phone,role,active FROM users ORDER BY role, name').all();
  const rows = db.prepare('SELECT role, feature_key, level FROM role_permissions').all();
  // Build a lookup: matrix[role][feature_key] = level
  const matrix = {};
  ROLES.forEach(r => { matrix[r] = {}; });
  rows.forEach(r => { if (matrix[r.role]) matrix[r.role][r.feature_key] = r.level; });
  res.render('settings/access', { title: 'User Access & Roles', users, matrix, features: FEATURES, roles: ROLES, levels: LEVELS });
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
