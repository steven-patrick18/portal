// Google PageSpeed Insights (Lighthouse) for the homepage — performance
// score + Core Web Vitals, mobile & desktop. The PSI API is free and needs
// no key for low volume. Calls are slow (10-20s) so we only run on demand
// (a button) and cache the result for 6 hours.
const { siteOrigin } = require('./seoAudit');
const { db } = require('../db');

function setting(k) { const r = db.prepare('SELECT value FROM app_settings WHERE key=?').get(k); return r ? r.value : ''; }

const PSI = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
let cache = null;                 // { at, url, data }
const TTL = 6 * 60 * 60 * 1000;

async function strategy(url, strat) {
  const q = new URLSearchParams({ url, strategy: strat, category: 'performance' });
  const key = (setting('PAGESPEED_API_KEY') || '').trim();
  if (key) q.set('key', key);     // without a key the anonymous quota is ~zero
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(PSI + '?' + q.toString(), { signal: ctrl.signal });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (j.error && j.error.message) || ('HTTP ' + res.status);
      if (/quota/i.test(msg)) return { error: 'Google PageSpeed daily limit reached. Add a free PageSpeed API key in Connection settings (one-time) to enable speed checks.' };
      return { error: msg };
    }
    const lh = j.lighthouseResult || {};
    const a = lh.audits || {};
    const score = lh.categories && lh.categories.performance ? Math.round(lh.categories.performance.score * 100) : null;
    const dv = (k) => (a[k] && a[k].displayValue) || '—';
    return { score, lcp: dv('largest-contentful-paint'), cls: dv('cumulative-layout-shift'), tbt: dv('total-blocking-time'), fcp: dv('first-contentful-paint'), si: dv('speed-index') };
  } catch (e) {
    return { error: e.message };
  } finally { clearTimeout(t); }
}

// run:true forces a fresh check; otherwise returns the cached result (or null
// if never run, so the page can show a "Check speed" prompt).
async function get({ run } = {}) {
  const url = siteOrigin() + '/';
  // run=true (the "Check speed" button) always re-fetches so a failed check
  // can be retried after adding a key; otherwise serve the cached result.
  if (!run && cache && cache.url === url && Date.now() - cache.at < TTL) return cache.data;
  if (!run) return null;
  const [mobile, desktop] = await Promise.all([strategy(url, 'mobile'), strategy(url, 'desktop')]);
  const data = { fetchedAt: new Date().toISOString(), url, mobile, desktop };
  cache = { at: Date.now(), url, data };
  return data;
}

module.exports = { get };
