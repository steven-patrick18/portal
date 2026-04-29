const express = require('express');
const { db } = require('../db');
const { requireRole, flash } = require('../middleware/auth');
const router = express.Router();
router.use(requireRole('admin'));

router.get('/', (req, res) => {
  const items = db.prepare('SELECT * FROM payment_modes ORDER BY id').all();
  res.render('paymentModes/index', { title: 'Payment Modes', items });
});
router.post('/', (req, res) => {
  try { db.prepare('INSERT INTO payment_modes (name) VALUES (?)').run(req.body.name); flash(req,'success','Added'); }
  catch(e){ flash(req,'danger',e.message); }
  res.redirect('/payment-modes');
});
router.post('/:id/toggle', (req, res) => {
  db.prepare('UPDATE payment_modes SET active = 1 - active WHERE id=?').run(req.params.id);
  res.redirect('/payment-modes');
});
module.exports = router;
