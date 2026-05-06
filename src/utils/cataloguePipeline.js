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

// ── Scene library ────────────────────────────────────────────────
// Each scene is a name + an iclight-v2 prompt + a one-line description.
// Prompts are written like a fashion-photography brief — name a real
// photographer's signature so the lighting model has a concrete
// reference, and front-load the technical lighting cues (rim, key,
// fill, beauty dish). This produces noticeably more "live shoot" feel
// than generic "professional fashion photography" wording.
//
// `pure_white` is the no-op default — skip the relight call entirely,
// keep IDM-VTON's clean studio output untouched. Best fidelity for
// detailed prints, sarees with zari, embroidery work.
const SCENES = {
  pure_white: {
    label: 'Pure White (no relight)',
    prompt: null,
    description: 'Clean studio. Best for detailed prints, embroidery, zari. No extra cost.',
  },
  studio_noir: {
    label: 'Studio Noir',
    prompt: 'editorial fashion campaign in the style of Mario Testino, deep matte black seamless backdrop, single-source beauty dish key light from camera-left at 45 degrees, subtle hair light, dramatic chiaroscuro, sharp shadow falloff, full-frame medium format Hasselblad, ISO 100, shot on 85mm at f2.8, hyper-realistic skin detail, Italian Vogue cover',
    description: 'Black studio. Hard light, deep shadows. Vogue cover energy.',
  },
  marble_gallery: {
    label: 'Marble Gallery',
    prompt: 'editorial fashion campaign in the style of Steven Meisel, interior of an Italian Renaissance marble gallery (Galleria Borghese style), soft north-facing daylight diffused through tall arched windows, polished travertine floor reflecting cool ambient light, classical statuary blurred in shallow depth of field, medium format film Kodak Portra 400, calm museum atmosphere, refined editorial elegance',
    description: 'Italian gallery, soft daylight. Quiet luxury.',
  },
  rooftop_dusk: {
    label: 'Rooftop Dusk',
    prompt: 'editorial fashion campaign in the style of Annie Leibovitz, Manhattan rooftop at magic hour, warm directional sunset rim lighting from camera-right, distant Empire State and skyscraper skyline blurred in golden hour bokeh, late-summer atmosphere, shot on Canon EOS R5 with 70mm f1.8, cinematic warmth, Vanity Fair cover',
    description: 'Sunset rooftop. Warm gold rim light. Travel-feature look.',
  },
  monsoon_street: {
    label: 'Monsoon Street',
    prompt: 'editorial fashion campaign in the style of Tim Walker, Bombay alley after monsoon rain, glistening wet pavement with dramatic puddle reflections, soft overcast diffused daylight from above, distant neon shop signs blurred in shallow depth, romantic moody atmosphere, shot on Leica Q3 at 28mm f2.8, hyper-realistic film grain, Vogue India editorial',
    description: 'Wet street reflections, overcast sky. Cinematic monsoon.',
  },
  white_studio_lit: {
    label: 'Studio Daylight',
    prompt: 'editorial fashion campaign, bright clean white seamless studio backdrop, soft north-light through 6-foot diffuser, even three-point lighting (key, fill, hair), no harsh shadows, gallery-clean composition, medium format Phase One, ISO 50, shot on 110mm at f5.6, crisp commercial fashion photography, e-commerce hero standard',
    description: 'Clean lit studio. White backdrop with soft, even light.',
  },
};
function sceneList() {
  return Object.entries(SCENES).map(([key, v]) => ({ key, ...v }));
}

function getSetting(key, fallback = '') {
  const r = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  return r ? r.value : fallback;
}

function spendThisMonth() {
  const r = db.prepare(`SELECT COALESCE(SUM(cost_inr),0) AS n FROM ai_usage_log WHERE created_at >= strftime('%Y-%m-01','now')`).get();
  return r.n;
}

