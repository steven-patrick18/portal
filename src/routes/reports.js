const express = require('express');
const { db } = require('../db');
const { requireFeature } = require('../middleware/permissions');
const { getScopeUserIds, visibleOffices, userIdsForOffice } = require('../middleware/scope');
const router = express.Router();

// Helper: build a "u.id IN (...)" fragment (or empty) for scoping the
// salesperson list in performance reports to the viewer's team. Returns
// an object that can be string-concatenated into a WHERE clause:
//   { clause: " AND u.id IN (?,?,?)", params: [1,2,3] }
// or, for full-visibility roles, { clause: '', params: [] }.
function spIdScope(req) {
  const ids = getScopeUserIds(req);
  if (ids === null) return { clause: '', params: [] };
  if (ids.length === 0) return { clause: ' AND 0=1', params: [] };
  return { clause: ' AND u.id IN (' + ids.map(() => '?').join(',') + ')', params: ids };
}

// Finance reports (collection / outstanding / aged AR / payment-modes)
// expose money-flow data — gate them on the granular `reports_finance` key
// so the owner can hide them from sub-roles without locking down all reports.
router.use(['/collection', '/outstanding', '/aged-outstanding', '/payment-modes'], requireFeature('reports_finance'));
// Production-side reports
router.use(['/production', '/production-efficiency', '/material-consumption', '/stock'], requireFeature('reports_production'));
// Sales analytics
router.use(['/sales', '/dealer-sales', '/product-sales', '/salesperson-detail', '/salesperson', '/geo-sales', '/product-performance'], requireFeature('reports_sales'));

router.get('/', (req, res) => {
  res.render('reports/index', { title: 'Reports' });
});

