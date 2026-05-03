// Catalogue generation pipeline.
//
// Orchestrates the per-item flow:
//   1. Background-remove the front photo (1 fal call)
//   2. For each active template, virtual-try-on (cutout × template)
//   3. Watermark every output with the company logo (local sharp)
//   4. Save assets + costs to DB; update job status
//
// Runs as a background task (kicked off via setImmediate from the route)
// so the HTTP request returns immediately and the UI polls progress.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { db } = require('../db');
const falai = require('./falai');

const UPLOADS_ROOT = path.join(__dirname, '..', '..', 'public', 'uploads', 'catalogue');

function getSetting(key, fallback = '') {
  const r = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  return r ? r.value : fallback;
}

function spendThisMonth() {
  const r = db.prepare(`SELECT COALESCE(SUM(cost_inr),0) AS n FROM ai_usage_log WHERE created_at >= strftime('%Y-%m-01','now')`).get();
  return r.n;
}

// Compose: paste the company logo onto the bottom-right of an image with
// modest opacity so it doesn't dominate. Returns the watermarked buffer.
async function watermark(imagePath, logoPath) {
  const base = sharp(imagePath);
  const meta = await base.metadata();
  if (!fs.existsSync(logoPath)) {
    // No logo configured — return the original unchanged.
    return base.toBuffer();
  }
  // Logo sized to ~14% of image width, semi-transparent.
  const logoWidth = Math.round((meta.width || 1024) * 0.14);
  const logo = await sharp(logoPath)
    .resize({ width: logoWidth })
    .composite([{
      input: Buffer.from([255, 255, 255, 178]), raw: { width: 1, height: 1, channels: 4 }, tile: true, blend: 'dest-in',
    }])
    .png()
    .toBuffer();
  const margin = Math.round((meta.width || 1024) * 0.025);
  return base
    .composite([{ input: logo, gravity: 'southeast', top: undefined, left: undefined, blend: 'over' }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

// Resolve the company logo path from app_settings.COMPANY_LOGO. Returns
// an absolute path or null when no logo is configured.
function resolveLogoPath() {
  const rel = getSetting('COMPANY_LOGO', '');
  if (!rel) return null;
  return path.join(__dirname, '..', '..', 'public', rel.replace(/^\//, ''));
}

// The actual long-running work. Updates catalogue_jobs row as it goes
// so the UI poll can show progress.
async function runJob(jobId) {
  const apiKey = getSetting('FAL_API_KEY', '');
  const provider = getSetting('AI_PROVIDER', 'off');
  const job = db.prepare('SELECT * FROM catalogue_jobs WHERE id=?').get(jobId);
  if (!job) return;
  const item = db.prepare('SELECT * FROM catalogue_items WHERE id=?').get(job.item_id);
  if (!item) {
    db.prepare("UPDATE catalogue_jobs SET status='failed', error='item not found', finished_at=datetime('now') WHERE id=?").run(jobId);
    return;
  }
  if (provider !== 'fal' || !apiKey) {
    db.prepare("UPDATE catalogue_jobs SET status='failed', error='AI provider not configured', finished_at=datetime('now') WHERE id=?").run(jobId);
    db.prepare("UPDATE catalogue_items SET status='failed' WHERE id=?").run(item.id);
    return;
  }

  // Budget check (per-item AND monthly) before spending anything.
  const perItemCap = parseFloat(getSetting('AI_BUDGET_PER_ITEM_INR', '40')) || 40;
  const monthlyCap = parseFloat(getSetting('AI_BUDGET_MONTHLY_INR', '2000')) || 2000;
  const monthSpend = spendThisMonth();
  if (monthSpend >= monthlyCap) {
    db.prepare("UPDATE catalogue_jobs SET status='failed', error=?, finished_at=datetime('now') WHERE id=?")
      .run(`Monthly cap of ₹${monthlyCap} reached (₹${monthSpend.toFixed(2)} spent). Increase from Settings → AI Catalogue.`, jobId);
    db.prepare("UPDATE catalogue_items SET status='failed' WHERE id=?").run(item.id);
    return;
  }

  // Templates the user has flagged active. Optional gender filter from
  // the job options (set by the show-page picker). 'all' or unset = no
  // filter; 'female' / 'male' restricts to that gender + any 'unisex'
  // templates the owner uploaded manually.
  const filter = job.options ? (() => { try { return JSON.parse(job.options); } catch { return {}; } })() : {};
  let templates;
  if (filter.gender && filter.gender !== 'all') {
    templates = db.prepare(
      'SELECT * FROM catalogue_templates WHERE active=1 AND (gender=? OR gender=\'unisex\') ORDER BY sort_order, id'
    ).all(filter.gender);
  } else {
    templates = db.prepare('SELECT * FROM catalogue_templates WHERE active=1 ORDER BY sort_order, id').all();
  }
  if (templates.length === 0) {
    const reason = filter.gender && filter.gender !== 'all'
      ? `No active templates for gender "${filter.gender}". Open Model Templates and either upload one or click "Generate AI Defaults".`
      : 'No active templates. Open Model Templates and either upload one or click "Generate AI Defaults".';
    db.prepare("UPDATE catalogue_jobs SET status='failed', error=?, finished_at=datetime('now') WHERE id=?").run(reason, jobId);
    db.prepare("UPDATE catalogue_items SET status='failed' WHERE id=?").run(item.id);
    return;
  }

  const totalSteps = 1 + templates.length; // bg-remove + N try-on
  db.prepare("UPDATE catalogue_jobs SET status='running', total_steps=? WHERE id=?").run(totalSteps, jobId);
  db.prepare("UPDATE catalogue_items SET status='generating' WHERE id=?").run(item.id);

  const itemDir = path.join(UPLOADS_ROOT, String(item.id));
  if (!fs.existsSync(itemDir)) fs.mkdirSync(itemDir, { recursive: true });
  const logoPath = resolveLogoPath();

  // Step 1: upload front photo to fal storage, then BG-remove it.
  let costUsd = 0;
  let costInr = 0;
  const frontAsset = db.prepare("SELECT * FROM catalogue_assets WHERE item_id=? AND kind='original_front'").get(item.id);
  if (!frontAsset) {
    db.prepare("UPDATE catalogue_jobs SET status='failed', error='No front photo uploaded for this item.', finished_at=datetime('now') WHERE id=?").run(jobId);
    db.prepare("UPDATE catalogue_items SET status='failed' WHERE id=?").run(item.id);
    return;
  }
  const frontLocalPath = path.join(__dirname, '..', '..', 'public', frontAsset.file_path.replace(/^\//, ''));

  let frontUrl, cutoutUrl;
  try {
    frontUrl = await falai.uploadFile({ apiKey, filePath: frontLocalPath, mimeType: 'image/jpeg' });
  } catch (e) {
    db.prepare("UPDATE catalogue_jobs SET status='failed', error=?, finished_at=datetime('now') WHERE id=?").run('upload front: ' + e.message, jobId);
    db.prepare("UPDATE catalogue_items SET status='failed' WHERE id=?").run(item.id);
    return;
  }

  const bg = await falai.removeBackground({ apiKey, imageUrl: frontUrl, itemId: item.id, userId: null });
  if (!bg.ok) {
    db.prepare("UPDATE catalogue_jobs SET status='failed', error=?, finished_at=datetime('now') WHERE id=?").run('bg removal: ' + bg.error, jobId);
    db.prepare("UPDATE catalogue_items SET status='failed' WHERE id=?").run(item.id);
    return;
  }
  cutoutUrl = bg.url;
  costUsd += bg.costUsd || 0;
  // Save the cutout locally for reference.
  const cutoutPath = path.join(itemDir, 'cutout-front.png');
  try { await falai.downloadTo(cutoutUrl, cutoutPath); } catch (_) {}
  db.prepare(`INSERT INTO catalogue_assets (item_id, kind, source, file_path, cost_inr, metadata)
              VALUES (?, 'cutout', 'ai', ?, ?, ?)`)
    .run(item.id, '/uploads/catalogue/' + item.id + '/cutout-front.png', falai.usdToInr(bg.costUsd || 0), JSON.stringify({ provider: 'fal', endpoint: 'birefnet' }));
  db.prepare('UPDATE catalogue_jobs SET completed_steps=1 WHERE id=?').run(jobId);

  // Step 2..N: try-on with each template.
  for (const tpl of templates) {
    // Re-check budget at every step — bail before incurring more cost
    // if the user hit their cap mid-run.
    const incurredInr = falai.usdToInr(costUsd);
    if (incurredInr >= perItemCap) {
      db.prepare("UPDATE catalogue_jobs SET error=?, finished_at=datetime('now'), status='partial' WHERE id=?")
        .run(`Stopped: per-item cap ₹${perItemCap} would be exceeded.`, jobId);
      break;
    }
    if (incurredInr + spendThisMonth() >= monthlyCap) {
      db.prepare("UPDATE catalogue_jobs SET error=?, finished_at=datetime('now'), status='partial' WHERE id=?")
        .run(`Stopped: monthly cap ₹${monthlyCap} would be exceeded.`, jobId);
      break;
    }

    // Upload template image (could be cached but keep it simple — a
    // single re-upload per generation is fractions of a cent).
    const tplLocalPath = path.join(__dirname, '..', '..', 'public', tpl.file_path.replace(/^\//, ''));
    let tplUrl;
    try { tplUrl = await falai.uploadFile({ apiKey, filePath: tplLocalPath, mimeType: 'image/jpeg' }); }
    catch (e) {
      console.error('[catalogue] template upload failed:', tpl.id, e.message);
      continue; // skip this template, try the next
    }

    const out = await falai.tryOn({ apiKey, modelImageUrl: tplUrl, garmentImageUrl: cutoutUrl, itemId: item.id });
    if (!out.ok) {
      // Log per-template failure but keep going — owner gets whatever
      // succeeded. Surface errors via catalogue_assets metadata.
      db.prepare(`INSERT INTO catalogue_assets (item_id, kind, source, variant, file_path, cost_inr, metadata)
                  VALUES (?, 'angle', 'ai', ?, '', 0, ?)`)
        .run(item.id, tpl.name, JSON.stringify({ failed: true, error: out.error }));
      db.prepare('UPDATE catalogue_jobs SET completed_steps=completed_steps+1 WHERE id=?').run(jobId);
      continue;
    }
    costUsd += out.costUsd || 0;
    const angleFile = `angle-${tpl.id}-${Date.now()}.jpg`;
    const angleLocalPath = path.join(itemDir, angleFile);
    try { await falai.downloadTo(out.url, angleLocalPath); } catch (e) {
      console.error('[catalogue] download angle failed:', e.message);
      continue;
    }
    // Watermark in-place.
    if (logoPath) {
      try {
        const wm = await watermark(angleLocalPath, logoPath);
        fs.writeFileSync(angleLocalPath, wm);
      } catch (e) {
        console.error('[catalogue] watermark failed:', e.message);
      }
    }
    db.prepare(`INSERT INTO catalogue_assets (item_id, kind, source, variant, file_path, cost_inr, metadata)
                VALUES (?, 'angle', 'ai', ?, ?, ?, ?)`)
      .run(item.id,
           tpl.name,
           '/uploads/catalogue/' + item.id + '/' + angleFile,
           falai.usdToInr(out.costUsd || 0),
           JSON.stringify({ template_id: tpl.id, pose: tpl.pose_label, provider: 'fal', endpoint: 'cat-vton' }));
    db.prepare('UPDATE catalogue_jobs SET completed_steps=completed_steps+1 WHERE id=?').run(jobId);
  }

  costInr = falai.usdToInr(costUsd);
  db.prepare(`UPDATE catalogue_items SET status='ready', total_cost_inr=total_cost_inr + ? WHERE id=?`).run(costInr, item.id);
  db.prepare(`UPDATE catalogue_jobs SET status=COALESCE(NULLIF(status,'partial'),'done'), cost_inr=?, finished_at=datetime('now') WHERE id=?`)
    .run(costInr, jobId);
}

// Public entry point — kicks off the job in the background and returns
// the job id immediately. The route handler calls this synchronously.
// `options` (e.g. { gender: 'female' }) gets stored on the job so the
// runner can filter templates accordingly.
function startGeneration(itemId, options = {}) {
  const job = db.prepare('INSERT INTO catalogue_jobs (item_id, status, options) VALUES (?, ?, ?)')
    .run(itemId, 'queued', JSON.stringify(options || {}));
  setImmediate(() => {
    runJob(job.lastInsertRowid).catch(err => {
      console.error('[catalogue] job failed:', err);
      try {
        db.prepare("UPDATE catalogue_jobs SET status='failed', error=?, finished_at=datetime('now') WHERE id=?").run(err.message, job.lastInsertRowid);
        db.prepare("UPDATE catalogue_items SET status='failed' WHERE id=?").run(itemId);
      } catch (_) {}
    });
  });
  return job.lastInsertRowid;
}

module.exports = { startGeneration, watermark };
