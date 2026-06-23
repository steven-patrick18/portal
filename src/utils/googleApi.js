// Google API client for the Website Insights dashboard.
//
// Talks to the Search Console API (search rankings / queries) and the
// GA4 Data API (visitors) using a Google *service account*. Auth is a
// hand-rolled RS256 JWT signed with Node's built-in crypto + global
// fetch — no googleapis / google-auth-library dependency.
//
// Config is read from app_settings (set on the Insights page):
//   GOOGLE_SA_JSON   – the service-account key JSON (client_email + private_key)
//   GSC_SITE_URL     – e.g. "https://sharvexports.com/" or "sc-domain:sharvexports.com"
//   GA4_PROPERTY_ID  – the numeric GA4 property id (Admin → Property settings)
//   GA4_MEASUREMENT_ID – the public tag id "G-XXXXXXX" (injected on the site)
const crypto = require('crypto');
const { db } = require('../db');

function setting(key) {
  const r = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  return r ? r.value : '';
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const GA_SCOPE  = 'https://www.googleapis.com/auth/analytics.readonly';

const tokenCache = {};   // scope -> { token, exp }

async function getAccessToken(scope) {
  const now = Math.floor(Date.now() / 1000);
  const cached = tokenCache[scope];
  if (cached && cached.exp - 60 > now) return cached.token;

  const raw = setting('GOOGLE_SA_JSON');
  if (!raw) throw new Error('Google service account not configured');
  let sa;
  try { sa = JSON.parse(raw); } catch (_) { throw new Error('Service-account JSON is not valid JSON'); }
  if (!sa.client_email || !sa.private_key) throw new Error('Service-account JSON is missing client_email / private_key');

  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const signingInput = enc({ alg: 'RS256', typ: 'JWT' }) + '.' +
    enc({ iss: sa.client_email, scope, aud: TOKEN_URL, iat: now, exp: now + 3600 });
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(sa.private_key).toString('base64url');
  const jwt = signingInput + '.' + signature;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error('Auth failed: ' + (j.error_description || j.error || ('HTTP ' + res.status)));
  tokenCache[scope] = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return j.access_token;
}

function ymd(d) { return d.toISOString().slice(0, 10); }

// ── Search Console ────────────────────────────────────────────
async function gscQuery(body) {
  const site = setting('GSC_SITE_URL');
  if (!site) throw new Error('Search Console site URL not set');
  const token = await getAccessToken(GSC_SCOPE);
  const url = 'https://searchconsole.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(site) + '/searchAnalytics/query';
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Search Console: ' + ((j.error && j.error.message) || ('HTTP ' + res.status)));
  return j.rows || [];
}

async function searchConsole(days) {
  // Search Console data lags ~2 days; window back from there.
  const end = new Date(Date.now() - 2 * 864e5);
  const start = new Date(end.getTime() - (days - 1) * 864e5);
  const range = { startDate: ymd(start), endDate: ymd(end) };
  const [totalsRows, queries, pages] = await Promise.all([
    gscQuery({ ...range, dimensions: [], rowLimit: 1 }),
    gscQuery({ ...range, dimensions: ['query'], rowLimit: 15 }),
    gscQuery({ ...range, dimensions: ['page'], rowLimit: 10 }),
  ]);
  const t = totalsRows[0] || {};
  return {
    range,
    totals: { clicks: t.clicks || 0, impressions: t.impressions || 0, ctr: t.ctr || 0, position: t.position || 0 },
    queries: queries.map((r) => ({ key: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })),
    pages: pages.map((r) => ({ key: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })),
  };
}

// ── GA4 Data API ──────────────────────────────────────────────
async function ga4Report(body) {
  const pid = setting('GA4_PROPERTY_ID');
  if (!pid) throw new Error('GA4 property ID not set');
  const token = await getAccessToken(GA_SCOPE);
  const url = 'https://analyticsdata.googleapis.com/v1beta/properties/' + encodeURIComponent(pid.replace(/\D/g, '')) + ':runReport';
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Analytics: ' + ((j.error && j.error.message) || ('HTTP ' + res.status)));
  return j;
}

function gaRows(report, metricCount) {
  return (report.rows || []).map((r) => {
    const dims = (r.dimensionValues || []).map((d) => d.value);
    const mets = (r.metricValues || []).map((m) => Number(m.value || 0));
    return { dims, mets: mets.slice(0, metricCount || mets.length) };
  });
}

async function analytics(days) {
  const dateRanges = [{ startDate: days + 'daysAgo', endDate: 'today' }];
  const [summary, byCountry, byPage, byChannel] = await Promise.all([
    ga4Report({ dateRanges, metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'screenPageViews' }, { name: 'averageSessionDuration' }] }),
    ga4Report({ dateRanges, dimensions: [{ name: 'country' }], metrics: [{ name: 'activeUsers' }], orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }], limit: 8 }),
    ga4Report({ dateRanges, dimensions: [{ name: 'pagePath' }], metrics: [{ name: 'screenPageViews' }], orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }], limit: 10 }),
    ga4Report({ dateRanges, dimensions: [{ name: 'sessionDefaultChannelGroup' }], metrics: [{ name: 'sessions' }], orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 8 }),
  ]);
  const s = gaRows(summary, 4)[0] || { mets: [0, 0, 0, 0] };
  return {
    totals: { users: s.mets[0], sessions: s.mets[1], views: s.mets[2], avgDuration: s.mets[3] },
    countries: gaRows(byCountry).map((r) => ({ key: r.dims[0], value: r.mets[0] })),
    pages: gaRows(byPage).map((r) => ({ key: r.dims[0], value: r.mets[0] })),
    channels: gaRows(byChannel).map((r) => ({ key: r.dims[0], value: r.mets[0] })),
  };
}

// ── Aggregator (cached) ───────────────────────────────────────
let insightsCache = null;   // { at, days, data }
const CACHE_MS = 30 * 60 * 1000;

function isConfigured() { return !!setting('GOOGLE_SA_JSON'); }

async function getInsights({ days = 28, force = false } = {}) {
  if (!force && insightsCache && insightsCache.days === days && Date.now() - insightsCache.at < CACHE_MS) {
    return insightsCache.data;
  }
  const out = {
    configured: isConfigured(),
    hasGSC: !!setting('GSC_SITE_URL'),
    hasGA4: !!setting('GA4_PROPERTY_ID'),
    days, gsc: null, ga4: null, errors: [], fetchedAt: new Date().toISOString(),
  };
  if (out.configured && out.hasGSC) {
    try { out.gsc = await searchConsole(days); } catch (e) { out.errors.push('Search Console — ' + e.message); }
  }
  if (out.configured && out.hasGA4) {
    try { out.ga4 = await analytics(days); } catch (e) { out.errors.push('Analytics — ' + e.message); }
  }
  insightsCache = { at: Date.now(), days, data: out };
  return out;
}

function clearCache() { insightsCache = null; }

module.exports = { getInsights, isConfigured, clearCache, setting };
