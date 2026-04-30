const express = require('express');
const curriculum = require('../training/curriculum');
const router = express.Router();

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

module.exports = router;
