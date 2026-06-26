// Image optimisation: shrink + compress uploaded images so product (and all
// other) pages load fast. Two entry points:
//   optimizeFile(absPath)        — called after each upload (resize on save)
//   optimizeAllOnce()            — one-time background pass over public/uploads
//                                  to compress images already on disk
// Safe: never enlarges, preserves format (PNG transparency kept), and only
// writes back when the result is actually smaller than the original.
const fs = require('fs');
const path = require('path');
let sharp = null; try { sharp = require('sharp'); } catch (_) { /* optional */ }

const UPLOADS_ROOT = path.join(__dirname, '..', '..', 'public', 'uploads');
const EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

async function optimizeFile(absPath, opts) {
  if (!sharp) return 0;
  const o = opts || {};
  const maxDim = o.maxDim || 1400;
  const quality = o.quality || 78;
  const ext = path.extname(absPath).toLowerCase();
  if (!EXTS.has(ext)) return 0;
  let orig;
  try { orig = fs.readFileSync(absPath); } catch (_) { return 0; }
  try {
    let img = sharp(orig, { failOn: 'none' }).rotate()  // auto-orient phone photos
      .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true });
    if (ext === '.png') img = img.png({ compressionLevel: 9, palette: true });
    else if (ext === '.webp') img = img.webp({ quality });
    else img = img.jpeg({ quality, mozjpeg: true });
    const out = await img.toBuffer();
    if (out.length && out.length < orig.length) { fs.writeFileSync(absPath, out); return orig.length - out.length; }
    return 0; // already optimal — leave as-is
  } catch (_) { return 0; }
}

function listImagesRecursive(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listImagesRecursive(p));
    else if (EXTS.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

// One-time pass over every already-uploaded image. Guarded by an app_settings
// flag so it runs once (after deploy). Runs in the background — non-blocking.
async function optimizeAllOnce() {
  if (!sharp) return;
  let db;
  try { db = require('../db').db; } catch (_) { return; }
  try { if (db.prepare("SELECT 1 FROM app_settings WHERE key='IMG_OPT_V1'").get()) return; } catch (_) { return; }
  const files = listImagesRecursive(UPLOADS_ROOT);
  let saved = 0, done = 0;
  for (const f of files) {
    saved += await optimizeFile(f, { maxDim: 1600, quality: 80 });
    done++;
    await new Promise(r => setTimeout(r, 15)); // gentle — don't hog CPU
  }
  try { db.prepare("INSERT INTO app_settings (key,value) VALUES ('IMG_OPT_V1','1') ON CONFLICT(key) DO UPDATE SET value='1'").run(); } catch (_) {}
  console.log(`[img-opt] optimised ${done} existing image(s), saved ~${Math.round(saved / 1024)} KB`);
}

module.exports = { optimizeFile, optimizeAllOnce };
