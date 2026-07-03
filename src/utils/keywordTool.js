// Keyword Ideas — real Google autocomplete suggestions (what people actually
// type). Uses Google's public Suggest endpoint (client=firefox → clean JSON),
// localised to India (gl=in). Free, no API key. Expands a seed with a-z to
// surface a big pool of long-tail keywords, like a keyword tool. Fail-soft.
const cache = new Map();          // key -> { at, list }
const TTL = 24 * 3600 * 1000;     // 1 day

async function fetchSuggest(q) {
  const url = 'https://suggestqueries.google.com/complete/search?client=firefox&hl=en&gl=in&q=' + encodeURIComponent(q);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SharvERP/1.0)' } });
    const txt = await r.text();
    const arr = JSON.parse(txt);
    return (Array.isArray(arr) && Array.isArray(arr[1])) ? arr[1] : [];
  } catch (_) { return []; }
  finally { clearTimeout(t); }
}

// Run promises in small concurrent batches to stay fast + polite.
async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  }
  return out;
}

// Ideas for a seed. expand=true also queries "<seed> a"…"<seed> z" for long-tails.
async function ideas(seed, { expand = true } = {}) {
  seed = String(seed || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!seed) return [];
  const ck = seed + (expand ? '*' : '');
  const c = cache.get(ck);
  if (c && Date.now() - c.at < TTL) return c.list;

  const queries = [seed];
  if (expand) 'abcdefghijklmnopqrstuvwxyz'.split('').forEach(ch => queries.push(seed + ' ' + ch));
  const results = await inBatches(queries, 6, fetchSuggest);

  const seen = new Set(); const out = [];
  for (const list of results) for (const s of list) {
    const k = String(s).toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(s); }
  }
  const list = out.slice(0, 300);
  cache.set(ck, { at: Date.now(), list });
  return list;
}

module.exports = { ideas, fetchSuggest };