// ─── By-Office summary ─────────────────────────────────────────
// Owner-level overview: each active office's KPIs side by side. Lets
// the user compare Bettiah vs Muzaffarpur vs Motihari at a glance.
//
// Aggregation pivots on dealers.office_id (the dealer's tagged branch)
// — NOT users.home_office_id — so a Bettiah-based salesperson with a
// few Muzaffarpur dealers contributes those numbers to Muzaffarpur,
// not Bettiah. Salespersons' home_office is only used for the "staff"
// count of each office.
//
// Includes an "Unassigned" pseudo-row that captures every dealer
// without an office tag yet, so the total reconciles exactly with
// the dashboard's all-dealer outstanding figure.
router.get('/by-office', requireFeature('reports'), (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
  const to   = req.query.to   || new Date().toISOString().slice(0,10);
  // Active offices in display order: factory first, then office, warehouse.
  const offices = db.prepare(`SELECT id, code, name, type, city, state FROM locations WHERE active=1 ORDER BY CASE type WHEN 'factory' THEN 1 WHEN 'office' THEN 2 ELSE 3 END, name`).all();

  // One pass per office; the "Unassigned" row tacks on at the end with
  // officeId=null and uses IS NULL in the where-clauses.
  const buildRow = (officeId, label) => {
    // officeId === null → unassigned bucket
    const isUnassigned = officeId === null;
    const dealerFilter = isUnassigned ? 'd.office_id IS NULL' : 'd.office_id = ?';
    const invFilter    = isUnassigned
      ? "i.status!='cancelled' AND EXISTS(SELECT 1 FROM dealers d WHERE d.id=i.dealer_id AND d.office_id IS NULL)"
      : "i.status!='cancelled' AND EXISTS(SELECT 1 FROM dealers d WHERE d.id=i.dealer_id AND d.office_id = ?)";
    const payFilter    = isUnassigned
      ? "p.status='verified' AND EXISTS(SELECT 1 FROM dealers d WHERE d.id=p.dealer_id AND d.office_id IS NULL)"
      : "p.status='verified' AND EXISTS(SELECT 1 FROM dealers d WHERE d.id=p.dealer_id AND d.office_id = ?)";
    const retFilter    = isUnassigned
      ? "r.status IN ('approved','restocked') AND EXISTS(SELECT 1 FROM dealers d WHERE d.id=r.dealer_id AND d.office_id IS NULL)"
      : "r.status IN ('approved','restocked') AND EXISTS(SELECT 1 FROM dealers d WHERE d.id=r.dealer_id AND d.office_id = ?)";

    const args = isUnassigned ? [] : [officeId];
    const one = (sql, ...extra) => {
      const params = isUnassigned ? extra : [officeId, ...extra];
      return db.prepare(sql).get(...params).v || 0;
    };

    // Staff count uses users.home_office_id — the salespersons who
    // sit at this office, regardless of which dealers they sell to.
    const staff = isUnassigned
      ? db.prepare(`SELECT COUNT(*) AS v FROM users WHERE active=1 AND home_office_id IS NULL AND role IN ('salesperson','area_manager')`).get().v
      : db.prepare(`SELECT COUNT(*) AS v FROM users WHERE active=1 AND home_office_id=? AND role IN ('salesperson','area_manager')`).get(officeId).v;

    const dealersActive  = db.prepare(`SELECT COUNT(*) AS v FROM dealers d WHERE active=1 AND ${dealerFilter}`).get(...args).v;
    const dealersLocated = db.prepare(`SELECT COUNT(*) AS v FROM dealers d WHERE active=1 AND last_visit_lat IS NOT NULL AND ${dealerFilter}`).get(...args).v;
    const dealersOverLimit = db.prepare(`
      SELECT COUNT(*) AS v FROM dealers d
      WHERE active=1 AND credit_limit > 0 AND ${dealerFilter}
        AND (COALESCE(opening_balance,0)
             + COALESCE((SELECT SUM(total) FROM invoices WHERE dealer_id=d.id AND status!='cancelled'),0)
             - COALESCE((SELECT SUM(amount) FROM payments WHERE dealer_id=d.id AND status='verified'),0)
             - COALESCE((SELECT SUM(total_amount) FROM returns WHERE dealer_id=d.id AND status IN ('approved','restocked')),0)
            ) > credit_limit
    `).get(...args).v;

    // In-period sales: invoice count + total revenue + avg ticket.
    const salesAgg = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(i.total),0) AS v FROM invoices i WHERE ${invFilter} AND i.invoice_date BETWEEN ? AND ?`).get(...args, from, to);

    const row = {
      id: officeId,
      name: label,
      isUnassigned,
      staff,
      dealers_active:  dealersActive,
      dealers_located: dealersLocated,
      dealers_over_limit: dealersOverLimit,
      invoice_count_period: salesAgg.n || 0,
      sales_period:        salesAgg.v || 0,
      avg_invoice_period: salesAgg.n ? Math.round(salesAgg.v / salesAgg.n) : 0,
      sales_lifetime:    one(`SELECT COALESCE(SUM(i.total),0) AS v FROM invoices i WHERE ${invFilter}`),
      paid_period:       one(`SELECT COALESCE(SUM(p.amount),0) AS v FROM payments p WHERE ${payFilter} AND p.payment_date BETWEEN ? AND ?`, from, to),
      paid_lifetime:     one(`SELECT COALESCE(SUM(p.amount),0) AS v FROM payments p WHERE ${payFilter}`),
      returned_lifetime: one(`SELECT COALESCE(SUM(r.total_amount),0) AS v FROM returns r WHERE ${retFilter}`),
      // Outstanding = opening + lifetime billed − lifetime paid − lifetime returns,
      // computed dealer-by-dealer so each dealer reconciles to itself.
      outstanding: db.prepare(`
        SELECT COALESCE(SUM(
          COALESCE(d.opening_balance,0)
          + COALESCE((SELECT SUM(total) FROM invoices WHERE dealer_id=d.id AND status!='cancelled'),0)
          - COALESCE((SELECT SUM(amount) FROM payments WHERE dealer_id=d.id AND status='verified'),0)
          - COALESCE((SELECT SUM(total_amount) FROM returns WHERE dealer_id=d.id AND status IN ('approved','restocked')),0)
        ),0) AS v
        FROM dealers d WHERE ${dealerFilter}
      `).get(...args).v,
    };

    // Aging buckets — invoice-level. For each unpaid/partial invoice tied
    // to a dealer in this office bucket, classify the OPEN BALANCE
    // (total − paid_amount) by days since invoice_date.
    // 0-30 = current+near; 31-60 = warning; 60+ = chasing.
    const today = new Date().toISOString().slice(0,10);
    const ageRows = db.prepare(`
      SELECT i.invoice_date, (i.total - COALESCE(i.paid_amount,0)) AS open_balance
      FROM invoices i
      WHERE ${invFilter}
        AND i.status != 'paid'
        AND (i.total - COALESCE(i.paid_amount,0)) > 0
    `).all(...args);
    row.age_0_30 = 0; row.age_31_60 = 0; row.age_60_plus = 0;
    ageRows.forEach(a => {
      const days = Math.max(0, Math.floor((new Date(today) - new Date(a.invoice_date)) / 86400000));
      if (days <= 30) row.age_0_30 += a.open_balance;
      else if (days <= 60) row.age_31_60 += a.open_balance;
      else row.age_60_plus += a.open_balance;
    });

    return row;
  };

  // Office rows + Unassigned (only show Unassigned if it has any dealers).
  const rows = offices.map(o => {
    const r = buildRow(o.id, o.name);
    return Object.assign({}, o, r);
  });
  const unassigned = buildRow(null, 'Unassigned');
  if (unassigned.dealers_active > 0 || unassigned.outstanding !== 0 || unassigned.staff > 0) {
    unassigned.code = '—';
    unassigned.city = null;
    unassigned.type = 'unassigned';
    rows.push(unassigned);
  }

  // Totals across all rows (including Unassigned) — must match dashboard.
  const totals = rows.reduce((acc, r) => {
    ['staff','dealers_active','dealers_located','dealers_over_limit','invoice_count_period',
     'sales_period','sales_lifetime','paid_period','paid_lifetime','returned_lifetime',
     'outstanding','age_0_30','age_31_60','age_60_plus']
      .forEach(k => acc[k] = (acc[k]||0) + (r[k]||0));
    return acc;
  }, {});
  totals.avg_invoice_period = totals.invoice_count_period
    ? Math.round(totals.sales_period / totals.invoice_count_period) : 0;

  // Sanity reconciliation: grand total of outstanding across rows must
  // match the all-dealer outstanding. Surfaced in the UI as a small
  // green tick / red badge so the owner spots drift instantly.
  const allDealerOutstanding = db.prepare(`
    SELECT COALESCE(SUM(
      COALESCE(d.opening_balance,0)
      + COALESCE((SELECT SUM(total) FROM invoices WHERE dealer_id=d.id AND status!='cancelled'),0)
      - COALESCE((SELECT SUM(amount) FROM payments WHERE dealer_id=d.id AND status='verified'),0)
      - COALESCE((SELECT SUM(total_amount) FROM returns WHERE dealer_id=d.id AND status IN ('approved','restocked')),0)
    ),0) AS v FROM dealers d
  `).get().v;
  const reconcileOk = Math.abs(totals.outstanding - allDealerOutstanding) < 1;

  res.render('reports/byOffice', { title: 'By Office', rows, totals, from, to, allDealerOutstanding, reconcileOk });
});

// Daily Production
router.get('/production', (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0,10);
  const rows = db.prepare(`
    SELECT pse.stage, p.code AS product_code, p.name AS product_name,
           SUM(pse.qty_in) AS qty_in, SUM(pse.qty_out) AS qty_out, SUM(pse.qty_rejected) AS qty_rej, SUM(pse.total_cost) AS total_cost
    FROM production_stage_entries pse
    JOIN production_batches b ON b.id = pse.batch_id
    JOIN products p ON p.id = b.product_id
    WHERE pse.entry_date = ?
    GROUP BY pse.stage, p.id
    ORDER BY p.name, pse.stage
  `).all(date);
  res.render('reports/production', { title: 'Daily Production Report', rows, date });
});

// Daily Sales / Salesperson
router.get('/sales', (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);
  const daily = db.prepare(`
    SELECT invoice_date AS d, COUNT(*) AS n, SUM(total) AS total
    FROM invoices WHERE invoice_date BETWEEN ? AND ? AND status != 'cancelled'
    GROUP BY invoice_date ORDER BY invoice_date DESC
  `).all(from, to);
  const spScope = spIdScope(req);
  const sp = db.prepare(`
    SELECT u.name, COUNT(i.id) AS invoices, COALESCE(SUM(i.total),0) AS total, COALESCE(SUM(i.paid_amount),0) AS paid
    FROM users u LEFT JOIN invoices i ON i.salesperson_id = u.id AND i.invoice_date BETWEEN ? AND ? AND i.status != 'cancelled'
    WHERE u.role = 'salesperson' AND u.active = 1${spScope.clause}
    GROUP BY u.id ORDER BY total DESC
  `).all(from, to, ...spScope.params);
  res.render('reports/sales', { title: 'Sales Report', daily, sp, from, to });
});

// Daily Collection
router.get('/collection', (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);
  // Optional single-day drilldown (?day=YYYY-MM-DD) — when set, the
  // "By Salesperson" panel narrows to just that date instead of the full range.
  const day = (req.query.day || '').match(/^\d{4}-\d{2}-\d{2}$/) ? req.query.day : '';
  const daily = db.prepare(`
    SELECT payment_date AS d, COUNT(*) AS n, SUM(amount) AS total
    FROM payments WHERE payment_date BETWEEN ? AND ? AND status='verified'
    GROUP BY payment_date ORDER BY payment_date DESC
  `).all(from, to);
  const spScope2 = spIdScope(req);
  let bySp;
  if (day) {
    bySp = db.prepare(`
      SELECT u.name, COUNT(p.id) AS pmts, COALESCE(SUM(p.amount),0) AS total
      FROM users u LEFT JOIN payments p ON p.salesperson_id=u.id AND p.payment_date = ? AND p.status='verified'
      WHERE u.role = 'salesperson' AND u.active = 1${spScope2.clause}
      GROUP BY u.id ORDER BY total DESC
    `).all(day, ...spScope2.params);
  } else {
    bySp = db.prepare(`
      SELECT u.name, COUNT(p.id) AS pmts, COALESCE(SUM(p.amount),0) AS total
      FROM users u LEFT JOIN payments p ON p.salesperson_id=u.id AND p.payment_date BETWEEN ? AND ? AND p.status='verified'
      WHERE u.role = 'salesperson' AND u.active = 1${spScope2.clause}
      GROUP BY u.id ORDER BY total DESC
    `).all(from, to, ...spScope2.params);
  }
  res.render('reports/collection', { title: 'Collection Report', daily, bySp, from, to, day });
});

// Outstanding
router.get('/outstanding', (req, res) => {
  // "paid" sums verified payments — see src/routes/dealers.js for why.
  // "returned" sums approved/restocked returns — they reduce outstanding.
  // Team scope: area_manager sees only their team's dealers, salesperson
  // sees only their own; full-visibility roles see all.
  // Phase 3: optional office filter on top, narrows to dealers whose
  // salesperson belongs to the chosen office.
  const ids = getScopeUserIds(req);
  const officeFilter = req.query.office ? parseInt(req.query.office) : null;
  const officeUserIds = officeFilter ? userIdsForOffice(officeFilter) : null;
  let outSql = `
    SELECT d.id, d.code, d.name, d.phone, d.city, d.credit_limit, d.opening_balance, u.name AS sp_name,
      COALESCE((SELECT SUM(total)  FROM invoices WHERE dealer_id=d.id AND status!='cancelled'),0) AS billed,
      COALESCE((SELECT SUM(amount) FROM payments WHERE dealer_id=d.id AND status='verified'),0) AS paid,
      COALESCE((SELECT SUM(total_amount) FROM returns  WHERE dealer_id=d.id AND status IN ('approved','restocked')),0) AS returned
    FROM dealers d LEFT JOIN users u ON u.id=d.salesperson_id
    WHERE d.active = 1`;
  const outParams = [];
  if (ids !== null) {
    outSql += ' AND d.salesperson_id IN (' + ids.map(() => '?').join(',') + ')';
    outParams.push(...ids);
  }
  if (officeUserIds !== null) {
    if (officeUserIds.length === 0) { outSql += ' AND 0=1'; }
    else { outSql += ' AND d.salesperson_id IN (' + officeUserIds.map(() => '?').join(',') + ')'; outParams.push(...officeUserIds); }
  }
  const rows = db.prepare(outSql).all(...outParams);
  const officesList = visibleOffices(req);
  const officeName = officeFilter ? (officesList.find(o => o.id === officeFilter)?.name || null) : null;
  rows.forEach(r => r.outstanding = (r.opening_balance||0) + r.billed - r.paid - (r.returned||0));
  rows.sort((a,b) => b.outstanding - a.outstanding);
  const totalOut = rows.reduce((s,r) => s + r.outstanding, 0);
  res.render('reports/outstanding', { title: 'Outstanding Report', rows, totalOut, officesList, officeFilter, officeName });
});

// Stock
router.get('/stock', (req, res) => {
  const rows = db.prepare(`
    SELECT p.code, p.name, p.size, p.color, p.unit, p.reorder_level, p.cost_price, p.sale_price,
           COALESCE(rs.quantity,0) AS qty
    FROM products p LEFT JOIN ready_stock_total rs ON rs.product_id=p.id
    WHERE p.active=1 ORDER BY p.name
  `).all();
  const totalQty = rows.reduce((s,r) => s + r.qty, 0);
  const totalValue = rows.reduce((s,r) => s + (r.qty * r.cost_price), 0);
  res.render('reports/stock', { title: 'Stock Report', rows, totalQty, totalValue });
});

// Dealer-wise sales drilldown
router.get('/dealer-sales', (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);
  const rows = db.prepare(`
    SELECT d.id, d.code, d.name, d.city, d.state, u.name AS sp_name,
           COUNT(i.id) AS invoices,
           COALESCE(SUM(i.total),0) AS billed,
           COALESCE(SUM(i.paid_amount),0) AS paid,
           COALESCE(SUM(i.total - i.paid_amount),0) AS balance
    FROM dealers d
    LEFT JOIN invoices i ON i.dealer_id = d.id AND i.invoice_date BETWEEN ? AND ? AND i.status != 'cancelled'
    LEFT JOIN users u ON u.id = d.salesperson_id
    WHERE d.active = 1
    GROUP BY d.id
    HAVING invoices > 0
    ORDER BY billed DESC
  `).all(from, to);
  const totalBilled = rows.reduce((s,r) => s + r.billed, 0);
  const totalPaid = rows.reduce((s,r) => s + r.paid, 0);
  res.render('reports/dealerSales', { title: 'Dealer-wise Sales', rows, from, to, totalBilled, totalPaid });
});

// Product-wise sales drilldown
router.get('/product-sales', (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);
  const rows = db.prepare(`
    SELECT p.id, p.code, p.name, p.size, p.color, p.category_id, c.name AS category_name,
           COALESCE(SUM(ii.quantity),0) AS qty_sold,
           COALESCE(SUM(ii.amount),0) AS revenue,
           COALESCE(rs.quantity, 0) AS stock_now
    FROM products p
    LEFT JOIN invoice_items ii ON ii.product_id = p.id
    LEFT JOIN invoices i ON i.id = ii.invoice_id AND i.invoice_date BETWEEN ? AND ? AND i.status != 'cancelled'
    LEFT JOIN ready_stock_total rs ON rs.product_id = p.id
    LEFT JOIN product_categories c ON c.id = p.category_id
    WHERE p.active = 1
    GROUP BY p.id
    HAVING qty_sold > 0
    ORDER BY revenue DESC
  `).all(from, to);
  const totalQty = rows.reduce((s,r) => s + r.qty_sold, 0);
  const totalRev = rows.reduce((s,r) => s + r.revenue, 0);
  res.render('reports/productSales', { title: 'Product-wise Sales', rows, from, to, totalQty, totalRev });
});

// Payment mode breakdown
router.get('/payment-modes', (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);
  const rows = db.prepare(`
    SELECT pm.name AS mode, COUNT(p.id) AS txns, COALESCE(SUM(p.amount),0) AS total
    FROM payment_modes pm
    LEFT JOIN payments p ON p.payment_mode_id = pm.id AND p.payment_date BETWEEN ? AND ? AND p.status='verified'
    GROUP BY pm.id
    ORDER BY total DESC
  `).all(from, to);
  const grand = rows.reduce((s,r) => s + r.total, 0);
  res.render('reports/paymentModes', { title: 'Payment Mode Breakdown', rows, from, to, grand });
});

// Aged outstanding (0-30, 31-60, 61-90, 90+)
router.get('/aged-outstanding', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT d.id, d.code, d.name, d.phone, d.salesperson_id, u.name AS sp_name,
           i.id AS invoice_id, i.invoice_no, i.invoice_date, i.total, i.paid_amount,
           (i.total - i.paid_amount) AS balance,
           CAST(julianday(?) - julianday(i.invoice_date) AS INTEGER) AS days
    FROM invoices i
    JOIN dealers d ON d.id = i.dealer_id
    LEFT JOIN users u ON u.id = d.salesperson_id
    WHERE i.status IN ('unpaid','partial')
    ORDER BY days DESC
  `).all(today);
  const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  rows.forEach(r => {
    if (r.days <= 30) buckets['0-30'] += r.balance;
    else if (r.days <= 60) buckets['31-60'] += r.balance;
    else if (r.days <= 90) buckets['61-90'] += r.balance;
    else buckets['90+'] += r.balance;
  });
  const total = rows.reduce((s,r) => s + r.balance, 0);
  res.render('reports/agedOutstanding', { title: 'Aged Outstanding', rows, buckets, total });
});

