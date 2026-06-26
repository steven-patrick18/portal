// Keyword rank tracking (#7). A daily snapshot of the top Search Console
// queries' average positions is stored in seo_rank_history, so we can chart
// whether rankings improve over time. History builds going forward.
const { db } = require('../db');
const googleApi = require('./googleApi');

function pad(n) { return String(n).padStart(2, '0'); }
function today() { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

async function snapshot() {
  if (!googleApi.isConfigured() || !googleApi.setting('GSC_SITE_URL')) return { ok: false, reason: 'GSC not configured' };
  const data = await googleApi.getInsights({ days: 7 });
  if (!data.gsc || !data.gsc.queries || !data.gsc.queries.length) return { ok: false, reason: 'no query data' };
  const day = today();
  const ins = db.prepare(`INSERT INTO seo_rank_history (day,query,position,clicks,impressions) VALUES (?,?,?,?,?)
    ON CONFLICT(day,query) DO UPDATE SET position=excluded.position, clicks=excluded.clicks, impressions=excluded.impressions`);
  let n = 0;
  for (const q of data.gsc.queries.slice(0, 30)) { ins.run(day, q.key, q.position, q.clicks, q.impressions); n++; }
  return { ok: true, day, n };
}

function history() {
  let byDay = [], top = [];
  try {
    byDay = db.prepare(`SELECT day, ROUND(AVG(position),1) AS pos, SUM(clicks) AS clicks, COUNT(*) AS queries
                        FROM seo_rank_history GROUP BY day ORDER BY day`).all();
    top = db.prepare(`SELECT query, SUM(impressions) AS impressions, COUNT(*) AS days,
        (SELECT position FROM seo_rank_history a WHERE a.query=h.query ORDER BY day ASC  LIMIT 1) AS firstPos,
        (SELECT position FROM seo_rank_history b WHERE b.query=h.query ORDER BY day DESC LIMIT 1) AS lastPos
      FROM seo_rank_history h GROUP BY query ORDER BY impressions DESC LIMIT 8`).all();
  } catch (_) { /* table may not exist yet */ }
  return { byDay, top, hasData: byDay.length > 0 };
}

module.exports = { snapshot, history };
