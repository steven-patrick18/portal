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

router.get('/', (req, res) => {
  const c = db.prepare('SELECT * FROM site_content WHERE id=1').get() || {};
  const products = db.prepare('SELECT * FROM site_products WHERE active=1 ORDER BY sort, id').all();
  const certs = db.prepare('SELECT * FROM site_certifications WHERE active=1 ORDER BY sort, id').all();
  const stats   = safeJson(c.stats_json, []);
  const why     = safeJson(c.why_json, []);
  const process = safeJson(c.process_json, []);
  // Brand logo (reuse the company logo configured in Settings).
  const logoRow = db.prepare("SELECT value FROM app_settings WHERE key='COMPANY_LOGO'").get();
  const logo = logoRow ? logoRow.value : '';
  res.render('site/home', {
    layout: false, c, products, certs, stats, why, process, logo,
    // absolute base for canonical/OG — host header so it works on any domain
    baseUrl: (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host'),
  });
});

module.exports = router;
