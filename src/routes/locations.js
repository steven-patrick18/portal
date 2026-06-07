// Locations master — head office, regional offices, future warehouses.
// Owner / admin only. List + new + edit + soft-toggle active.
const express = require('express');
const { db } = require('../db');
const { flash, requireRole } = require('../middleware/auth');
const { nextCode } = require('../utils/codegen');
const router = express.Router();

// Settings → Locations sits behind the same gate as Settings → Users.
router.use(requireRole('admin'));

const TYPES = ['factory', 'office', 'warehouse'];

router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT l.*,
      (SELECT COUNT(*) FROM users WHERE home_office_id = l.id AND active = 1) AS staff_count
    FROM locations l
    ORDER BY l.active DESC, l.type, l.name`).all();
  res.render('locations/index', { title: 'Offices / Locations', rows });
});

router.get('/new', (req, res) => {
  res.render('locations/form', { title: 'New Office', loc: null, types: TYPES });
});

router.post('/', (req, res) => {
  const { name, type, city, state, address, lat, lng, gstin, phone, active } = req.body;
  if (!name || !TYPES.includes(type)) {
    flash(req, 'danger', 'Name and a valid type are required.');
    return res.redirect('/locations/new');
  }
  const code = nextCode('locations', 'code', 'LOC');
  const r = db.prepare(`
    INSERT INTO locations (code, name, type, city, state, address, lat, lng, gstin, phone, active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(code, name.trim(), type,
         (city || '').trim() || null,
         (state || '').trim() || null,
         (address || '').trim() || null,
         lat ? parseFloat(lat) : null,
         lng ? parseFloat(lng) : null,
         (gstin || '').trim() || null,
         (phone || '').trim() || null,
         active ? 1 : 1);
  req.audit('create', 'location', r.lastInsertRowid, `${code} · ${name} (${type})`);
  flash(req, 'success', `Created ${code} — ${name}.`);
  res.redirect('/locations');
});

router.get('/:id/edit', (req, res) => {
  const loc = db.prepare('SELECT * FROM locations WHERE id=?').get(req.params.id);
  if (!loc) return res.redirect('/locations');
  res.render('locations/form', { title: 'Edit ' + loc.name, loc, types: TYPES });
});

router.post('/:id', (req, res) => {
  const loc = db.prepare('SELECT * FROM locations WHERE id=?').get(req.params.id);
  if (!loc) return res.redirect('/locations');
  const { name, type, city, state, address, lat, lng, gstin, phone, active } = req.body;
  if (!name || !TYPES.includes(type)) {
    flash(req, 'danger', 'Name and a valid type are required.');
    return res.redirect('/locations/' + loc.id + '/edit');
  }
  db.prepare(`
    UPDATE locations
       SET name=?, type=?, city=?, state=?, address=?, lat=?, lng=?, gstin=?, phone=?, active=?,
           updated_at=datetime('now')
     WHERE id=?`)
    .run(name.trim(), type,
         (city || '').trim() || null,
         (state || '').trim() || null,
         (address || '').trim() || null,
         lat ? parseFloat(lat) : null,
         lng ? parseFloat(lng) : null,
         (gstin || '').trim() || null,
         (phone || '').trim() || null,
         active ? 1 : 0,
         loc.id);
  req.audit('update', 'location', loc.id, `${loc.code} · ${name} (${type})${active ? '' : ' [inactive]'}`);
  flash(req, 'success', 'Updated.');
  res.redirect('/locations');
});

module.exports = router;
