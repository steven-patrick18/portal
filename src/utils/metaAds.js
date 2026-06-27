// Meta (Facebook/Instagram) Ads — READ-ONLY performance puller.
// Fetches spend / reach / clicks / leads from the Marketing API for the
// configured ad account, so the owner sees ad results inside the portal.
// We never create, edit or pay for ads here — that stays in Business Suite.
//
// Config (app_settings):
//   META_AD_ACCOUNT_ID  numeric ad-account id (the number after "act_")
//   META_ADS_TOKEN      a System-User access token with `ads_read`
const { db } = require('../db');

const GRAPH = 'https://graph.facebook.com/v21.0/';
let cache = null;                 // { key, at, data }
const TTL = 15 * 60 * 1000;       // 15 min — ad numbers don't move second-to-second

function setting(k) { const r = db.prepare('SELECT value FROM app_settings WHERE key=?').get(k); return r ? r.value : ''; }
function accountId() { return (setting('META_AD_ACCOUNT_ID') || '').replace(/\D/g, ''); }
function token() { return (setting('META_ADS_TOKEN') || '').trim(); }
function isConfigured() { return !!(accountId() && token()); }

async function api(path, params) {
  const q = new URLSearchParams(Object.assign({ access_token: token() }, params));
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(GRAPH + path + '?' + q.toString(), { signal: ctrl.signal });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.error) {
      const m = (j.error && j.error.message) || ('HTTP ' + res.status);
      throw new Error(m);
    }
    return j;
  } finally { clearTimeout(t); }
}

// Sum the values of the given action types out of an insights "actions" array.
function actionVal(actions, types) {
  if (!Array.isArray(actions)) return 0;
  return actions.filter(a => types.includes(a.action_type)).reduce((s, a) => s + Number(a.value || 0), 0);
}
const LEADS = ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'];
const MSG   = ['onsite_conversion.messaging_conversation_started_7d', 'onsite_conversion.total_messaging_connection'];
const LINKS = ['link_click'];

function ymd(d) { return d.toISOString().slice(0, 10); }

// days: 7 | 28 | 90. force:true skips the cache.
async function getInsights({ days = 28, force = false } = {}) {
  if (!isConfigured()) return { configured: false };
  const key = days;
  if (!force && cache && cache.key === key && Date.now() - cache.at < TTL) return cache.data;

  const acct = 'act_' + accountId();
  const until = new Date(), since = new Date();
  since.setDate(since.getDate() - (days - 1));
  const time_range = JSON.stringify({ since: ymd(since), until: ymd(until) });

  try {
    const info = await api(acct, { fields: 'name,currency' });
    const tot = await api(acct + '/insights', { level: 'account', time_range, fields: 'spend,impressions,reach,clicks,ctr,cpc,cpm,actions' });
    const camp = await api(acct + '/insights', { level: 'campaign', time_range, limit: '25', fields: 'campaign_name,spend,impressions,reach,clicks,ctr,actions' });
    const row = (tot.data && tot.data[0]) || {};
    const totals = {
      spend: Number(row.spend || 0), impressions: Number(row.impressions || 0), reach: Number(row.reach || 0),
      clicks: Number(row.clicks || 0), ctr: Number(row.ctr || 0), cpc: Number(row.cpc || 0), cpm: Number(row.cpm || 0),
      leads: actionVal(row.actions, LEADS), messaging: actionVal(row.actions, MSG), linkClicks: actionVal(row.actions, LINKS),
    };
    const campaigns = (camp.data || []).map(c => ({
      name: c.campaign_name, spend: Number(c.spend || 0), reach: Number(c.reach || 0),
      clicks: Number(c.clicks || 0), ctr: Number(c.ctr || 0),
      leads: actionVal(c.actions, LEADS), messaging: actionVal(c.actions, MSG),
    })).sort((a, b) => b.spend - a.spend);

    const data = { configured: true, account: info.name || acct, currency: info.currency || 'INR', days, totals, campaigns, fetchedAt: new Date().toISOString() };
    cache = { key, at: Date.now(), data };
    return data;
  } catch (e) {
    return { configured: true, error: e.message, days };
  }
}

module.exports = { isConfigured, getInsights };
