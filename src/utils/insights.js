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

// ── Evergreen blog ideas (always-on, no Google data needed) ────
// A curated bank of denim / garment B2B topics with buyer intent. Shown in
// the Blog tab so there is always something worth writing — the data-driven
// blogSuggestions() (above) augments this once Search Console has traffic.
const SEED_TOPICS = [
  { title: 'Denim Jeans Manufacturing Process: From Fabric to Finish', meta: 'A step-by-step look at how jeans are made — cutting, stitching, washing and finishing — in a modern denim factory.' },
  { title: 'What is Denim Washing? Stone, Enzyme, Acid & Ozone Washes Explained', meta: 'A simple guide to the main denim wash types, how each one looks, and which suits your brand.' },
  { title: 'Minimum Order Quantity (MOQ) for Custom Jeans: A Buyer’s Guide', meta: 'How MOQs work for bulk jeans, why they exist, and how to plan your first wholesale order.' },
  { title: 'Private Label vs White Label Jeans: Which is Right for Your Brand?', meta: 'The difference between private and white label denim, with pros, cons and costs for new brands.' },
  { title: 'How to Start Your Own Jeans Brand in India', meta: 'A practical roadmap to launching a denim label — sourcing, manufacturing, branding and budgets.' },
  { title: 'Understanding Denim Fabric: Ounces, Stretch and Weaves', meta: 'Decode denim fabric weight, stretch and weave so you order the right cloth for your jeans.' },
  { title: 'Sustainable Denim: Water-Saving Wash Technology Explained', meta: 'How laser, ozone and eco-wash cut water and chemicals in denim finishing — and why buyers care.' },
  { title: 'Quality Control in Denim Manufacturing: What Buyers Should Check', meta: 'The QC checkpoints — stitching, shrinkage, wash consistency — that protect your bulk jeans order.' },
  { title: 'How to Source Garments from India: A Step-by-Step Exporter Guide', meta: 'Everything an overseas buyer needs to source clothing from India — from sampling to shipping.' },
  { title: 'Cost Breakdown of a Pair of Jeans: What You’re Really Paying For', meta: 'Fabric, trims, labour, washing and margin — where the money goes in a pair of wholesale jeans.' },
  { title: 'Wholesale Jeans Pricing: How Bulk Orders Lower Your Cost', meta: 'How order volume, fabric choice and wash affect wholesale jeans pricing for retailers.' },
  { title: 'Top Denim Trends: Washes, Fits and Details Buyers Want', meta: 'The denim washes, fits and finishing details driving demand this season.' },
];
function blogIdeas(limit = 6) {
  let corpus = [];
  try {
    corpus = db.prepare('SELECT title, slug FROM site_posts').all()
      .map(p => (p.title + ' ' + (p.slug || '')).toLowerCase().replace(/-/g, ' '));
  } catch (_) { corpus = []; }
  const stop = new Set(['the','a','an','to','of','in','for','and','or','your','from','what','how','is','are','vs','you','with','own']);
  const out = [];
  for (const t of SEED_TOPICS) {
    const tokens = t.title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter(w => w.length >= 3 && !stop.has(w));
    // Skip topics already broadly covered by an existing post.
    const covered = tokens.length && corpus.some(c => {
      const hit = tokens.filter(tok => c.includes(tok)).length;
      return hit >= Math.ceil(tokens.length * 0.6);
    });
    if (!covered) out.push(t);
    if (out.length >= limit) break;
  }
  return out;
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

module.exports = { goalProgress, blogSuggestions, blogIdeas, alerts, logEvent, recentEvents };
