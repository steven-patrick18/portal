const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const router = express.Router();

router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  let sql = 'SELECT * FROM suppliers';
  const params = [];
  if (q) {
    sql += ' WHERE name LIKE ? OR contact_person LIKE ? OR phone LIKE ? OR email LIKE ? OR gstin LIKE ?';
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  sql += ' ORDER BY id DESC';
  const items = db.prepare(sql).all(...params);
  res.render('suppliers/index', { title: 'Suppliers', items, q });
});
router.get('/new', (req, res) => res.render('suppliers/form', { title: 'New Supplier', s: null }));
router.post('/', (req, res) => {
  const { name, contact_person, phone, email, address, gstin } = req.body;
  db.prepare('INSERT INTO suppliers (name,contact_person,phone,email,address,gstin) VALUES (?,?,?,?,?,?)')
    .run(name, contact_person||null, phone||null, email||null, address||null, gstin||null);
  flash(req,'success','Supplier added.'); res.redirect('/suppliers');
});
router.get('/:id/edit', (req, res) => {
  const s = db.prepare('SELECT * FROM suppliers WHERE id=?').get(req.params.id);
  if (!s) return res.redirect('/suppliers');
  res.render('suppliers/form', { title: 'Edit Supplier', s });
});
router.post('/:id', (req, res) => {
  const { name, contact_person, phone, email, address, gstin, active } = req.body;
  db.prepare('UPDATE suppliers SET name=?,contact_person=?,phone=?,email=?,address=?,gstin=?,active=? WHERE id=?')
    .run(name, contact_person||null, phone||null, email||null, address||null, gstin||null, active?1:0, req.params.id);
  flash(req,'success','Updated.'); res.redirect('/suppliers');
});
module.exports = router;
