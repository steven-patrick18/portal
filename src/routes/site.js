// Public marketing website (sharvexport.com).
// No authentication — open to the world. Renders the standalone premium
// home page from the site_content / site_products / site_certifications
// tables only. Does NOT read or expose any ERP business data.
const express = require('express');
const { db } = require('../db');
const router = express.Router();

function safeJson(s, fallback) {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : fallback; } catch (_) { return fallback; }
}

function renderHome(req, res, extra) {
  const c = db.prepare('SELECT * FROM site_content WHERE id=1').get() || {};
  const products = db.prepare('SELECT * FROM site_products WHERE active=1 ORDER BY sort, id').all();
  const certs = db.prepare('SELECT * FROM site_certifications WHERE active=1 ORDER BY sort, id').all();
  const instagram = db.prepare('SELECT * FROM site_instagram WHERE active=1 ORDER BY sort, id').all();
  const stats   = safeJson(c.stats_json, []);
  const why     = safeJson(c.why_json, []);
  const process = safeJson(c.process_json, []);
  const logoRow = db.prepare("SELECT value FROM app_settings WHERE key='COMPANY_LOGO'").get();
  const logo = logoRow ? logoRow.value : '';
  res.render('site/home', Object.assign({
    layout: false, c, products, certs, instagram, stats, why, process, logo,
    sent: false, formError: null,
    baseUrl: (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host'),
  }, extra || {}));
}

router.get('/', (req, res) => renderHome(req, res, { sent: req.query.sent === '1' }));

// Public buyer enquiry — no auth. Honeypot + light validation; lands in
// the site_enquiries inbox (Website module → Enquiries).
router.post('/enquiry', (req, res) => {
  const f = req.body || {};
  // Honeypot: bots fill the hidden "website" field; humans never see it.
  if (f.website && f.website.trim()) return res.redirect('/site?sent=1');
  const name = (f.name || '').trim();
  const phone = (f.phone || '').trim();
  const email = (f.email || '').trim();
  const message = (f.message || '').trim();
  if (!name || (!phone && !email)) {
    return renderHome(req, res, { formError: 'Please enter your name and a phone or email so we can reach you.' });
  }
  db.prepare(`INSERT INTO site_enquiries (name, company, phone, email, product_interest, message, ip)
              VALUES (?,?,?,?,?,?,?)`)
    .run(name, (f.company||'').trim()||null, phone||null, email||null,
         (f.product_interest||'').trim()||null, message||null, req.ip);
  res.redirect('/site?sent=1#contact');
});

module.exports = router;
