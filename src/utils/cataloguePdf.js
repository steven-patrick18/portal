// Per-item lookbook PDF — magazine-spread layout via pdfkit.
//
// Composition (A4 portrait, 595 × 842 pt):
//   • Cover page — company logo, item name in serif, editorial blurb,
//     hero photo (largest AI angle, or front original if no angles)
//   • One full-bleed plate per AI angle, with caption
//   • Optional appendix — front + back originals, small
//   • Closing page — quiet "© <Company> · <Year>" block
//
// pdfkit is purely programmatic so we draw geometry directly. The
// "premium" look comes from generous margins, serif headings, and
// black/white palette — same language as the web pages.

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { db } = require('../db');

const A4 = { w: 595.28, h: 841.89 }; // A4 portrait in points

function getSetting(key, fallback = '') {
  const r = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  return r ? r.value : fallback;
}
function localPath(webPath) {
  // Convert "/uploads/foo.jpg" → "<repo>/public/uploads/foo.jpg"
  if (!webPath) return null;
  return path.join(__dirname, '..', '..', 'public', webPath.replace(/^\//, ''));
}

function buildLookbookPdf(itemId, res) {
  const item = db.prepare('SELECT * FROM catalogue_items WHERE id=?').get(itemId);
  if (!item) { res.status(404).send('Item not found'); return; }

  const angles = db.prepare("SELECT * FROM catalogue_assets WHERE item_id=? AND kind='angle' AND file_path != '' ORDER BY id").all(item.id);
  const originals = db.prepare("SELECT * FROM catalogue_assets WHERE item_id=? AND kind LIKE 'original_%' ORDER BY id").all(item.id);
  const company = getSetting('COMPANY_NAME', 'Portal ERP');
  const logoPath = localPath(getSetting('COMPANY_LOGO', ''));

  const doc = new PDFDocument({ size: 'A4', margin: 0, info: {
    Title: company + ' · ' + item.name,
    Author: company,
    Subject: 'Catalogue lookbook · #' + String(item.id).padStart(3, '0'),
    Creator: 'Portal ERP',
  } });

  // Stream straight to the response — no buffering, no temp files.
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${slug(company + '-' + item.name)}.pdf"`);
  doc.pipe(res);

  // ── helpers ─────────────────────────────────────────────────────
  const margin = 48;
  const innerW = A4.w - margin * 2;

  function drawEyebrow(text, x, y) {
    doc.font('Helvetica').fontSize(7.5).fillColor('#666')
      .text(text.toUpperCase(), x, y, { characterSpacing: 2.5, width: innerW });
  }
  function drawHairline(y) {
    doc.strokeColor('#cccccc').lineWidth(0.4).moveTo(margin, y).lineTo(A4.w - margin, y).stroke();
  }
  function drawFooter(pageNum) {
    drawHairline(A4.h - margin - 14);
    doc.font('Helvetica').fontSize(6.5).fillColor('#999').text(
      company.toUpperCase(),
      margin, A4.h - margin - 8,
      { width: innerW, align: 'center', characterSpacing: 2 }
    );
    doc.text(String(pageNum).padStart(2, '0'), A4.w - margin - 30, A4.h - margin - 8, { width: 30, align: 'right' });
  }
  function safeImage(p, x, y, opts) {
    try { if (p && fs.existsSync(p)) doc.image(p, x, y, opts); else placeholderRect(x, y, opts); }
    catch (e) { placeholderRect(x, y, opts); }
  }
  function placeholderRect(x, y, opts) {
    const w = opts && opts.fit ? opts.fit[0] : (opts && opts.width) || 200;
    const h = opts && opts.fit ? opts.fit[1] : (opts && opts.height) || 200;
    doc.rect(x, y, w, h).fill('#ececea').fillColor('#000');
  }

  // ── Cover page ───────────────────────────────────────────────────
  // Hero photo — first AI angle, or front original.
  const heroSrc = (angles[0] && angles[0].file_path) || (originals[0] && originals[0].file_path) || null;
  const heroPath = localPath(heroSrc);
  const heroY = margin;
  const heroH = A4.h * 0.55;
  safeImage(heroPath, 0, 0, { width: A4.w, height: heroH });
  // Subtle gradient at the bottom of hero so logo + name read on any photo
  doc.rect(0, heroH - 60, A4.w, 60).fill('rgba(255,255,255,0)'); // pdfkit doesn't do gradients trivially; leave a clean cut

  // Logo + house name top-left of cover
  if (logoPath && fs.existsSync(logoPath)) {
    try { doc.image(logoPath, margin, margin, { width: 36 }); } catch (_) {}
  }
  doc.font('Helvetica').fontSize(7.5).fillColor('#fff')
    .text(company.toUpperCase(), margin + (logoPath ? 48 : 0), margin + 12, { characterSpacing: 2 });

  // Title block below hero
  const titleY = heroH + 56;
  drawEyebrow(`№ ${String(item.id).padStart(3, '0')}  ·  THE CATALOGUE`, margin, titleY);
  doc.font('Times-Bold').fontSize(38).fillColor('#0a0a0a')
    .text(item.name, margin, titleY + 18, { width: innerW });

  if (item.editorial_copy) {
    doc.font('Times-Italic').fontSize(13).fillColor('#0a0a0a')
      .text(item.editorial_copy, margin, doc.y + 18, { width: innerW * 0.85, lineGap: 4 });
  } else if (item.description) {
    doc.font('Times-Roman').fontSize(11).fillColor('#666')
      .text(item.description, margin, doc.y + 18, { width: innerW * 0.85 });
  }

  drawFooter(1);

  // ── One full-bleed plate per angle ───────────────────────────────
  let pageNum = 1;
  angles.forEach((a, idx) => {
    pageNum++;
    doc.addPage();
    const ap = localPath(a.file_path);
    // Plate occupies ~75% of the page; caption block below.
    const plateH = A4.h * 0.7;
    safeImage(ap, margin, margin, { fit: [innerW, plateH], align: 'center', valign: 'center' });

    const capY = margin + plateH + 26;
    drawEyebrow(`Plate ${String(idx + 1).padStart(2, '0')}  ·  ${(a.variant || '').toUpperCase()}`, margin, capY);
    doc.font('Times-Bold').fontSize(16).fillColor('#0a0a0a')
      .text(item.name, margin, capY + 20, { width: innerW });
    if (item.editorial_copy) {
      doc.font('Times-Italic').fontSize(10).fillColor('#444')
        .text(item.editorial_copy, margin, doc.y + 8, { width: innerW * 0.7, lineGap: 2 });
    }
    drawFooter(pageNum);
  });

  // ── Appendix: source photos (small, quiet) ───────────────────────
  if (originals.length > 0) {
    pageNum++;
    doc.addPage();
    drawEyebrow('Appendix · Source material', margin, margin);
    doc.font('Times-Bold').fontSize(20).fillColor('#0a0a0a')
      .text('As supplied.', margin, margin + 16, { width: innerW });

    const thumbW = 160, thumbH = 200, gutter = 24;
    let x = margin, y = margin + 80;
    originals.forEach((o, i) => {
      if (x + thumbW > A4.w - margin) { x = margin; y += thumbH + 50; }
      safeImage(localPath(o.file_path), x, y, { fit: [thumbW, thumbH] });
      drawEyebrow(o.kind === 'original_front' ? 'Front' : 'Back', x, y + thumbH + 6);
      x += thumbW + gutter;
    });

    drawFooter(pageNum);
  }

  // ── Closing page ─────────────────────────────────────────────────
  pageNum++;
  doc.addPage();
  doc.font('Helvetica').fontSize(7).fillColor('#666')
    .text('—', margin, A4.h / 2 - 80, { width: innerW, align: 'center', characterSpacing: 4 });
  doc.font('Times-Italic').fontSize(11).fillColor('#000')
    .text(company, margin, A4.h / 2 - 50, { width: innerW, align: 'center' });
  doc.font('Helvetica').fontSize(7).fillColor('#999')
    .text('© ' + new Date().getFullYear() + '  ·  ALL RIGHTS RESERVED', margin, A4.h / 2 - 30,
      { width: innerW, align: 'center', characterSpacing: 2 });

  doc.end();
}

function slug(s) {
  return String(s || 'lookbook').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

module.exports = { buildLookbookPdf };