// Production efficiency by stage
router.get('/production-efficiency', (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);
  const rows = db.prepare(`
    SELECT pse.stage, COUNT(*) AS entries,
           SUM(pse.qty_in) AS total_in,
           SUM(pse.qty_out) AS total_out,
           SUM(pse.qty_rejected) AS total_rejected,
           SUM(pse.total_cost) AS total_cost,
           CASE WHEN SUM(pse.qty_in) > 0 THEN ROUND(100.0 * SUM(pse.qty_out) / SUM(pse.qty_in), 1) ELSE 0 END AS yield_pct
    FROM production_stage_entries pse
    WHERE pse.entry_date BETWEEN ? AND ?
    GROUP BY pse.stage
    ORDER BY total_out DESC
  `).all(from, to);
  res.render('reports/productionEfficiency', { title: 'Production Efficiency', rows, from, to });
});

// Raw material consumption
router.get('/material-consumption', (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);
  const rows = db.prepare(`
    SELECT rm.id, rm.code, rm.name, rm.unit, rm.current_stock, rm.cost_per_unit,
           COALESCE(SUM(CASE WHEN t.txn_type='purchase' THEN t.quantity ELSE 0 END), 0) AS purchased,
           COALESCE(SUM(CASE WHEN t.txn_type='issue'    THEN t.quantity ELSE 0 END), 0) AS issued,
           COALESCE(SUM(CASE WHEN t.txn_type='purchase' THEN t.total_amount ELSE 0 END), 0) AS purchase_value,
           COALESCE(SUM(CASE WHEN t.txn_type='issue'    THEN t.total_amount ELSE 0 END), 0) AS issued_value
    FROM raw_materials rm
    LEFT JOIN raw_material_txns t ON t.raw_material_id = rm.id AND t.created_at BETWEEN ? AND datetime(?, '+1 day')
    WHERE rm.active = 1
    GROUP BY rm.id
    ORDER BY issued DESC, purchased DESC
  `).all(from, to);
  res.render('reports/materialConsumption', { title: 'Raw Material Consumption', rows, from, to });
});