// Compose an "as-supplied" reference inset onto the AI plate: a small
// thumbnail of the owner's original product photo, dropped into the
// bottom-left corner with a hairline white border. This is the
// "detail-restoration" mechanism — instead of magically reconstructing
// brand patches via image warping (which current open-source CV can't
// do reliably), we surface the real product photo right next to the AI
// render so the dealer can verify the actual fabric / brand patch /
// stitching at a glance. Same trick MR PORTER and Sotheby's use.
async function addReferenceInset(aiPlatePath, sourcePhotoPath) {
  const base = sharp(aiPlatePath);
  const meta = await base.metadata();
  if (!fs.existsSync(sourcePhotoPath)) return base.toBuffer();
  // Inset sized to ~16% of plate width, square crop from source.
  const insetSize = Math.round((meta.width || 1024) * 0.16);
  const margin   = Math.round((meta.width || 1024) * 0.025);
  const border   = 3;
  // Fit-to-cover so the source crop is square and not distorted.
  const insetSrc = await sharp(sourcePhotoPath)
    .resize({ width: insetSize, height: insetSize, fit: 'cover', position: 'center' })
    .jpeg({ quality: 92 })
    .toBuffer();
  // Lay it on a white card with a hairline border (the magazine inset look).
  const card = await sharp({
    create: {
      width: insetSize + border * 2,
      height: insetSize + border * 2,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([{ input: insetSrc, left: border, top: border }])
    .png()
    .toBuffer();
  // Sharp's composite takes EITHER gravity OR top+left, not both.
  // Compute absolute bottom-left position so the margin is honoured.
  const cardSize = insetSize + border * 2;
  const top  = (meta.height || 1024) - cardSize - margin;
  const left = margin;
  return base
    .composite([{ input: card, top, left, blend: 'over' }])
    .jpeg({ quality: 92 })
    .toBuffer();
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

  // Templates the user has flagged active. Two filters apply:
  //   1. Gender — from the show-page picker (job.options.gender)
  //   2. Pose focus — derived from item.cloth_type. 'lower' garments
  //      get jeans-friendly poses (hands in pockets, walking), 'overall'
  //      gets full-silhouette poses (sarees/dresses), 'upper' gets the
  //      standard hands-on-hips kit. Templates tagged 'unisex' are
  //      fallbacks — used only when no type-specific template exists,
  //      so an owner with only the standard set still gets some output.
  const filter = job.options ? (() => { try { return JSON.parse(job.options); } catch { return {}; } })() : {};
  const poseFocus = item.cloth_type === 'lower' ? 'lower'
                  : item.cloth_type === 'overall' ? 'overall'
                  : 'upper';
  const params = [];
  let whereParts = ['active=1'];
  if (filter.gender && filter.gender !== 'all') {
    whereParts.push("(gender=? OR gender='unisex')");
    params.push(filter.gender);
  }

  // Try the type-specific pose set first; fall back to unisex/any if
  // the owner hasn't generated that set yet.
  let templates = db.prepare(
    `SELECT * FROM catalogue_templates WHERE ${whereParts.join(' AND ')} AND pose_focus=? ORDER BY sort_order, id`
  ).all(...params, poseFocus);
  let usedFallbackPoses = false;
  if (templates.length === 0) {
    // Fall back to unisex / any pose_focus — these are the older
    // templates from before multi-pose sets, or ones the owner uploaded
    // without setting pose_focus. Better than failing the run.
    templates = db.prepare(
      `SELECT * FROM catalogue_templates WHERE ${whereParts.join(' AND ')} ORDER BY sort_order, id`
    ).all(...params);
    if (templates.length > 0) usedFallbackPoses = true;
  }

  if (templates.length === 0) {
    const focusLabel = poseFocus === 'lower' ? 'jeans/trousers' : poseFocus === 'overall' ? 'sarees/dresses' : 'tops';
    const reason = filter.gender && filter.gender !== 'all'
      ? `No active templates for ${filter.gender} ${focusLabel}. Open Model Templates and click "Generate AI Defaults".`
      : `No active templates for ${focusLabel}. Open Model Templates and click "Generate AI Defaults".`;
    db.prepare("UPDATE catalogue_jobs SET status='failed', error=?, finished_at=datetime('now') WHERE id=?").run(reason, jobId);
    db.prepare("UPDATE catalogue_items SET status='failed' WHERE id=?").run(item.id);
    return;
  }
  if (usedFallbackPoses) {
    console.warn(`[catalogue] item ${item.id} (${item.cloth_type}) using unisex/upper pose fallback — generate ${poseFocus}-specific templates for better framing`);
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

    // Synthesise a garment description for the description-based fallback
    // (IDM-VTON). FASHN doesn't take description — it has a category
    // enum + photo-type hint instead — but we still build the desc here
    // so the IDM-VTON fallback path has good context if FASHN fails.
    const ct = item.cloth_type || 'upper';
    const ctHint = ct === 'lower'   ? 'lower-body garment, bottoms, trousers, jeans, or skirt'
                 : ct === 'overall' ? 'full-length one-piece garment, dress or saree'
                                    : 'upper-body garment, top, shirt, kurti, or blouse';
    const descParts = [item.name];
    if (item.description) descParts.push(item.description);
    descParts.push(ctHint);
    const garmentDesc = descParts.filter(Boolean).join('. ').slice(0, 200);

    // FASHN's category enum is the closest match to our cloth_type.
    const fashnCategory = ct === 'lower'   ? 'bottoms'
                        : ct === 'overall' ? 'one-pieces'
                                           : 'tops';

    // Try-on chain: FASHN (premium, brand-detail preserving) →
    // IDM-VTON (gold standard, description-driven) → CAT-VTON
    // (cheap fallback). Each tier doubles down on accuracy if the
    // previous tier returns an error.
    let out = await falai.tryOnFashn({
      apiKey,
      modelImageUrl: tplUrl,
      garmentImageUrl: cutoutUrl,
      category: fashnCategory,
      itemId: item.id,
    });
    let modelUsed = 'fashn-v1.6';

    if (!out.ok) {
      console.warn('[catalogue] FASHN failed, falling back to IDM-VTON:', out.error);
      out = await falai.tryOn({
        apiKey,
        modelImageUrl: tplUrl,
        garmentImageUrl: cutoutUrl,
        description: garmentDesc,
        clothType: ct,
        itemId: item.id,
      });
      modelUsed = 'idm-vton';
    }
    if (!out.ok) {
      console.warn('[catalogue] IDM-VTON failed, falling back to CAT-VTON:', out.error);
      out = await falai.tryOnFallback({
        apiKey,
        modelImageUrl: tplUrl,
        garmentImageUrl: cutoutUrl,
        clothType: ct,
        itemId: item.id,
      });
      modelUsed = 'cat-vton';
    }

    if (!out.ok) {
      // All three tiers failed — log the angle as failed, keep going
      // with remaining templates so the owner gets partial coverage.
      db.prepare(`INSERT INTO catalogue_assets (item_id, kind, source, variant, file_path, cost_inr, metadata)
                  VALUES (?, 'angle', 'ai', ?, '', 0, ?)`)
        .run(item.id, tpl.name, JSON.stringify({ failed: true, error: out.error, tried: ['fashn-v1.6', 'idm-vton', 'cat-vton'] }));
      db.prepare('UPDATE catalogue_jobs SET completed_steps=completed_steps+1 WHERE id=?').run(jobId);
      continue;
    }
    costUsd += out.costUsd || 0;

    // Optional scene relight — swap the studio backdrop for the chosen
    // luxury scene. Skipped entirely when scene_key is pure_white (the
    // CAT-VTON output already has the clean studio look).
    let finalUrl = out.url;
    const scene = SCENES[item.scene_key] || SCENES.pure_white;
    if (scene.prompt) {
      const relit = await falai.relightScene({ apiKey, imageUrl: out.url, prompt: scene.prompt, itemId: item.id });
      if (relit.ok && relit.url) {
        finalUrl = relit.url;
        costUsd += relit.costUsd || 0;
      } else {
        // Log but don't fail — fall back to the unrelit image so the
        // owner still gets the angle. iclight is a "make it prettier"
        // step, not a correctness one.
        console.warn('[catalogue] iclight failed, keeping unrelit:', relit.error);
      }
    }

    const angleFile = `angle-${tpl.id}-${Date.now()}.jpg`;
    const angleLocalPath = path.join(itemDir, angleFile);
    try { await falai.downloadTo(finalUrl, angleLocalPath); } catch (e) {
      console.error('[catalogue] download angle failed:', e.message);
      continue;
    }

    // Lower-body crop: for jeans/trousers/skirts, the model's torso +
    // face take up half the frame even though the actual product is
    // the lower half. Crop to bottom 65% so the garment dominates the
    // composition — this is what real denim catalogue shoots do.
    // Skip for poses where the back-view variant already shows the
    // garment well (the back-pocket-emphasising templates).
    if (ct === 'lower') {
      try {
        const meta = await sharp(angleLocalPath).metadata();
        const cropTop = Math.round((meta.height || 1296) * 0.30);  // drop top 30%
        const cropHeight = (meta.height || 1296) - cropTop;
        const buf = await sharp(angleLocalPath)
          .extract({ left: 0, top: cropTop, width: meta.width, height: cropHeight })
          .jpeg({ quality: 92 })
          .toBuffer();
        fs.writeFileSync(angleLocalPath, buf);
      } catch (e) {
        console.error('[catalogue] lower-body crop failed:', e.message);
      }
    }

    // Detail restoration — composite a small "as-supplied" reference
    // thumbnail of the owner's actual product photo onto the bottom-
    // left corner of every plate. This way the dealer always sees both
    // the AI's interpretation AND the real product, so brand details
    // (patches, exact stitching, real wash) that the AI couldn't
    // reproduce are still visible side-by-side.
    const sourcePhotoPath = path.join(__dirname, '..', '..', 'public', frontAsset.file_path.replace(/^\//, ''));
    try {
      const withInset = await addReferenceInset(angleLocalPath, sourcePhotoPath);
      fs.writeFileSync(angleLocalPath, withInset);
    } catch (e) {
      console.error('[catalogue] reference inset failed:', e.message);
    }

    // Watermark in-place — runs LAST so the brand mark sits on top of
    // the inset thumbnail (the inset is bottom-LEFT, the watermark is
    // bottom-right; they don't collide on standard aspect ratios).
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
           falai.usdToInr((out.costUsd || 0) + (scene.prompt ? 0.04 : 0)),
           JSON.stringify({
             template_id: tpl.id,
             pose: tpl.pose_label,
             gender: tpl.gender,
             scene: item.scene_key || 'pure_white',
             cloth_type: item.cloth_type || 'upper',
             fashn_category: fashnCategory,
             garment_description: garmentDesc,
             provider: 'fal',
             endpoints: scene.prompt ? [modelUsed, 'iclight-v2'] : [modelUsed],
             try_on_model: modelUsed,
             fell_back_to: modelUsed === 'fashn-v1.6' ? null : modelUsed,
           }));
    db.prepare('UPDATE catalogue_jobs SET completed_steps=completed_steps+1 WHERE id=?').run(jobId);
  }

  // After all angles are done, generate the editorial blurb (skip if the
  // owner already wrote one manually). Cheap (~₹0.04), but optional —
  // failure here doesn't fail the job.
  if (!item.editorial_copy) {
    const blurb = await falai.editorialCopy({
      apiKey,
      name: item.name,
      garmentType: item.cloth_type || 'upper',
      notes: item.description,
      itemId: item.id,
    });
    if (blurb.ok && blurb.copy) {
      db.prepare('UPDATE catalogue_items SET editorial_copy=? WHERE id=?').run(blurb.copy, item.id);
      costUsd += blurb.costUsd || 0;
    }
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

// Regenerate just the editorial copy for an item — used by the inline
// "✨ Regenerate" button on the show page. Returns { ok, copy, error }.
async function regenerateCopy(itemId) {
  const apiKey = (db.prepare("SELECT value FROM app_settings WHERE key='FAL_API_KEY'").get() || {}).value || '';
  if (!apiKey) return { ok: false, error: 'No fal.ai API key configured.' };
  const item = db.prepare('SELECT id, name, description, cloth_type FROM catalogue_items WHERE id=?').get(itemId);
  if (!item) return { ok: false, error: 'Item not found.' };
  const r = await falai.editorialCopy({
    apiKey,
    name: item.name,
    garmentType: item.cloth_type || 'upper',
    notes: item.description,
    itemId: item.id,
  });
  if (!r.ok) return { ok: false, error: r.error };
  db.prepare('UPDATE catalogue_items SET editorial_copy=? WHERE id=?').run(r.copy, item.id);
  return { ok: true, copy: r.copy };
}

module.exports = { startGeneration, watermark, regenerateCopy, SCENES, sceneList };
