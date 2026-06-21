// Locations master — head office, regional offices, future warehouses.
// Access is now governed by the `settings_locations` feature in the
// Access & Roles matrix (applied at the mount in app.js), so the owner
// can grant or revoke it per role/user instead of a hard admin-only gate.
const express = require('express');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { nextCode } = require('../utils/codegen');
const router = express.Router();

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

function readCapsAndType(body) {
  // Read the three capability checkboxes off the form. Also derive a
  // sensible primary `type` for sort + emoji display: factory wins over
  // warehouse wins over office (matches the sort order in the list).
  const is_factory_in = body.is_factory_in ? 1 : 0;
  const is_office     = body.is_office     ? 1 : 0;
  const is_warehouse  = body.is_warehouse  ? 1 : 0;
  let type = body.type;
  if (!TYPES.includes(type)) {
    if (is_factory_in)     type = 'factory';
    else if (is_warehouse) type = 'warehouse';
    else if (is_office)    type = 'office';
    else                   type = 'office';
  }
  // At least one capability must be checked — empty locations are useless.
  const hasAny = is_factory_in || is_office || is_warehouse;
  return { is_factory_in, is_office, is_warehouse, type, hasAny };
}

router.post('/', (req, res) => {
  const { name, city, state, address, lat, lng, gstin, phone, active } = req.body;
  const caps = readCapsAndType(req.body);
  if (!name) { flash(req, 'danger', 'Name is required.'); return res.redirect('/locations/new'); }
  if (!caps.hasAny) {
    flash(req, 'danger', 'Pick at least one role (Office / Warehouse / Factory in-out).');
    return res.redirect('/locations/new');
  }
  const code = nextCode('locations', 'code', 'LOC');
  const r = db.prepare(`
    INSERT INTO locations (code, name, type, is_factory_in, is_office, is_warehouse, city, state, address, lat, lng, gstin, phone, active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(code, name.trim(), caps.type, caps.is_factory_in, caps.is_office, caps.is_warehouse,
         (city || '').trim() || null,
         (state || '').trim() || null,
         (address || '').trim() || null,
         lat ? parseFloat(lat) : null,
         lng ? parseFloat(lng) : null,
         (gstin || '').trim() || null,
         (phone || '').trim() || null,
         1);
  const roleSummary = [caps.is_factory_in && '🏭 factory-in', caps.is_office && '🏢 office', caps.is_warehouse && '📦 warehouse'].filter(Boolean).join(' + ');
  req.audit('create', 'location', r.lastInsertRowid, `${code} · ${name} (${roleSummary})`);
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
  const { name, city, state, address, lat, lng, gstin, phone, active } = req.body;
  const caps = readCapsAndType(req.body);
  if (!name) { flash(req, 'danger', 'Name is required.'); return res.redirect('/locations/' + loc.id + '/edit'); }
  if (!caps.hasAny) {
    flash(req, 'danger', 'Pick at least one role (Office / Warehouse / Factory in-out).');
    return res.redirect('/locations/' + loc.id + '/edit');
  }
  db.prepare(`
    UPDATE locations
       SET name=?, type=?, is_factory_in=?, is_office=?, is_warehouse=?,
           city=?, state=?, address=?, lat=?, lng=?, gstin=?, phone=?, active=?,
           updated_at=datetime('now')
     WHERE id=?`)
    .run(name.trim(), caps.type, caps.is_factory_in, caps.is_office, caps.is_warehouse,
         (city || '').trim() || null,
         (state || '').trim() || null,
         (address || '').trim() || null,
         lat ? parseFloat(lat) : null,
         lng ? parseFloat(lng) : null,
         (gstin || '').trim() || null,
         (phone || '').trim() || null,
         active ? 1 : 0,
         loc.id);
  const roleSummary = [caps.is_factory_in && '🏭 factory-in', caps.is_office && '🏢 office', caps.is_warehouse && '📦 warehouse'].filter(Boolean).join(' + ');
  req.audit('update', 'location', loc.id, `${loc.code} · ${name} (${roleSummary})${active ? '' : ' [inactive]'}`);
  flash(req, 'success', 'Updated.');
  res.redirect('/locations');
});

module.exports = router;