// Salesperson detailed performance
router.get('/salesperson-detail', (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);
  // A dealer's transactions and outstanding belong to whichever salesperson is
  // currently assigned to that dealer. So:
  //   - In-period metrics (sales / collected / verified / pending) = SUM over
  //     this user's assigned dealers, filtered by the date range.
  //   - Outstanding is an ALL-TIME snapshot (no date filter) because that's
  //     what's actually owed today: opening_balance + every non-cancelled
  //     invoice ever - every verified payment ever, summed over the assigned
  //     dealers. Matches the formula used on the dealer list / dashboard KPI.
  const rows = db.prepare(`
    SELECT u.id, u.name,
      (SELECT COUNT(*) FROM dealers d
         WHERE d.salesperson_id = u.id AND d.active = 1) AS dealers_assigned,
      -- In-period invoice metrics for the assigned dealers
      (SELECT COUNT(*) FROM invoices i
         JOIN dealers d ON d.id = i.dealer_id
         WHERE d.salesperson_id = u.id AND d.active = 1
           AND i.invoice_date BETWEEN ? AND ?
           AND i.status != 'cancelled') AS invoices_count,
      COALESCE((SELECT SUM(i.total) FROM invoices i
         JOIN dealers d ON d.id = i.dealer_id
         WHERE d.salesperson_id = u.id AND d.active = 1
           AND i.invoice_date BETWEEN ? AND ?
           AND i.status != 'cancelled'), 0) AS sales_total,
      -- In-period payment metrics for the assigned dealers
      (SELECT COUNT(*) FROM payments p
         JOIN dealers d ON d.id = p.dealer_id
         WHERE d.salesperson_id = u.id AND d.active = 1
           AND p.payment_date BETWEEN ? AND ?) AS payments_count,
      COALESCE((SELECT SUM(p.amount) FROM payments p
         JOIN dealers d ON d.id = p.dealer_id
         WHERE d.salesperson_id = u.id AND d.active = 1
           AND p.payment_date BETWEEN ? AND ?
           AND p.status = 'verified'), 0) AS verified_amount,
      COALESCE((SELECT SUM(p.amount) FROM payments p
         JOIN dealers d ON d.id = p.dealer_id
         WHERE d.salesperson_id = u.id AND d.active = 1
           AND p.payment_date BETWEEN ? AND ?
           AND p.status = 'pending'), 0) AS pending_amount,
      COALESCE((SELECT SUM(p.amount) FROM payments p
         JOIN dealers d ON d.id = p.dealer_id
         WHERE d.salesperson_id = u.id AND d.active = 1
           AND p.payment_date BETWEEN ? AND ?
           AND p.status IN ('verified','pending')), 0) AS collected,
      -- Outstanding (all-time snapshot, NOT filtered by date):
      --   opening_balance + lifetime billed - lifetime verified payments
      --                                      - lifetime approved returns
      -- summed across this user's currently-assigned dealers.
      (
        COALESCE((SELECT SUM(d.opening_balance) FROM dealers d
           WHERE d.salesperson_id = u.id AND d.active = 1), 0)
        + COALESCE((SELECT SUM(i.total) FROM invoices i
           JOIN dealers d ON d.id = i.dealer_id
           WHERE d.salesperson_id = u.id AND d.active = 1
             AND i.status != 'cancelled'), 0)
        - COALESCE((SELECT SUM(p.amount) FROM payments p
           JOIN dealers d ON d.id = p.dealer_id
           WHERE d.salesperson_id = u.id AND d.active = 1
             AND p.status = 'verified'), 0)
        - COALESCE((SELECT SUM(r.total_amount) FROM returns r
           JOIN dealers d ON d.id = r.dealer_id
           WHERE d.salesperson_id = u.id AND d.active = 1
             AND r.status IN ('approved','restocked')), 0)
      ) AS outstanding,
      -- All-time verified payments on the assigned dealers — denominator
      -- for the collection % so the bar represents "how much of the lifetime
      -- receivable position has been collected" instead of in-period ratio.
      COALESCE((SELECT SUM(p.amount) FROM payments p
         JOIN dealers d ON d.id = p.dealer_id
         WHERE d.salesperson_id = u.id AND d.active = 1
           AND p.status = 'verified'), 0) AS lifetime_verified
    FROM users u
    WHERE u.role = 'salesperson' AND u.active = 1${(() => { const s = spIdScope(req); return s.clause; })()}
    ORDER BY sales_total DESC
  `).all(
    from, to,    // invoices_count
    from, to,    // sales_total
    from, to,    // payments_count
    from, to,    // verified_amount
    from, to,    // pending_amount
    from, to,    // collected
    ...spIdScope(req).params
    // outstanding subqueries use no date params (all-time)
  );
  res.render('reports/salespersonDetail', { title: 'Salesperson Performance Detail', rows, from, to });
});

