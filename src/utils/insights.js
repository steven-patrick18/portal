// Derived insights computed from the Google data + the portal's own tables:
// monthly goal progress, content-gap blog suggestions, and alert banners.
const { db } = require('../db');

function setting(key, fb) {
  const r = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  return (r && r.value != null && r.value !== '') ? r.value : fb;
}
function firstOfMonth() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01';
}

// ── Monthly goal tracker (#2) ──────────────────────────────────
function goalProgress(data) {
  const vTarget = parseInt(setting('GOAL_VISITORS_MONTH', '0')) || 0;
  const eTarget = parseInt(setting('GOAL_ENQUIRIES_MONTH', '0')) || 0;
  if (!vTarget && !eTarget) return null;
  const visitors = (data && data.ga4 && data.ga4.monthUsers) || 0;
  const enquiries = db.prepare("SELECT COUNT(*) AS n FROM site_enquiries WHERE created_at >= ?").get(firstOfMonth()).n;
  const pct = (cur, tgt) => tgt > 0 ? Math.min(100, Math.round((cur / tgt) * 100)) : null;
  return {
    visitors: { target: vTarget, current: visitors, pct: pct(visitors, vTarget) },
    enquiries: { target: eTarget, current: enquiries, pct: pct(enquiries, eTarget) },
  };
}

// ── Blog-topic suggestions (#9) ────────────────────────────────
// Search terms that bring impressions but have no page targeting them.
function blogSuggestions(gsc) {
  if (!gsc || !gsc.queries || !gsc.queries.length) return [];
  const brand = String(setting('COMPANY_NAME', 'Sharv Enterprises')).toLowerCase().split(/\s+/);
  const posts = db.prepare("SELECT title, slug FROM site_posts WHERE status='published'").all();
  const corpus = posts.map(p => (p.title + ' ' + p.slug).toLowerCase().replace(/-/g, ' '));
  const out = [];
  const seen = new Set();
  for (const q of gsc.queries) {
    const phrase = String(q.key || '').toLowerCase();
    if (q.impressions < 3) continue;
    const tokens = phrase.split(/\s+/).filter(w => w.length >= 3 && !brand.includes(w));
    if (!tokens.length) continue;                 // pure brand query — already covered
    const covered = corpus.some(c => c.includes(phrase) || tokens.filter(t => c.includes(t)).length >= Math.ceil(tokens.length / 2));
    if (covered || seen.has(phrase)) continue;
    seen.add(phrase);
    out.push({ query: q.key, impressions: q.impressions, position: q.position });
  }
  return out.sort((a, b) => b.impressions - a.impressions).slice(0, 6);
}

// ── Alerts (#11) ───────────────────────────────────────────────
// Compares this period vs the previous one and watches the SEO score.
function alerts(data, audit) {
  const out = [];
  const ga = data && data.ga4, gs = data && data.gsc;
  if (ga && ga.prev && ga.prev.users >= 5 && ga.totals.users < ga.prev.users * 0.6) {
    const drop = Math.round((1 - ga.totals.users / ga.prev.users) * 100);
    out.push({ level: 'warning', msg: `Visitors fell ${drop}% vs the previous period (${ga.prev.users} → ${ga.totals.users}). Check if a page dropped or a campaign ended.` });
  }
  if (gs && gs.prev && gs.prev.clicks >= 5 && gs.totals.clicks < gs.prev.clicks * 0.6) {
    const drop = Math.round((1 - gs.totals.clicks / gs.prev.clicks) * 100);
    out.push({ level: 'warning', msg: `Google clicks fell ${drop}% vs the previous period.` });
  }
  if (gs && gs.prev && gs.prev.position > 0 && gs.totals.position > gs.prev.position + 1.5) {
    out.push({ level: 'warning', msg: `Average Google rank slipped from ${gs.prev.position.toFixed(1)} to ${gs.totals.position.toFixed(1)} (higher = worse).` });
  }
  // SEO score decline (persist last score, alert only on a drop).
  if (audit && audit.score != null) {
    const last = parseInt(setting('SEO_LAST_SCORE', '')) ;
    if (!Number.isNaN(last) && audit.score < last - 2) {
      out.push({ level: 'danger', msg: `SEO score dropped from ${last} to ${audit.score} — something on the site changed. Re-run the SEO check below.` });
    }
    db.prepare(`INSERT INTO app_settings (key,value) VALUES ('SEO_LAST_SCORE',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(audit.score));
  }
  return out;
}

// ── "What changed" timeline (#3) ───────────────────────────────
function logEvent(type, label) {
  try { db.prepare('INSERT INTO site_events (type,label) VALUES (?,?)').run(type, label || null); } catch (_) { /* table may not exist yet */ }
}
function recentEvents(limit) {
  try { return db.prepare('SELECT at, type, label FROM site_events ORDER BY id DESC LIMIT ?').all(limit || 12); } catch (_) { return []; }
}

module.exports = { goalProgress, blogSuggestions, alerts, logEvent, recentEvents };
