const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const curriculum = require('../training/curriculum');
const { flash } = require('../middleware/auth');
const router = express.Router();

// Each topic stores its slide images in public/img/training/<slug>/<n>.<ext>
// where <n> is 1-indexed and matches the slide's curriculum order.
const IMG_ROOT = path.join(__dirname, '..', '..', 'public', 'img', 'training');
function topicDir(slug) {
  const d = path.join(IMG_ROOT, slug);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

const slideUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, topicDir(req.params.slug)),
    filename:    (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.png';
      // Use a stable filename based on slide index → so the same path the
      // curriculum points at gets overwritten. Index is 1-based.
      const n = parseInt(req.params.idx, 10) + 1;
      // Strip any existing files for this slot first, regardless of extension,
      // so an old .png + new .jpg don't both linger.
      const dir = topicDir(req.params.slug);
      try { fs.readdirSync(dir).forEach(f => {
        if (new RegExp('^' + n + '-').test(f) || new RegExp('^' + n + '\\.').test(f)) fs.unlinkSync(path.join(dir, f));
      }); } catch (_) {}
      cb(null, n + ext);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g|webp|gif)$/i.test(file.mimetype)),
});

router.get('/', (req, res) => {
  res.render('training/index', { title: 'Training', topics: curriculum });
});

router.get('/:slug', (req, res) => {
  const topic = curriculum.find(t => t.slug === req.params.slug);
  if (!topic) return res.redirect('/training');
  const idx = curriculum.indexOf(topic);
  const prev = idx > 0 ? curriculum[idx - 1] : null;
  const next = idx < curriculum.length - 1 ? curriculum[idx + 1] : null;
  res.render('training/lesson', { title: topic.title + ' · Training', topic, prev, next, allTopics: curriculum });
});

// Picture-based slideshow — best for less-literate users + group sessions.
router.get('/:slug/slides', (req, res) => {
  const topic = curriculum.find(t => t.slug === req.params.slug);
  if (!topic) return res.redirect('/training');
  // For each slide, check if a real (uploaded) image exists for that slot,
  // and prefer it over the curriculum's default path. The slot number is
  // 1-indexed; we accept any common image extension.
  const dir = topicDir(topic.slug);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const slidesWithRealImg = (topic.slides || []).map((s, i) => {
    const n = i + 1;
    const found = files.find(f => new RegExp('^' + n + '\\.(png|jpe?g|webp|gif)$', 'i').test(f));
    return Object.assign({}, s, found ? { img: '/img/training/' + topic.slug + '/' + found, hasReal: true } : { hasReal: false });
  });
  res.render('training/slides', { title: topic.title + ' · Slides', topic: Object.assign({}, topic, { slides: slidesWithRealImg }) });
});

// Owner/admin: upload a screenshot for a specific slide slot.
router.post('/:slug/slides/:idx/upload', (req, res, next) => {
  if (!['owner','admin'].includes(req.session.user?.role)) {
    flash(req, 'danger', 'Only owner/admin can upload training screenshots.');
    return res.redirect('/training/' + req.params.slug + '/slides');
  }
  next();
}, slideUpload.single('screenshot'), (req, res) => {
  if (!req.file) {
    flash(req, 'danger', 'No file uploaded (must be PNG/JPG/WebP, max 5 MB).');
  } else {
    req.audit('upload', 'training_slide', null, `${req.params.slug}#${parseInt(req.params.idx)+1}`);
    flash(req, 'success', `Slide ${parseInt(req.params.idx)+1} updated.`);
  }
  res.redirect('/training/' + req.params.slug + '/slides');
});

router.post('/:slug/slides/:idx/delete', (req, res) => {
  if (!['owner','admin'].includes(req.session.user?.role)) {
    flash(req, 'danger', 'Only owner/admin can delete training screenshots.');
    return res.redirect('/training/' + req.params.slug + '/slides');
  }
  const dir = topicDir(req.params.slug);
  const n = parseInt(req.params.idx, 10) + 1;
  if (fs.existsSync(dir)) {
    fs.readdirSync(dir).forEach(f => {
      if (new RegExp('^' + n + '\\.(png|jpe?g|webp|gif)$', 'i').test(f)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
      }
    });
  }
  flash(req, 'success', `Slide ${n} reset to placeholder.`);
  res.redirect('/training/' + req.params.slug + '/slides');
});

module.exports = router;