// Deep detail for ONE salesperson — every assigned dealer, lifetime + period
// metrics, recent invoices / payments / visits / factory log. Linked from
// the Salesperson Performance Detail table by clicking a name.
router.get('/salesperson/:id', (req, res) => {
  const u = db.prepare(`SELECT id, name, email, phone, role, active, created_at FROM users WHERE id = ?`).get(req.params.id);
  if (!u) return res.redirect('/reports/salesperson-detail');
  // Area manager can only drill into their own team. Owner/admin pass through.
  const scopeIds = getScopeUserIds(req);
  if (scopeIds !== null && !scopeIds.includes(u.id)) {
    return res.redirect('/reports/salesperson-detail');
  }
  const from = req.query.from || new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);

  // All assigned dealers with their per-dealer breakdown. We include
  // INACTIVE dealers too (with a flag) — otherwise an owner who has just
  // re-assigned an old/deactivated customer to this salesperson thinks the
  // assignment didn't save. The view groups active first, inactive after,
  // and tags inactive ones visually.
  const dealers = db.prepare(`
    SELECT d.id, d.code, d.name, d.city, d.state, d.phone, d.opening_balance, d.active,
      COALESCE((SELECT SUM(i.total) FROM invoices i WHERE i.dealer_id = d.id AND i.status != 'cancelled'), 0) AS billed_lifetime,
      COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.dealer_id = d.id AND p.status = 'verified'), 0) AS paid_lifetime,
      COALESCE((SELECT SUM(r.total_amount) FROM returns r WHERE r.dealer_id = d.id AND r.status IN ('approved','restocked')), 0) AS returned_lifetime,
      COALESCE((SELECT SUM(i.total) FROM invoices i WHERE i.dealer_id = d.id AND i.status != 'cancelled' AND i.invoice_date BETWEEN ? AND ?), 0) AS billed_period,
      COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.dealer_id = d.id AND p.status = 'verified' AND p.payment_date BETWEEN ? AND ?), 0) AS paid_period,
      d.last_visit_at
    FROM dealers d
    WHERE d.salesperson_id = ?
    ORDER BY d.active DESC,
             (COALESCE(d.opening_balance, 0)
              + COALESCE((SELECT SUM(i.total) FROM invoices i WHERE i.dealer_id = d.id AND i.status != 'cancelled'), 0)
              - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.dealer_id = d.id AND p.status = 'verified'), 0)
              - COALESCE((SELECT SUM(r.total_amount) FROM returns r WHERE r.dealer_id = d.id AND r.status IN ('approved','restocked')), 0)) DESC,
             d.name
  `).all(from, to, from, to, u.id);
  dealers.forEach(d => {
    d.outstanding = (d.opening_balance || 0) + d.billed_lifetime - d.paid_lifetime - (d.returned_lifetime || 0);
  });

  // Aggregates (used for the KPI cards) — match the list-page formulas.
  // dealers_active vs dealers_inactive split lets the view show both
  // counts so the owner sees "5 active + 12 deactivated" instead of
  // wondering why the assignment isn't reflected.
  const totals = {
    dealers: dealers.length,
    dealers_active: dealers.filter(d => d.active).length,
    dealers_inactive: dealers.filter(d => !d.active).length,
    dealers_with_outstanding: dealers.filter(d => d.outstanding > 0).length,
    opening_balance:   dealers.reduce((s, d) => s + (d.opening_balance || 0), 0),
    billed_lifetime:   dealers.reduce((s, d) => s + d.billed_lifetime, 0),
    paid_lifetime:     dealers.reduce((s, d) => s + d.paid_lifetime, 0),
    returned_lifetime: dealers.reduce((s, d) => s + (d.returned_lifetime || 0), 0),
    sales_period:      dealers.reduce((s, d) => s + d.billed_period, 0),
    paid_period:       dealers.reduce((s, d) => s + d.paid_period, 0),
  };
  totals.outstanding_total = totals.opening_balance + totals.billed_lifetime - totals.paid_lifetime - (totals.returned_lifetime || 0);
  totals.collection_pct = (totals.paid_lifetime + totals.outstanding_total) > 0
    ? Math.round((totals.paid_lifetime * 100) / (totals.paid_lifetime + totals.outstanding_total))
    : 0;

  // Recent invoices on the salesperson's assigned dealers (any creator).
  const invoices = db.prepare(`
    SELECT i.id, i.invoice_no, i.invoice_date, i.total, i.paid_amount, i.status,
           d.code AS dealer_code, d.name AS dealer_name
    FROM invoices i JOIN dealers d ON d.id = i.dealer_id
    WHERE d.salesperson_id = ? AND d.active = 1
    ORDER BY i.invoice_date DESC, i.id DESC LIMIT 20
  `).all(u.id);

  // Recent payments on the salesperson's assigned dealers.
  const payments = db.prepare(`
    SELECT p.id, p.payment_no, p.payment_date, p.amount, p.status,
           d.code AS dealer_code, d.name AS dealer_name,
           pm.name AS mode
    FROM payments p JOIN dealers d ON d.id = p.dealer_id
    LEFT JOIN payment_modes pm ON pm.id = p.payment_mode_id
    WHERE d.salesperson_id = ? AND d.active = 1
    ORDER BY p.payment_date DESC, p.id DESC LIMIT 20
  `).all(u.id);

  // Field visits by this user (their own, scoped by user not dealer assignment).
  const visits = db.prepare(`
    SELECT v.id, v.visit_no, v.visit_type, v.created_at, v.photo_path, v.lat, v.lng,
           d.code AS dealer_code, d.name AS dealer_name, v.prospect_shop, v.prospect_name
    FROM dealer_visits v LEFT JOIN dealers d ON d.id = v.dealer_id
    WHERE v.salesperson_id = ?
    ORDER BY v.id DESC LIMIT 15
  `).all(u.id);

  // Today's factory in/out (if any), so the page can show attendance state.
  const todayStr = new Date().toISOString().slice(0,10);
  const factoryToday = {
    in:  db.prepare("SELECT created_at, photo_path FROM factory_logs WHERE salesperson_id=? AND log_date=? AND log_type='in'").get(u.id, todayStr),
    out: db.prepare("SELECT created_at, photo_path FROM factory_logs WHERE salesperson_id=? AND log_date=? AND log_type='out'").get(u.id, todayStr),
  };

  res.render('reports/salespersonOne', {
    title: 'Salesperson: ' + u.name,
    u, from, to, dealers, totals, invoices, payments, visits, factoryToday,
  });
});

// City/State geographic sales heatmap
router.get('/geo-sales', (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);
  const rows = db.prepare(`
    SELECT COALESCE(d.state, 'Unknown') AS state, COALESCE(d.city, 'Unknown') AS city,
           COUNT(DISTINCT d.id) AS dealer_count,
           COUNT(DISTINCT i.id) AS invoice_count,
           COALESCE(SUM(i.total), 0) AS revenue
    FROM dealers d
    LEFT JOIN invoices i ON i.dealer_id = d.id AND i.invoice_date BETWEEN ? AND ? AND i.status != 'cancelled'
    WHERE d.active = 1
    GROUP BY d.state, d.city
    HAVING revenue > 0
    ORDER BY revenue DESC
  `).all(from, to);
  res.render('reports/geoSales', { title: 'Geographic Sales', rows, from, to });
});

