const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { db } = require('../db');
const { flash } = require('../middleware/auth');
const { nextCode } = require('../utils/codegen');
const { toCsv, sendCsv } = require('../utils/csv');
const { scopeWhere, isInScope, visibleSalespersons, visibleOffices, userIdsForOffice } = require('../middleware/scope');
const router = express.Router();

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const DEALER_CSV_COLUMNS = ['code','name','contact_person','phone','email','address','city','state','pincode','gstin','credit_limit','opening_balance','salesperson_email','active'];

router.get('/', (req, res) => {
  const q = (req.query.q||'').trim();
  // Salesperson role is forced to "my dealers" — they cannot see others.
  // Area manager defaults to "team" (own + direct reports) but can flip
  // the chip set explicitly. Owner/admin/accountant see all by default.
  const role = req.session.user.role;
  const isLimited = role === 'salesperson';
  const isManager = role === 'area_manager';
  const filter = isLimited ? 'mine' : (req.query.filter || 'all');
  // Owner/admin can also narrow to a specific salesperson via ?sp= — used
  // by the "Print dealer list for one salesperson" workflow. An area
  // manager can also pass ?sp= but it's only honoured if the picked sp is
  // in their team scope (server-side guard below).
  const spFilter = !isLimited && req.query.sp ? parseInt(req.query.sp) : null;
  // Phase 3: office filter — narrow to dealers whose salesperson is
  // tied to a given home office. Honoured for full-visibility roles
  // only (the filter list is empty for everyone else anyway).
  const officeFilter = req.query.office ? parseInt(req.query.office) : null;
  const officeIds = officeFilter ? userIdsForOffice(officeFilter) : null;
  const scope = scopeWhere(req, 'd.salesperson_id');
  // "paid" sums verified payments from the payments table, not the
  // invoices.paid_amount cache — see explanation in the show route.
  let sql = `
    SELECT d.*, u.name AS sp_name,
      COALESCE((SELECT SUM(total)  FROM invoices WHERE dealer_id=d.id AND status!='cancelled'),0) AS billed,
      COALESCE((SELECT SUM(amount) FROM payments WHERE dealer_id=d.id AND status='verified'),0) AS paid,
      COALESCE((SELECT SUM(total_amount) FROM returns  WHERE dealer_id=d.id AND status IN ('approved','restocked')),0) AS returned
    FROM dealers d LEFT JOIN users u ON u.id=d.salesperson_id`;
  const params = [];
  const where = [];
  if (q) { where.push('(d.code LIKE ? OR d.name LIKE ? OR d.phone LIKE ?)'); params.push(`%${q}%`,`%${q}%`,`%${q}%`); }
  if (filter === 'mine') { where.push('d.salesperson_id=?'); params.push(req.session.user.id); }
  if (spFilter) { where.push('d.salesperson_id=?'); params.push(spFilter); }
  // Office filter: restrict to dealers whose salesperson belongs to the
  // selected office. Empty office → no users → emit a 0=1 sentinel.
  if (officeIds !== null) {
    if (officeIds.length === 0) { where.push('0=1'); }
    else {
      where.push('d.salesperson_id IN (' + officeIds.map(() => '?').join(',') + ')');
      params.push(...officeIds);
    }
  }
  // Team scope: salesperson sees own; area_manager sees team; rest see all.
  if (scope.where !== '1=1') { where.push(scope.where); params.push(...scope.params); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY d.id DESC';
  const items = db.prepare(sql).all(...params);
  // Outstanding = opening + billed - paid - approved-return credits.
  // Approved/restocked returns reduce what the dealer owes us.
  items.forEach(d => d.outstanding = (d.opening_balance||0) + d.billed - d.paid - (d.returned||0));
  // Salesperson dropdown — owner/admin see all salespersons; area_manager
  // sees just their team.
  const salespersons = isLimited
    ? []
    : visibleSalespersons(req).filter(u => u.role === 'salesperson' || u.id === req.session.user.id);
  const spName = spFilter ? (salespersons.find(s => s.id === spFilter)?.name || null) : null;
  const offices = visibleOffices(req);
  const officeName = officeFilter ? (offices.find(o => o.id === officeFilter)?.name || null) : null;
  res.render('dealers/index', { title: 'Dealers / Customers', items, q, filter, isLimited, salespersons, spFilter, spName, offices, officeFilter, officeName });
});

// Bulk-assign dealers to a salesperson (admin only)
router.get('/assign', (req, res) => {
  if (['salesperson','area_manager','production','store'].includes(req.session.user.role)) {
    return res.status(403).render('error', { title: 'Forbidden', message: 'Admin access required.', code: 403 });
  }
  const filter = req.query.sp || 'all'; // 'all' | 'unassigned' | <userId>
  // Outstanding uses the same opening + billed - paid - returns formula
  // as the dealer list / show page (single source of truth).
  let sql = `SELECT d.id, d.code, d.name, d.city, d.state, d.phone, d.salesperson_id, u.name AS sp_name,
               COALESCE(d.opening_balance, 0)
               + COALESCE((SELECT SUM(total)  FROM invoices WHERE dealer_id=d.id AND status!='cancelled'), 0)
               - COALESCE((SELECT SUM(amount) FROM payments WHERE dealer_id=d.id AND status='verified'), 0)
               - COALESCE((SELECT SUM(total_amount) FROM returns WHERE dealer_id=d.id AND status IN ('approved','restocked')), 0) AS outstanding
             FROM dealers d LEFT JOIN users u ON u.id=d.salesperson_id WHERE d.active=1`;
  const params = [];
  if (filter === 'unassigned') sql += ' AND d.salesperson_id IS NULL';
  else if (filter !== 'all')   { sql += ' AND d.salesperson_id = ?'; params.push(filter); }
  sql += ' ORDER BY u.name NULLS LAST, d.name';
  const dealers = db.prepare(sql).all(...params);
  const salespersons = db.prepare("SELECT id, name FROM users WHERE active=1 AND role IN ('salesperson','admin','owner') ORDER BY role, name").all();
  // Group dealer counts by salesperson
  const counts = db.prepare(`
    SELECT salesperson_id, COUNT(*) AS n
    FROM dealers WHERE active=1 GROUP BY salesperson_id
  `).all();
  const countMap = {};
  let unassignedCount = 0;
  counts.forEach(c => { if (c.salesperson_id === null) unassignedCount = c.n; else countMap[c.salesperson_id] = c.n; });
  res.render('dealers/assign', { title: 'Assign Dealers to Salespersons', dealers, salespersons, filter, countMap, unassignedCount });
});

router.post('/assign', (req, res) => {
  if (['salesperson','area_manager','production','store'].includes(req.session.user.role)) {
    return res.status(403).render('error', { title: 'Forbidden', message: 'Admin access required.', code: 403 });
  }
  const ids = [].concat(req.body.dealer_ids || []).map(x => parseInt(x)).filter(Boolean);
  const newSp = req.body.salesperson_id ? parseInt(req.body.salesperson_id) : null;
  if (ids.length === 0) { flash(req, 'danger', 'Pick at least one dealer'); return res.redirect('/dealers/assign'); }
  const upd = db.prepare("UPDATE dealers SET salesperson_id = ?, updated_at = datetime('now') WHERE id = ?");
  ids.forEach(id => upd.run(newSp, id));
  const spName = newSp ? db.prepare('SELECT name FROM users WHERE id=?').get(newSp)?.name : null;
  req.audit('bulk_assign', 'dealer', null, `${ids.length} dealer(s) ${newSp ? '→ ' + spName : 'unassigned'} (ids: ${ids.join(',')})`);
  flash(req, 'success', `${ids.length} dealer${ids.length>1?'s':''} ${newSp ? 'assigned to ' + spName : 'unassigned'}.`);
  res.redirect('/dealers/assign');
});

router.get('/new', (req, res) => {
  const sp = db.prepare("SELECT id,name FROM users WHERE active=1 AND role IN ('salesperson','admin','owner') ORDER BY name").all();
  res.render('dealers/form', { title: 'New Dealer', d: null, sp });
});

router.post('/', (req, res) => {
  const { name, contact_person, phone, email, address, city, state, pincode, gstin, credit_limit, opening_balance, salesperson_id } = req.body;
  const code = req.body.code || nextCode('dealers','code','DLR');
  const ownerSp = req.session.user.role === 'salesperson' ? req.session.user.id : (salesperson_id || null);
  const r = db.prepare(`INSERT INTO dealers (code,name,contact_person,phone,email,address,city,state,pincode,gstin,credit_limit,opening_balance,salesperson_id)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(code, name, contact_person||null, phone||null, email||null, address||null, city||null, state||null, pincode||null, gstin||null,
         parseFloat(credit_limit||0), parseFloat(opening_balance||0), ownerSp);
  req.audit('create', 'dealer', r.lastInsertRowid, `${code} ${name} (${city || '-'}) credit ₹${credit_limit || 0}`);
  flash(req,'success','Dealer added.'); res.redirect('/dealers');
});

// ----- CSV Export / Import (owner only) -----
// Defined BEFORE the /:id routes so Express doesn't treat "export.csv" or
// "import" as a numeric dealer id.
function requireAdminCsv(req, res, next) {
  if (req.session.user.role !== 'owner') {
    return res.status(403).render('error', { title: 'Forbidden', message: 'Owner access required.', code: 403 });
  }
  next();
}

router.get('/export.csv', requireAdminCsv, (req, res) => {
  const rows = db.prepare(`
    SELECT d.code, d.name, d.contact_person, d.phone, d.email, d.address, d.city, d.state, d.pincode,
           d.gstin, d.credit_limit, d.opening_balance, u.email AS salesperson_email, d.active
    FROM dealers d LEFT JOIN users u ON u.id = d.salesperson_id
    ORDER BY d.code
  `).all();
  const csv = toCsv(rows, DEALER_CSV_COLUMNS);
  const stamp = new Date().toISOString().slice(0,10);
  sendCsv(res, `dealers_${stamp}.csv`, csv);
});

router.get('/import', requireAdminCsv, (req, res) => {
  res.render('dealers/import', { title: 'Import Dealers (CSV)' });
});

router.post('/import', requireAdminCsv, csvUpload.single('file'), (req, res) => {
  if (!req.file) { flash(req,'danger','No file uploaded'); return res.redirect('/dealers/import'); }
  let rows;
  try {
    rows = parse(req.file.buffer.toString('utf-8').replace(/^﻿/, ''), { columns: true, skip_empty_lines: true, trim: true });
  } catch (e) { flash(req,'danger','CSV parse failed: ' + e.message); return res.redirect('/dealers/import'); }

  const deactivateMissing = req.body.deactivate_missing === '1';
  // "Replace all" = wipe every existing dealer before importing. To guard
  // against accidental clicks, the form requires the user to type the
  // literal phrase REPLACE ALL (caps) in a confirmation box.
  const replaceAll = req.body.replace_all === '1' && (req.body.replace_confirm || '').trim() === 'REPLACE ALL';
  if (req.body.replace_all === '1' && !replaceAll) {
    flash(req, 'danger', 'To replace all dealers you must type "REPLACE ALL" in the confirmation box.');
    return res.redirect('/dealers/import');
  }

  let inserted = 0, updated = 0, deactivated = 0, failed = 0;
  let wipedHard = 0, wipedSoft = 0;
  const errors = [];
  const seenCodes = new Set();

  const findByCode = db.prepare('SELECT id FROM dealers WHERE code = ?');
  const insStmt = db.prepare(`INSERT INTO dealers (code,name,contact_person,phone,email,address,city,state,pincode,gstin,credit_limit,opening_balance,salesperson_id,active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const updStmt = db.prepare(`UPDATE dealers SET name=?, contact_person=?, phone=?, email=?, address=?, city=?, state=?, pincode=?, gstin=?, credit_limit=?, opening_balance=?, salesperson_id=?, active=?, updated_at=datetime('now') WHERE id=?`);
  const deactStmt = db.prepare(`UPDATE dealers SET active=0, updated_at=datetime('now') WHERE active=1 AND code NOT IN (SELECT value FROM json_each(?))`);
  const lookupSp = db.prepare('SELECT id FROM users WHERE email = ?');
  // Replace-all helpers: hard-delete dealers with no transaction history,
  // soft-delete (active=0) those that have invoices/payments/orders so the
  // historical data isn't broken.
  const countDealerRefs = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM invoices     WHERE dealer_id = d.id) +
      (SELECT COUNT(*) FROM payments     WHERE dealer_id = d.id) +
      (SELECT COUNT(*) FROM sales_orders WHERE dealer_id = d.id) AS n
    FROM dealers d WHERE d.id = ?
  `);
  const hardDelDealer = db.prepare('DELETE FROM dealers WHERE id = ?');
  const softDelDealer = db.prepare("UPDATE dealers SET active=0, code = code || '_old_' || ?, updated_at = datetime('now') WHERE id = ?");

  const trx = db.transaction(() => {
    if (replaceAll) {
      const allIds = db.prepare('SELECT id FROM dealers').all().map(r => r.id);
      // Use a single timestamp suffix so the renamed codes are all consistent
      // and won't collide with each other or with the incoming CSV codes.
      const suffix = Math.floor(Date.now() / 1000);
      for (const id of allIds) {
        try {
          if (countDealerRefs.get(id).n > 0) {
            // Rename the code (append _old_<ts>) so an incoming CSV with the
            // same code inserts cleanly without UNIQUE-key collisions.
            softDelDealer.run(suffix, id);
            wipedSoft++;
          } else {
            hardDelDealer.run(id);
            wipedHard++;
          }
        } catch (_) { failed++; }
      }
    }
    rows.forEach((r, idx) => {
      try {
        if (!r.name) throw new Error('name is required');
        const code = (r.code || '').trim() || nextCode('dealers','code','DLR');
        seenCodes.add(code);
        const spId = r.salesperson_email ? (lookupSp.get(r.salesperson_email.trim())?.id || null) : null;
        const active = (r.active === '' || r.active === undefined) ? 1 : (parseInt(r.active) ? 1 : 0);
        const existing = findByCode.get(code);
        if (existing) {
          updStmt.run(r.name, r.contact_person||null, r.phone||null, r.email||null, r.address||null, r.city||null, r.state||null, r.pincode||null, r.gstin||null,
            parseFloat(r.credit_limit||0), parseFloat(r.opening_balance||0), spId, active, existing.id);
          updated++;
        } else {
          insStmt.run(code, r.name, r.contact_person||null, r.phone||null, r.email||null, r.address||null, r.city||null, r.state||null, r.pincode||null, r.gstin||null,
            parseFloat(r.credit_limit||0), parseFloat(r.opening_balance||0), spId, active);
          inserted++;
        }
      } catch (e) {
        failed++;
        errors.push(`Row ${idx+2}: ${e.message}`);
      }
    });
    if (deactivateMissing && seenCodes.size > 0) {
      const r = deactStmt.run(JSON.stringify([...seenCodes]));
      deactivated = r.changes;
    }
  });
  try { trx(); }
  catch (e) { flash(req,'danger','Import aborted: ' + e.message); return res.redirect('/dealers/import'); }

  const auditDetails = `${replaceAll ? `REPLACE ALL (wiped ${wipedHard} hard, ${wipedSoft} soft) · ` : ''}${inserted} new, ${updated} updated, ${deactivated} deactivated, ${failed} failed`;
  req.audit(replaceAll ? 'csv_replace_all' : 'csv_import', 'dealer', null, auditDetails);
  const level = failed === 0 ? 'success' : 'warning';
  let msg = '';
  if (replaceAll) msg += `Wiped ${wipedHard} dealer${wipedHard===1?'':'s'} (hard) + ${wipedSoft} kept as inactive (had transactions). `;
  msg += `Import done — ${inserted} new, ${updated} updated`;
  if (deactivateMissing) msg += `, ${deactivated} deactivated (not in CSV)`;
  if (failed) msg += `, ${failed} failed: ${errors.slice(0,3).join('; ')}`;
  flash(req, level, msg);
  res.redirect('/dealers');
});

// ─── Duplicates finder (owner only) ──────────────────────────
// Groups active dealers that share the same phone OR the same
// case-insensitive trimmed name. Lets the owner pick which row to keep
// and bulk-delete (or deactivate) the rest. Designed for the post-import
// cleanup case where the same CSV was uploaded twice.
router.get('/duplicates', (req, res) => {
  if (req.session.user.role !== 'owner') {
    flash(req, 'danger', 'Only the owner can use the duplicates tool.');
    return res.redirect('/dealers');
  }
  // Build groups keyed by phone (when present) and by normalised name.
  // Only consider ACTIVE dealers — inactive rows are usually historical
  // soft-deletions (e.g. *_old_<ts> from a prior REPLACE ALL) and showing
  // them in the duplicates list is just noise.
  const all = db.prepare(`SELECT id, code, name, phone, city, gstin, active, created_at FROM dealers WHERE active=1 ORDER BY id`).all();
  const byPhone = new Map();
  const byName  = new Map();
  for (const d of all) {
    if (d.phone && d.phone.trim()) {
      const k = d.phone.replace(/\D+/g, '');
      if (k) (byPhone.get(k) || byPhone.set(k, []).get(k)).push(d);
    }
    const nk = (d.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (nk) (byName.get(nk) || byName.set(nk, []).get(nk)).push(d);
  }
  // Only keep groups with > 1 dealer; collect ref counts for each id.
  const refCounts = new Map();
  const countRef = (id) => {
    if (refCounts.has(id)) return refCounts.get(id);
    const n =
      db.prepare('SELECT COUNT(*) AS n FROM invoices       WHERE dealer_id=?').get(id).n +
      db.prepare('SELECT COUNT(*) AS n FROM payments       WHERE dealer_id=?').get(id).n +
      db.prepare('SELECT COUNT(*) AS n FROM sales_orders   WHERE dealer_id=?').get(id).n;
    refCounts.set(id, n);
    return n;
  };
  function buildGroups(map, keyLabel) {
    const out = [];
    for (const [key, rows] of map) {
      if (rows.length < 2) continue;
      out.push({
        key, keyLabel,
        rows: rows.map(r => ({ ...r, ref_count: countRef(r.id) })).sort((a, b) => a.id - b.id),
      });
    }
    return out;
  }
  // De-duplicate: if a name-group is fully contained inside a phone-group, skip it.
  const phoneGroups = buildGroups(byPhone, 'phone');
  const idsInPhoneGroup = new Set(phoneGroups.flatMap(g => g.rows.map(r => r.id)));
  const nameGroups = buildGroups(byName, 'name').filter(g => !g.rows.every(r => idsInPhoneGroup.has(r.id)));
  const groups = [...phoneGroups, ...nameGroups];
  res.render('dealers/duplicates', {
    title: 'Find Duplicate Dealers',
    groups,
    totalDupes: groups.reduce((s, g) => s + g.rows.length - 1, 0),
  });
});

// Bulk-delete selected dealer ids. Hard-delete rows with no FK refs;
// fall back to soft-delete (active=0) for rows that have invoices/payments/orders
// so historical records stay intact.
router.post('/duplicates/bulk-delete', (req, res) => {
  if (req.session.user.role !== 'owner') {
    flash(req, 'danger', 'Only the owner can delete dealers.');
    return res.redirect('/dealers');
  }
  const ids = [].concat(req.body.dealer_ids || []).map(x => parseInt(x)).filter(Boolean);
  if (ids.length === 0) { flash(req, 'warning', 'No dealers selected.'); return res.redirect('/dealers/duplicates'); }
  let hardDeleted = 0, softDeleted = 0, failed = 0;
  const trx = db.transaction(() => {
    for (const id of ids) {
      try {
        const refs =
          db.prepare('SELECT COUNT(*) AS n FROM invoices     WHERE dealer_id=?').get(id).n +
          db.prepare('SELECT COUNT(*) AS n FROM payments     WHERE dealer_id=?').get(id).n +
          db.prepare('SELECT COUNT(*) AS n FROM sales_orders WHERE dealer_id=?').get(id).n;
        if (refs > 0) {
          db.prepare('UPDATE dealers SET active=0, updated_at=datetime("now") WHERE id=?').run(id);
          softDeleted++;
        } else {
          db.prepare('DELETE FROM dealers WHERE id=?').run(id);
          hardDeleted++;
        }
      } catch (_) { failed++; }
    }
  });
  trx();
  req.audit('bulk_delete', 'dealer', null, `hard=${hardDeleted}, soft=${softDeleted}, failed=${failed} (ids: ${ids.join(',')})`);
  flash(req, 'success', `${hardDeleted} deleted${softDeleted ? ', ' + softDeleted + ' deactivated (had transactions)' : ''}${failed ? ', ' + failed + ' failed' : ''}.`);
  res.redirect('/dealers/duplicates');
});

// Helper: caller can only access dealers assigned to a user inside
// their team scope. Owner/admin/accountant bypass (return false).
function dealerScopeBlocked(req, dealer) {
  if (!dealer) return true;
  if (dealer.salesperson_id == null) return false;  // unassigned — leave gating to feature perms
  return !isInScope(req, dealer.salesperson_id);
}

router.get('/:id', (req, res) => {
  const d = db.prepare('SELECT d.*, u.name AS sp_name FROM dealers d LEFT JOIN users u ON u.id=d.salesperson_id WHERE d.id=?').get(req.params.id);
  if (!d) return res.redirect('/dealers');
  if (dealerScopeBlocked(req, d)) {
    flash(req, 'danger', 'This dealer is not assigned to you.');
    return res.redirect('/dealers');
  }
  const invoices = db.prepare('SELECT * FROM invoices WHERE dealer_id=? ORDER BY id DESC LIMIT 50').all(req.params.id);
  const payments = db.prepare(`SELECT p.*, pm.name AS mode FROM payments p LEFT JOIN payment_modes pm ON pm.id=p.payment_mode_id WHERE p.dealer_id=? ORDER BY p.id DESC LIMIT 50`).all(req.params.id);
  const billed = db.prepare(`SELECT COALESCE(SUM(total),0) AS v FROM invoices WHERE dealer_id=? AND status!='cancelled'`).get(req.params.id).v;
  // "Paid" sums verified payments from the payments table — NOT the
  // invoices.paid_amount cache. Standalone "Receive Payment" entries
  // that aren't tied to a specific invoice (invoice_id NULL) were
  // previously dropped from the running balance, which made the
  // outstanding figure ignore real money received.
  const paid = db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM payments WHERE dealer_id=? AND status='verified'`).get(req.params.id).v;
  // Returns that are approved/restocked count as credit notes against the
  // dealer's ledger — they reduce the outstanding the dealer owes us.
  const returned = db.prepare(`SELECT COALESCE(SUM(total_amount),0) AS v FROM returns WHERE dealer_id=? AND status IN ('approved','restocked')`).get(req.params.id).v;
  const returnsList = db.prepare(`SELECT r.*, i.invoice_no FROM returns r LEFT JOIN invoices i ON i.id=r.invoice_id WHERE r.dealer_id=? ORDER BY r.id DESC LIMIT 50`).all(req.params.id);
  const outstanding = (d.opening_balance||0) + billed - paid - returned;
  res.render('dealers/show', { title: d.name, d, invoices, payments, returnsList, billed, paid, returned, outstanding });
});

router.get('/:id/edit', (req, res) => {
  const d = db.prepare('SELECT * FROM dealers WHERE id=?').get(req.params.id);
  if (!d) return res.redirect('/dealers');
  if (dealerScopeBlocked(req, d)) {
    flash(req, 'danger', 'This dealer is not assigned to you.');
    return res.redirect('/dealers');
  }
  const sp = db.prepare("SELECT id,name FROM users WHERE active=1 AND role IN ('salesperson','admin','owner') ORDER BY name").all();
  res.render('dealers/form', { title: 'Edit Dealer', d, sp });
});

router.post('/:id', (req, res) => {
  const existing = db.prepare('SELECT salesperson_id FROM dealers WHERE id=?').get(req.params.id);
  if (!existing) return res.redirect('/dealers');
  if (dealerScopeBlocked(req, existing)) {
    flash(req, 'danger', 'This dealer is not assigned to you.');
    return res.redirect('/dealers');
  }
  const { name, contact_person, phone, email, address, city, state, pincode, gstin, credit_limit, opening_balance, salesperson_id, active } = req.body;
  // Salesperson cannot reassign a dealer to someone else
  const newSpId = req.session.user.role === 'salesperson' ? existing.salesperson_id : (salesperson_id || null);
  db.prepare(`UPDATE dealers SET name=?, contact_person=?, phone=?, email=?, address=?, city=?, state=?, pincode=?, gstin=?, credit_limit=?, opening_balance=?, salesperson_id=?, active=?, updated_at=datetime('now') WHERE id=?`)
    .run(name, contact_person||null, phone||null, email||null, address||null, city||null, state||null, pincode||null, gstin||null,
         parseFloat(credit_limit||0), parseFloat(opening_balance||0), newSpId, active?1:0, req.params.id);
  req.audit('update', 'dealer', req.params.id, `${name} · credit ₹${credit_limit} · ${active ? 'active' : 'disabled'}`);
  flash(req,'success','Updated.'); res.redirect('/dealers/' + req.params.id);
});

// ─── Delete a single dealer (owner only) ─────────────────────
// Hard-deletes if the dealer has no invoices/payments/orders; otherwise
// deactivates so history stays intact. Used to clean up onboarding
// mistakes like a duplicate CSV upload.
router.post('/:id/delete', (req, res) => {
  if (req.session.user.role !== 'owner') {
    flash(req, 'danger', 'Only the owner can delete a dealer.');
    return res.redirect('/dealers/' + req.params.id);
  }
  const d = db.prepare('SELECT id, code, name FROM dealers WHERE id=?').get(req.params.id);
  if (!d) { flash(req, 'danger', 'Dealer not found.'); return res.redirect('/dealers'); }
  const refs =
    db.prepare('SELECT COUNT(*) AS n FROM invoices     WHERE dealer_id=?').get(d.id).n +
    db.prepare('SELECT COUNT(*) AS n FROM payments     WHERE dealer_id=?').get(d.id).n +
    db.prepare('SELECT COUNT(*) AS n FROM sales_orders WHERE dealer_id=?').get(d.id).n;
  if (refs > 0) {
    db.prepare('UPDATE dealers SET active=0, updated_at=datetime("now") WHERE id=?').run(d.id);
    req.audit('soft_delete', 'dealer', d.id, `${d.code} ${d.name} deactivated (${refs} transactions)`);
    flash(req, 'warning', `${d.code} has ${refs} linked transaction(s) — deactivated instead of hard-deleted so history is preserved.`);
    return res.redirect('/dealers');
  }
  db.prepare('DELETE FROM dealers WHERE id=?').run(d.id);
  req.audit('delete', 'dealer', d.id, `${d.code} ${d.name}`);
  flash(req, 'success', `${d.code} ${d.name} deleted.`);
  res.redirect('/dealers');
});

// ─── Reactivate a deactivated dealer (owner/admin) ─────────────
// Flips active=0 → 1 so the dealer rejoins active lists and reports.
// Used after a bulk-cleanup mistakenly deactivated a customer who's
// actually still trading, or after re-assignment of an old account.
router.post('/:id/reactivate', (req, res) => {
  if (!['owner','admin'].includes(req.session.user.role)) {
    flash(req,'danger','Only owner/admin can reactivate a dealer.');
    return res.redirect('/dealers/' + req.params.id);
  }
  const d = db.prepare('SELECT id, code, name, active FROM dealers WHERE id=?').get(req.params.id);
  if (!d) return res.redirect('/dealers');
  if (d.active) { flash(req,'info','Already active.'); return res.redirect('/dealers/' + d.id); }
  db.prepare('UPDATE dealers SET active=1, updated_at=datetime("now") WHERE id=?').run(d.id);
  req.audit('reactivate', 'dealer', d.id, `${d.code} ${d.name}`);
  flash(req,'success',`${d.code} ${d.name} reactivated — now visible in active lists.`);
  res.redirect('/dealers/' + d.id);
});

// ─── Clear stored shop location (owner/admin) ──────────────────
// Wipes lat/lng/last_visit_at so the next visit re-anchors the shop pin.
// Useful when a salesperson tagged from the wrong place (e.g. from a tea
// stall outside the shop) and we want the next visit to overwrite it.
router.post('/:id/clear-location', (req, res) => {
  if (!['owner', 'admin'].includes(req.session.user.role)) {
    flash(req, 'danger', 'Only owner/admin can clear a shop location.');
    return res.redirect('/dealers/' + req.params.id);
  }
  const d = db.prepare('SELECT id, code, name FROM dealers WHERE id=?').get(req.params.id);
  if (!d) return res.redirect('/dealers');
  db.prepare('UPDATE dealers SET last_visit_lat=NULL, last_visit_lng=NULL, last_visit_at=NULL, updated_at=datetime("now") WHERE id=?')
    .run(d.id);
  req.audit('clear_location', 'dealer', d.id, `${d.code} ${d.name}`);
  flash(req, 'success', `Shop location for ${d.code} cleared — the next visit will set a fresh pin.`);
  res.redirect('/dealers/' + d.id);
});

module.exports = router;