// Product performance — slow / fast moving
router.get('/product-performance', (req, res) => {
  const days = parseInt(req.query.days || 30);
  const since = new Date(Date.now() - days*86400000).toISOString().slice(0,10);
  const rows = db.prepare(`
    SELECT p.id, p.code, p.name,
      COALESCE(SUM(ii.quantity), 0) AS sold,
      COALESCE(rs.quantity, 0) AS stock,
      COALESCE(SUM(ii.amount), 0) AS revenue
    FROM products p
    LEFT JOIN invoice_items ii ON ii.product_id = p.id
    LEFT JOIN invoices i ON i.id = ii.invoice_id AND i.invoice_date >= ? AND i.status != 'cancelled'
    LEFT JOIN ready_stock_total rs ON rs.product_id = p.id
    WHERE p.active = 1
    GROUP BY p.id
    ORDER BY sold DESC
  `).all(since);
  const top = rows.slice(0, 20);
  const slow = [...rows].filter(r => r.sold === 0).slice(0, 20);
  res.render('reports/productPerformance', { title: 'Product Performance', top, slow, days });
});

// ─── Dealer Account Statement (ledger with running balance) ─────
// THE micro-level document: opening balance + every invoice, verified
// payment, and approved return for one dealer over a range, in
// chronological order with a running balance. Printable on the
// company letterhead so it can be emailed straight to the dealer.
router.get('/dealer-statement', requireFeature('reports'), (req, res) => {
  const dealers = db.prepare('SELECT id, code, name, city FROM dealers ORDER BY active DESC, name').all();
  const dealerId = req.query.dealer_id ? parseInt(req.query.dealer_id) : null;
  const from = req.query.from || new Date(Date.now() - 90*86400000).toISOString().slice(0,10);
  const to   = req.query.to   || new Date().toISOString().slice(0,10);

  let dealer = null, txns = [], opening = 0, closing = 0, totals = { debit: 0, credit: 0 };
  if (dealerId) {
    dealer = db.prepare('SELECT d.*, u.name AS sp_name FROM dealers d LEFT JOIN users u ON u.id=d.salesperson_id WHERE d.id=?').get(dealerId);
    if (dealer) {
      // Opening balance at `from` = dealer.opening_balance
      //   + invoices before from − verified payments before from − approved returns before from.
      opening = (dealer.opening_balance || 0)
        + db.prepare(`SELECT COALESCE(SUM(total),0)        AS v FROM invoices WHERE dealer_id=? AND status!='cancelled' AND invoice_date < ?`).get(dealerId, from).v
        - db.prepare(`SELECT COALESCE(SUM(amount),0)       AS v FROM payments WHERE dealer_id=? AND status='verified' AND payment_date < ?`).get(dealerId, from).v
        - db.prepare(`SELECT COALESCE(SUM(total_amount),0) AS v FROM returns  WHERE dealer_id=? AND status IN ('approved','restocked') AND return_date < ?`).get(dealerId, from).v;

      // In-range transactions, merged + sorted. Debit = dealer owes more
      // (invoice); Credit = dealer owes less (payment / return credit note).
      const inv = db.prepare(`SELECT invoice_date AS d, 'invoice' AS kind, invoice_no AS ref, id, total AS debit, 0 AS credit, status FROM invoices WHERE dealer_id=? AND status!='cancelled' AND invoice_date BETWEEN ? AND ?`).all(dealerId, from, to);
      const pay = db.prepare(`SELECT p.payment_date AS d, 'payment' AS kind, p.payment_no AS ref, p.id, 0 AS debit, p.amount AS credit, pm.name AS mode FROM payments p LEFT JOIN payment_modes pm ON pm.id=p.payment_mode_id WHERE p.dealer_id=? AND p.status='verified' AND p.payment_date BETWEEN ? AND ?`).all(dealerId, from, to);
      const ret = db.prepare(`SELECT return_date AS d, 'return' AS kind, return_no AS ref, id, 0 AS debit, total_amount AS credit, status FROM returns WHERE dealer_id=? AND status IN ('approved','restocked') AND return_date BETWEEN ? AND ?`).all(dealerId, from, to);
      txns = [...inv, ...pay, ...ret].sort((a, b) => a.d.localeCompare(b.d) || a.id - b.id);

      let bal = opening;
      txns.forEach(t => {
        bal += t.debit - t.credit;
        t.balance = bal;
        totals.debit  += t.debit;
        totals.credit += t.credit;
      });
      closing = bal;
    }
  }
  res.render('reports/dealerStatement', { title: 'Dealer Statement', dealers, dealer, dealerId, from, to, opening, closing, txns, totals });
});

// ─── GST Summary (output tax for the CA) ────────────────────────
// Monthly CGST/SGST/IGST from invoices, minus credit notes (approved
// returns), plus a per-rate-slab breakdown computed from invoice items.
router.get('/gst', requireFeature('reports'), (req, res) => {
  const from = req.query.from || (new Date().toISOString().slice(0,7) + '-01');
  const to   = req.query.to   || new Date().toISOString().slice(0,10);

  // Monthly rollup — invoices add tax, returns (credit notes) subtract.
  const invMonths = db.prepare(`
    SELECT strftime('%Y-%m', invoice_date) AS m,
           COUNT(*) AS n, COALESCE(SUM(subtotal),0) AS taxable,
           COALESCE(SUM(cgst),0) AS cgst, COALESCE(SUM(sgst),0) AS sgst, COALESCE(SUM(igst),0) AS igst,
           COALESCE(SUM(total),0) AS total
    FROM invoices WHERE status!='cancelled' AND invoice_date BETWEEN ? AND ?
    GROUP BY m ORDER BY m
  `).all(from, to);
  const retMonths = db.prepare(`
    SELECT strftime('%Y-%m', return_date) AS m,
           COUNT(*) AS n, COALESCE(SUM(subtotal),0) AS taxable,
           COALESCE(SUM(cgst),0) AS cgst, COALESCE(SUM(sgst),0) AS sgst, COALESCE(SUM(igst),0) AS igst,
           COALESCE(SUM(total_amount),0) AS total
    FROM returns WHERE status IN ('approved','restocked') AND return_date BETWEEN ? AND ?
    GROUP BY m ORDER BY m
  `).all(from, to);
  const retByMonth = new Map(retMonths.map(r => [r.m, r]));
  const months = invMonths.map(im => {
    const rm = retByMonth.get(im.m) || { n:0, taxable:0, cgst:0, sgst:0, igst:0, total:0 };
    return {
      m: im.m, inv_n: im.n, ret_n: rm.n,
      taxable: im.taxable - rm.taxable,
      cgst: im.cgst - rm.cgst, sgst: im.sgst - rm.sgst, igst: im.igst - rm.igst,
      net_tax: (im.cgst + im.sgst + im.igst) - (rm.cgst + rm.sgst + rm.igst),
      total: im.total - rm.total,
    };
  });
  // Months that ONLY have returns (no invoices) still need a row.
  retMonths.forEach(rm => {
    if (!invMonths.find(im => im.m === rm.m)) {
      months.push({ m: rm.m, inv_n: 0, ret_n: rm.n, taxable: -rm.taxable, cgst: -rm.cgst, sgst: -rm.sgst, igst: -rm.igst, net_tax: -(rm.cgst+rm.sgst+rm.igst), total: -rm.total });
    }
  });
  months.sort((a,b) => a.m.localeCompare(b.m));

  // Rate-slab breakdown from invoice line items (0% / 5% / 12% / 18% / 28%).
  const slabs = db.prepare(`
    SELECT ii.gst_rate AS rate, COUNT(*) AS lines,
           COALESCE(SUM(ii.amount),0) AS taxable,
           COALESCE(SUM(ii.amount * ii.gst_rate / 100.0),0) AS tax
    FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id
    WHERE i.status!='cancelled' AND i.invoice_date BETWEEN ? AND ?
    GROUP BY ii.gst_rate ORDER BY ii.gst_rate
  `).all(from, to);

  const totals = months.reduce((a, r) => {
    a.taxable += r.taxable; a.cgst += r.cgst; a.sgst += r.sgst; a.igst += r.igst;
    a.net_tax += r.net_tax; a.total += r.total; a.inv_n += r.inv_n; a.ret_n += r.ret_n;
    return a;
  }, { taxable:0, cgst:0, sgst:0, igst:0, net_tax:0, total:0, inv_n:0, ret_n:0 });

  res.render('reports/gst', { title: 'GST Summary', months, slabs, totals, from, to });
});

// ─── Invoice Register (micro: one row per invoice, GST split) ────
router.get('/invoice-register', requireFeature('reports'), (req, res) => {
  const from = req.query.from || (new Date().toISOString().slice(0,7) + '-01');
  const to   = req.query.to   || new Date().toISOString().slice(0,10);
  const status = req.query.status || 'all';
  const params = [from, to];
  let where = `i.invoice_date BETWEEN ? AND ?`;
  if (status === 'cancelled') { where += ` AND i.status='cancelled'`; }
  else if (status !== 'all')  { where += ` AND i.status=? AND i.status!='cancelled'`; params.push(status); }
  else                        { where += ` AND i.status!='cancelled'`; }
  const rows = db.prepare(`
    SELECT i.*, d.name AS dealer_name, d.gstin AS dealer_gstin, d.city AS dealer_city, u.name AS sp_name
    FROM invoices i JOIN dealers d ON d.id=i.dealer_id LEFT JOIN users u ON u.id=i.salesperson_id
    WHERE ${where}
    ORDER BY i.invoice_date, i.id
  `).all(...params);
  const totals = rows.reduce((a, r) => {
    a.subtotal += r.subtotal; a.cgst += r.cgst; a.sgst += r.sgst; a.igst += r.igst;
    a.total += r.total; a.paid += r.paid_amount;
    return a;
  }, { subtotal:0, cgst:0, sgst:0, igst:0, total:0, paid:0 });
  res.render('reports/invoiceRegister', { title: 'Invoice Register', rows, totals, from, to, status });
});

// ============================================================
//  Leadership & Strategy reports (founder-grade)
// ============================================================
const _today = () => new Date().toISOString().slice(0, 10);
const _ago = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
const _v = (q, ...p) => db.prepare(q).get(...p).v;
// Cost of one SOLD unit: for a bundle SKU it's auto-derived from the member
// pieces (Σ qty × piece cost); for a normal product it's its own cost price.
const EFFECTIVE_COST = `CASE WHEN p.is_bundle_sku=1
  THEN COALESCE((SELECT SUM(bc.qty*mp.cost_price) FROM product_bundle_components bc JOIN products mp ON mp.id=bc.member_product_id WHERE bc.bundle_product_id=p.id),0)
  ELSE p.cost_price END`;

// Owner's Snapshot — a one-page CEO pulse of the whole business.
router.get('/snapshot', (req, res) => {
  const today = _today(), mStart = today.slice(0, 8) + '01';
  const monthBilled = _v("SELECT COALESCE(SUM(total),0) v FROM invoices WHERE status!='cancelled' AND invoice_date>=?", mStart);
  const monthColl   = _v("SELECT COALESCE(SUM(amount),0) v FROM payments WHERE status='verified' AND payment_date>=?", mStart);
  const todayBilled = _v("SELECT COALESCE(SUM(total),0) v FROM invoices WHERE status!='cancelled' AND invoice_date=?", today);
  const todayColl   = _v("SELECT COALESCE(SUM(amount),0) v FROM payments WHERE status='verified' AND payment_date=?", today);
  const outstanding = _v("SELECT COALESCE(SUM(opening_balance),0) v FROM dealers WHERE active=1")
    + _v("SELECT COALESCE(SUM(total),0) v FROM invoices WHERE status!='cancelled'")
    - _v("SELECT COALESCE(SUM(amount),0) v FROM payments WHERE status='verified'")
    - _v("SELECT COALESCE(SUM(total_amount),0) v FROM returns WHERE status IN ('approved','restocked')");
  const ageing = { d030: 0, d3160: 0, d6190: 0, d90: 0 };
  db.prepare("SELECT (total-paid_amount) bal, CAST(julianday('now')-julianday(invoice_date) AS INT) age FROM invoices WHERE status IN ('unpaid','partial')").all()
    .forEach(r => { const b = r.bal || 0; if (r.age <= 30) ageing.d030 += b; else if (r.age <= 60) ageing.d3160 += b; else if (r.age <= 90) ageing.d6190 += b; else ageing.d90 += b; });
  const mg = db.prepare(`SELECT COALESCE(SUM(ii.amount),0) rev, COALESCE(SUM(ii.quantity*(${EFFECTIVE_COST})),0) cogs FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id AND i.status!='cancelled' AND i.invoice_date>=? JOIN products p ON p.id=ii.product_id`).get(mStart);
  const grossProfit = mg.rev - mg.cogs, marginPct = mg.rev > 0 ? Math.round(grossProfit / mg.rev * 100) : 0;
  const topDealers = db.prepare("SELECT d.name, COALESCE(SUM(i.total),0) v FROM invoices i JOIN dealers d ON d.id=i.dealer_id WHERE i.status!='cancelled' AND i.invoice_date>=? GROUP BY d.id ORDER BY v DESC LIMIT 5").all(mStart);
  const topProducts = db.prepare("SELECT p.name, COALESCE(SUM(ii.amount),0) v FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id AND i.status!='cancelled' AND i.invoice_date>=? JOIN products p ON p.id=ii.product_id GROUP BY p.id ORDER BY v DESC LIMIT 5").all(mStart);
  const lowStock = _v("SELECT COUNT(*) v FROM products p JOIN ready_stock_total rs ON rs.product_id=p.id WHERE p.active=1 AND p.reorder_level>0 AND rs.quantity<=p.reorder_level");
  const newDealers = _v("SELECT COUNT(*) v FROM dealers WHERE created_at>=?", mStart);
  res.render('reports/snapshot', { title: "Owner's Snapshot", today, monthBilled, monthColl, todayBilled, todayColl, outstanding, ageing, grossProfit, marginPct, rev: mg.rev, topDealers, topProducts, lowStock, newDealers });
});

// Profit & Margin — true gross margin per product + category (qty × cost).
router.get('/margin', (req, res) => {
  const from = req.query.from || _ago(30), to = req.query.to || _today();
  const rows = db.prepare(`SELECT p.id,p.code,p.name, COALESCE(c.name,'—') category,
      SUM(ii.quantity) qty, SUM(ii.amount) revenue, SUM(ii.quantity*(${EFFECTIVE_COST})) cogs
    FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id AND i.invoice_date BETWEEN ? AND ? AND i.status!='cancelled'
    JOIN products p ON p.id=ii.product_id LEFT JOIN product_categories c ON c.id=p.category_id
    GROUP BY p.id HAVING qty>0 ORDER BY (SUM(ii.amount)-SUM(ii.quantity*(${EFFECTIVE_COST}))) DESC`).all(from, to);
  rows.forEach(r => { r.profit = r.revenue - r.cogs; r.margin = r.revenue > 0 ? Math.round(r.profit / r.revenue * 100) : 0; });
  const cat = {};
  rows.forEach(r => { const c = cat[r.category] = cat[r.category] || { category: r.category, revenue: 0, cogs: 0, qty: 0 }; c.revenue += r.revenue; c.cogs += r.cogs; c.qty += r.qty; });
  const cats = Object.values(cat).map(c => { c.profit = c.revenue - c.cogs; c.margin = c.revenue > 0 ? Math.round(c.profit / c.revenue * 100) : 0; return c; }).sort((a, b) => b.profit - a.profit);
  const tot = rows.reduce((a, r) => { a.revenue += r.revenue; a.cogs += r.cogs; a.qty += r.qty; return a; }, { revenue: 0, cogs: 0, qty: 0 });
  tot.profit = tot.revenue - tot.cogs; tot.margin = tot.revenue > 0 ? Math.round(tot.profit / tot.revenue * 100) : 0;
  res.render('reports/margin', { title: 'Profit & Margin', rows, cats, tot, from, to });
});

// Credit Risk — dealers by credit grade, exposure & over-limit watchlist.
router.get('/credit-risk', (req, res) => {
  const { scoreFrom } = require('../utils/creditScore');
  const ds = db.prepare(`SELECT d.id,d.code,d.name,d.phone,d.credit_limit,d.opening_balance,
      COALESCE((SELECT SUM(total) FROM invoices WHERE dealer_id=d.id AND status!='cancelled'),0) billed,
      COALESCE((SELECT SUM(amount) FROM payments WHERE dealer_id=d.id AND status='verified'),0) paid,
      COALESCE((SELECT SUM(total_amount) FROM returns WHERE dealer_id=d.id AND status IN ('approved','restocked')),0) returned,
      COALESCE((SELECT COUNT(*) FROM invoices WHERE dealer_id=d.id AND status!='cancelled'),0) inv_count,
      COALESCE((SELECT COUNT(*) FROM payments WHERE dealer_id=d.id AND status='verified'),0) pay_count,
      CAST(julianday('now')-julianday((SELECT MIN(invoice_date) FROM invoices WHERE dealer_id=d.id AND status IN ('unpaid','partial'))) AS INTEGER) oldest
    FROM dealers d WHERE d.active=1`).all();
  ds.forEach(d => { d.outstanding = Math.max(0, (d.opening_balance || 0) + d.billed - d.paid - d.returned);
    const s = scoreFrom({ opening: d.opening_balance, billed: d.billed, paid: d.paid, returned: d.returned, outstanding: d.outstanding, credit_limit: d.credit_limit, invCount: d.inv_count, payCount: d.pay_count, oldestUnpaidDays: d.oldest });
    Object.assign(d, { score: s.score, grade: s.grade, color: s.color, label: s.label }); });
  const scored = ds.filter(d => d.score != null);
  const buckets = { A: 0, B: 0, C: 0, D: 0, E: 0 }, exposure = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  scored.forEach(d => { buckets[d.grade]++; exposure[d.grade] += d.outstanding; });
  const totalExposure = scored.reduce((s, d) => s + d.outstanding, 0);
  // Click a grade card to drill into just that grade; default view is the risky/over-limit watchlist.
  const filterGrade = ['A', 'B', 'C', 'D', 'E'].includes((req.query.grade || '').toUpperCase()) ? req.query.grade.toUpperCase() : null;
  let rows = filterGrade
    ? scored.filter(d => d.grade === filterGrade)
    : scored.filter(d => ['D', 'E'].includes(d.grade) || (d.credit_limit > 0 && d.outstanding > d.credit_limit));
  rows.sort((a, b) => b.outstanding - a.outstanding);
  const totalRows = rows.length, CAP = 250;
  if (totalRows > CAP) rows = rows.slice(0, CAP);
  res.render('reports/creditRisk', { title: 'Credit Risk', buckets, exposure, rows, filterGrade, totalRows, cap: CAP, totalExposure, scoredCount: scored.length });
});

// Dealer Retention — who's slipping/dormant (high-value churn first).
router.get('/retention', (req, res) => {
  const rows = db.prepare(`SELECT d.id,d.code,d.name,d.phone,u.name sp,d.created_at,
      MAX(i.invoice_date) last_inv, COUNT(i.id) inv_count, COALESCE(SUM(i.total),0) lifetime
    FROM dealers d LEFT JOIN invoices i ON i.dealer_id=d.id AND i.status!='cancelled'
    LEFT JOIN users u ON u.id=d.salesperson_id WHERE d.active=1 GROUP BY d.id`).all();
  const now = Date.now(), buckets = { active: 0, slipping: 0, risk: 0, dormant: 0, never: 0 };
  rows.forEach(d => {
    if (!d.last_inv) { d.bucket = 'never'; d.days = null; buckets.never++; return; }
    d.days = Math.round((now - new Date(d.last_inv).getTime()) / 864e5);
    d.bucket = d.days <= 30 ? 'active' : d.days <= 60 ? 'slipping' : d.days <= 90 ? 'risk' : 'dormant';
    buckets[d.bucket]++;
  });
  const mStart = _today().slice(0, 8) + '01';
  const newThisMonth = rows.filter(d => d.created_at && d.created_at >= mStart).length;
  const withOrders = rows.filter(d => d.inv_count > 0).length;
  const repeatRate = withOrders ? Math.round(rows.filter(d => d.inv_count >= 2).length / withOrders * 100) : 0;
  const watch = rows.filter(d => ['slipping', 'risk', 'dormant'].includes(d.bucket)).sort((a, b) => b.lifetime - a.lifetime).slice(0, 100);
  res.render('reports/retention', { title: 'Dealer Retention', buckets, newThisMonth, withOrders, repeatRate, watch });
});

// Business Growth — 12-month revenue + collections + MoM growth.
router.get('/growth', (req, res) => {
  const rev = {}, coll = {};
  db.prepare("SELECT strftime('%Y-%m',invoice_date) ym, SUM(total) v FROM invoices WHERE status!='cancelled' AND invoice_date>=date('now','-12 months') GROUP BY ym").all().forEach(r => rev[r.ym] = r.v);
  db.prepare("SELECT strftime('%Y-%m',payment_date) ym, SUM(amount) v FROM payments WHERE status='verified' AND payment_date>=date('now','-12 months') GROUP BY ym").all().forEach(r => coll[r.ym] = r.v);
  const months = [];
  for (let i = 11; i >= 0; i--) { const dt = new Date(); dt.setDate(1); dt.setMonth(dt.getMonth() - i); months.push(dt.toISOString().slice(0, 7)); }
  const series = months.map((ym, idx) => {
    const revenue = rev[ym] || 0, prev = idx > 0 ? (rev[months[idx - 1]] || 0) : 0;
    return { ym, revenue, collections: coll[ym] || 0, growth: prev > 0 ? Math.round((revenue - prev) / prev * 100) : null };
  });
  res.render('reports/growth', { title: 'Business Growth', series });
});

module.exports = router;
