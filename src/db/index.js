// node:sqlite (built into Node 22+) wrapped to expose a better-sqlite3-style API
// so the rest of the app can use db.prepare(...).run/get/all and db.transaction(fn).
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'portal.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const raw = new DatabaseSync(DB_PATH);

// Adapter that mimics the better-sqlite3 API surface used in this app.
const db = {
  _raw: raw,
  exec(sql) { return raw.exec(sql); },
  pragma(stmt) {
    // raw.exec("PRAGMA ..."); but we use this only for a couple of fixed ones.
    return raw.exec('PRAGMA ' + stmt);
  },
  prepare(sql) {
    const stmt = raw.prepare(sql);
    return {
      _stmt: stmt,
      run(...args) {
        const r = stmt.run(...args);
        return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
      },
      get(...args) { return stmt.get(...args); },
      all(...args) { return stmt.all(...args); },
    };
  },
  // Transaction wrapper compatible with better-sqlite3's db.transaction(fn) — returns a callable
  transaction(fn) {
    return (...args) => {
      raw.exec('BEGIN');
      try {
        const result = fn(...args);
        raw.exec('COMMIT');
        return result;
      } catch (e) {
        try { raw.exec('ROLLBACK'); } catch {}
        throw e;
      }
    };
  },
};

function initDb() {
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(schema);
  runMigrations();
  seedIfEmpty();
}

// Idempotent migrations for ALTER TABLE column additions on existing DBs.
// SQLite's ADD COLUMN has no IF NOT EXISTS — we detect via PRAGMA table_info.
function runMigrations() {
  const ensureColumn = (table, col, ddl) => {
    const cols = raw.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.find(c => c.name === col)) {
      raw.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  };
  ensureColumn('production_batches', 'is_bundle',         'is_bundle INTEGER NOT NULL DEFAULT 0');
  ensureColumn('production_batches', 'bundle_size',       'bundle_size INTEGER NOT NULL DEFAULT 1');
  ensureColumn('production_batches', 'materials_issued',  'materials_issued INTEGER NOT NULL DEFAULT 0');
  ensureColumn('fabric_cost_calc',   'wastage_percent',   'wastage_percent REAL NOT NULL DEFAULT 0');
  ensureColumn('fabric_cost_calc',   'total_fabric_cost', 'total_fabric_cost REAL NOT NULL DEFAULT 0');
  ensureColumn('products',           'is_bundle_sku',     'is_bundle_sku INTEGER NOT NULL DEFAULT 0');
  ensureColumn('products',           'image_path',        'image_path TEXT');
  ensureColumn('raw_materials',      'image_path',        'image_path TEXT');
  ensureColumn('sales_orders',       'discount_amount',   'discount_amount REAL NOT NULL DEFAULT 0');
  ensureColumn('invoices',           'discount_amount',   'discount_amount REAL NOT NULL DEFAULT 0');
  // Return line items can be entered in bundles for bundle SKUs — store the
  // bundle count + pcs/bundle so the printed credit note can show "X bdl
  // (Y pcs)" and the restock logic still uses the actual pcs count.
  ensureColumn('return_items',       'is_bundle',         'is_bundle INTEGER NOT NULL DEFAULT 0');
  ensureColumn('return_items',       'pcs_per_bundle',    'pcs_per_bundle INTEGER NOT NULL DEFAULT 0');
  ensureColumn('return_items',       'bundles',           'bundles INTEGER NOT NULL DEFAULT 0');
  // GST on returns — credit notes must reverse the same tax the invoice
  // collected. Stored per-line so the credit-note printout can show the
  // GST% column just like the invoice does. cgst/sgst/igst split lives
  // on the parent `returns` row, computed at insert time from dealer
  // state (intra → CGST+SGST, inter → IGST), mirroring invoice logic.
  ensureColumn('return_items',       'gst_rate',          'gst_rate REAL NOT NULL DEFAULT 0');
  ensureColumn('returns',            'subtotal',          'subtotal REAL NOT NULL DEFAULT 0');
  ensureColumn('returns',            'gst_amount',        'gst_amount REAL NOT NULL DEFAULT 0');
  ensureColumn('returns',            'cgst',              'cgst REAL NOT NULL DEFAULT 0');
  ensureColumn('returns',            'sgst',              'sgst REAL NOT NULL DEFAULT 0');
  ensureColumn('returns',            'igst',              'igst REAL NOT NULL DEFAULT 0');

  // One-time backfill: existing returns were created before GST was
  // tracked, so their return_items.gst_rate is 0 and the parent
  // returns.total_amount is ex-GST. That under-credits the dealer's
  // outstanding by the GST portion. Pull each line's gst_rate from the
  // product master, recompute the parent's subtotal / gst / total so
  // the ledger comes out right. Idempotent: only fires on rows still
  // at the default zero values.
  try {
    const itemsToBackfill = db.prepare(`
      SELECT ri.id, p.gst_rate AS product_gst_rate
      FROM return_items ri JOIN products p ON p.id = ri.product_id
      WHERE COALESCE(ri.gst_rate, 0) = 0 AND COALESCE(p.gst_rate, 0) > 0`).all();
    if (itemsToBackfill.length) {
      const upd = db.prepare('UPDATE return_items SET gst_rate = ? WHERE id = ?');
      itemsToBackfill.forEach(r => upd.run(r.product_gst_rate, r.id));
    }
    // Recompute every return whose subtotal/gst is still zero. Splits the
    // tax 50/50 into cgst/sgst — won't try to guess intra-vs-inter for
    // historical rows. Going forward the POST handler stores the right
    // split based on dealer state.
    const stale = db.prepare(`SELECT id FROM returns WHERE COALESCE(subtotal,0)=0 AND COALESCE(gst_amount,0)=0`).all();
    if (stale.length) {
      const recompute = db.prepare(`
        UPDATE returns SET
          subtotal   = COALESCE((SELECT SUM(amount) FROM return_items WHERE return_id = returns.id), 0),
          gst_amount = COALESCE((SELECT SUM(amount * gst_rate / 100.0) FROM return_items WHERE return_id = returns.id), 0)
        WHERE id = ?`);
      const splitTax = db.prepare(`UPDATE returns SET cgst = gst_amount / 2.0, sgst = gst_amount / 2.0, total_amount = subtotal + gst_amount WHERE id = ?`);
      stale.forEach(r => { recompute.run(r.id); splitTax.run(r.id); });
    }
  } catch (_) {}

  // ── Locations master (offices / warehouses / factory) ──────────
  // Multi-location support. Currently the "factory" was implicit
  // (computed as the median of factory_in GPS logs); this table makes
  // it explicit and lets the owner add regional offices like Muzaffarpur
  // or Motihari. type discriminates how the location is used downstream:
  //   factory   — production happens here (default for the legacy site)
  //   office    — sales / admin only; warehouse=0
  //   warehouse — stock-holding (future: multi-location inventory)
  db.prepare(`
    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'office' CHECK(type IN ('factory','office','warehouse')),
      city TEXT,
      state TEXT,
      address TEXT,
      lat REAL,
      lng REAL,
      gstin TEXT,
      phone TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`).run();

  // Seed one row (the legacy factory) so existing data has somewhere to
  // anchor before the owner adds their own offices. Uses median of
  // factory_logs to pre-fill the coords. Idempotent — only seeds when
  // the table is empty.
  const locCount = db.prepare('SELECT COUNT(*) AS n FROM locations').get().n;
  if (locCount === 0) {
    // factory_logs is created LATER in this same migration run — on a
    // brand-new database it doesn't exist yet and this seed block used
    // to crash initDb. Existing installs never hit it (table present).
    const hasFactoryLogs = db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='factory_logs'`).get();
    const factoryLogs = hasFactoryLogs ? db.prepare(`
      SELECT lat, lng FROM factory_logs
      WHERE log_type='in' AND lat IS NOT NULL AND lng IS NOT NULL
      ORDER BY id DESC LIMIT 50`).all() : [];
    let lat = null, lng = null;
    if (factoryLogs.length) {
      const lats = factoryLogs.map(r => r.lat).sort((a, b) => a - b);
      const lngs = factoryLogs.map(r => r.lng).sort((a, b) => a - b);
      lat = lats[Math.floor(lats.length / 2)];
      lng = lngs[Math.floor(lngs.length / 2)];
    }
    const brand = db.prepare(`SELECT value FROM app_settings WHERE key='COMPANY_STATE'`).get();
    db.prepare(`INSERT INTO locations (code, name, type, city, state, lat, lng, active) VALUES (?,?,?,?,?,?,?,1)`)
      .run('LOC0001', 'Head Office / Factory', 'factory', null, brand ? brand.value : null, lat, lng);
  }

  // Every user can be tied to a "home" office — drives route planning
  // start/end point and (later) which office's stock pool serves them.
  ensureColumn('users', 'home_office_id', 'home_office_id INTEGER REFERENCES locations(id)');

  // ── Location capability flags ──────────────────────────────────
  // A single physical location can wear multiple hats — e.g. Muzaffarpur
  // is the regional office AND a stock-holding warehouse AND where the
  // local team taps factory in/out. Rather than forcing the owner to
  // pick ONE `type`, we keep `type` as a primary-label / sort hint and
  // add three boolean capability flags. Existing rows are backfilled
  // from `type` so a factory keeps holding stock + accepting in/out
  // tags by default.
  ensureColumn('locations', 'is_factory_in', 'is_factory_in INTEGER NOT NULL DEFAULT 0');
  ensureColumn('locations', 'is_office',     'is_office     INTEGER NOT NULL DEFAULT 0');
  ensureColumn('locations', 'is_warehouse',  'is_warehouse  INTEGER NOT NULL DEFAULT 0');
  // Backfill: only fires when ALL three flags are still 0 (their default)
  // so it doesn't clobber manual edits after the first run.
  db.prepare(`
    UPDATE locations
       SET is_factory_in = CASE WHEN type='factory' THEN 1 ELSE 0 END,
           is_office     = CASE WHEN type IN ('factory','office') THEN 1 ELSE 0 END,
           is_warehouse  = CASE WHEN type IN ('factory','warehouse') THEN 1 ELSE 0 END
     WHERE COALESCE(is_factory_in,0)=0 AND COALESCE(is_office,0)=0 AND COALESCE(is_warehouse,0)=0`).run();

  // ── Phase 4: per-location stock pools ──────────────────────────
  // ready_stock previously held one row per product (UNIQUE(product_id)).
  // We rebuild it so the same product can hold separate quantities at
  // different locations: UNIQUE(product_id, location_id). Existing rows
  // get migrated onto the seeded factory (location_id = 1) so no stock
  // is lost. A read-only VIEW `ready_stock_total` exposes the sum-across-
  // locations shape the rest of the app already queries — minimises diff
  // by letting most SELECTs swap `ready_stock` → `ready_stock_total` and
  // keep working unchanged.
  const rsCols = db.prepare("PRAGMA table_info(ready_stock)").all().map(c => c.name);
  if (!rsCols.includes('location_id')) {
    const defaultLoc = db.prepare("SELECT id FROM locations WHERE active=1 ORDER BY CASE type WHEN 'factory' THEN 1 ELSE 2 END, id LIMIT 1").get();
    const defaultLocId = defaultLoc ? defaultLoc.id : 1;
    db.exec(`
      CREATE TABLE ready_stock_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        location_id INTEGER NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (product_id) REFERENCES products(id),
        FOREIGN KEY (location_id) REFERENCES locations(id),
        UNIQUE(product_id, location_id)
      );
      INSERT INTO ready_stock_new (id, product_id, location_id, quantity, updated_at)
        SELECT id, product_id, ${defaultLocId}, quantity, updated_at FROM ready_stock;
      DROP TABLE ready_stock;
      ALTER TABLE ready_stock_new RENAME TO ready_stock;
    `);
  }
  // (Re-)create the aggregate view. Idempotent.
  db.exec(`DROP VIEW IF EXISTS ready_stock_total`);
  db.exec(`
    CREATE VIEW ready_stock_total AS
    SELECT product_id, SUM(quantity) AS quantity, MAX(updated_at) AS updated_at
    FROM ready_stock GROUP BY product_id`);

  // Stock movements gain from / to location so transfers between
  // locations have a complete audit trail.
  ensureColumn('stock_movements', 'from_location_id', 'from_location_id INTEGER REFERENCES locations(id)');
  ensureColumn('stock_movements', 'to_location_id',   'to_location_id   INTEGER REFERENCES locations(id)');
  // The CHECK constraint on movement_type didn't include 'transfer' —
  // rebuild the table once to allow it. SQLite doesn't support ALTERing
  // a CHECK constraint, so we copy data into a new table and rename.
  const smCheck = db.prepare("SELECT sql FROM sqlite_master WHERE name='stock_movements'").get();
  if (smCheck && !smCheck.sql.includes("'transfer'")) {
    db.exec(`
      CREATE TABLE stock_movements_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        movement_type TEXT NOT NULL CHECK(movement_type IN ('production_in','sale_out','return_in','dispatch_out','adjustment','transfer')),
        quantity INTEGER NOT NULL,
        ref_table TEXT,
        ref_id INTEGER,
        notes TEXT,
        from_location_id INTEGER REFERENCES locations(id),
        to_location_id   INTEGER REFERENCES locations(id),
        created_by INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (product_id) REFERENCES products(id),
        FOREIGN KEY (created_by) REFERENCES users(id)
      );
      INSERT INTO stock_movements_new (id, product_id, movement_type, quantity, ref_table, ref_id, notes, from_location_id, to_location_id, created_by, created_at)
        SELECT id, product_id, movement_type, quantity, ref_table, ref_id, notes, from_location_id, to_location_id, created_by, created_at FROM stock_movements;
      DROP TABLE stock_movements;
      ALTER TABLE stock_movements_new RENAME TO stock_movements;
    `);
  }

  // Invoices remember which warehouse fulfilled them so the right
  // location's pool was debited.
  ensureColumn('invoices', 'fulfilled_from_location_id', 'fulfilled_from_location_id INTEGER REFERENCES locations(id)');

  // Purchaser-controlled shipping status, orthogonal to PO status state
  // machine (draft → sent → received). Lets purchaser tag a PO as
  // "in transit" or "arrived" so anyone reading the list knows where the
  // goods physically are without waiting for receipt-entry.
  ensureColumn('purchase_orders',    'tracking_status',   "tracking_status TEXT NOT NULL DEFAULT 'pending'");
  ensureColumn('purchase_orders',    'tracking_note',     'tracking_note TEXT');
  ensureColumn('purchase_orders',    'tracking_updated_at','tracking_updated_at TEXT');

  // ── area_manager role + sensible default permissions ──────────────
  // The "area manager" sits between salesperson and admin: a regional
  // supervisor who sees their own data PLUS the data of every salesperson
  // who reports to them (via users.reports_to). Scope is enforced in
  // src/middleware/scope.js — this block just seeds the role itself and
  // its default feature levels so the sidebar/permission system recognises
  // it the moment the column lands.
  try {
    db.prepare(`INSERT OR IGNORE INTO roles (role_key, label, is_system, sort_order) VALUES ('area_manager', 'Area Manager', 1, 35)`).run();
    // Defaults mirror the salesperson role but raise reports + tasks to
    // 'view' (so a manager can see the salesperson performance report and
    // any task assigned within their team). Adjust under Settings → Access.
    const seedPerm = db.prepare(`INSERT OR IGNORE INTO role_permissions (role, feature_key, level) VALUES (?, ?, ?)`);
    const AREA_MANAGER_DEFAULTS = [
      ['dealers',    'limited'],
      ['sales',      'limited'],   // covers sales_orders + sales_invoices via inheritance
      ['payments',   'limited'],
      ['visits',     'limited'],
      ['factory_log','limited'],
      ['tasks',      'limited'],
      ['dispatch',   'view'],
      ['products',   'view'],
      ['materials',  'view'],
      ['stock',      'view'],
      ['reports',    'view'],      // see reports for their team
      ['hr_attendance','view'],
      ['notifications','limited'],
      ['activity',   'view'],
    ];
    AREA_MANAGER_DEFAULTS.forEach(([k, l]) => seedPerm.run('area_manager', k, l));
  } catch (_) {}
  // Org hierarchy — each user can report to another user (their manager).
  // Nullable because top-level (owner) reports to nobody.
  ensureColumn('users',              'reports_to',        'reports_to INTEGER REFERENCES users(id)');
  // Catalogue templates: gender filter so the owner can request "female
  // only" / "male only" / "both" at generation time. 'unisex' for older
  // templates that don't specify (treated as a wildcard match).
  try { ensureColumn('catalogue_templates', 'gender', "gender TEXT NOT NULL DEFAULT 'unisex'"); } catch (_) {}
  // pose_focus controls which templates are picked at try-on time based
  // on the GARMENT type. 'upper' = framed/posed for tops (hands at sides
  // or on hips, torso clearly visible). 'lower' = jeans/trousers framing
  // (hands in pockets, walking, side stance, weight on one leg). 'overall'
  // = sarees/dresses (full silhouette, slight side angle). 'unisex' is the
  // default for older templates and works as a fallback when no
  // type-specific template matches.
  try { ensureColumn('catalogue_templates', 'pose_focus', "pose_focus TEXT NOT NULL DEFAULT 'unisex'"); } catch (_) {}

  // ── Permission Matrix v2 — custom roles ──
  // Custom roles can be defined by the owner from the UI. is_system=1 marks
  // the seven built-in roles (owner/admin/etc.) which can't be deleted or
  // renamed; user-created roles default to is_system=0.
  raw.exec(`CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role_key TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    is_system INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 100,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  // Seed the seven built-in roles. INSERT OR IGNORE so re-running does nothing.
  const seedRole = raw.prepare('INSERT OR IGNORE INTO roles (role_key, label, is_system, sort_order) VALUES (?,?,?,?)');
  seedRole.run('owner',       'Owner',       1, 1);
  seedRole.run('admin',       'Admin',       1, 10);
  seedRole.run('accountant',  'Accountant',  1, 20);
  seedRole.run('salesperson', 'Salesperson', 1, 30);
  seedRole.run('production',  'Production',  1, 40);
  seedRole.run('store',       'Store',       1, 50);
  seedRole.run('purchaser',   'Purchaser',   1, 60);

  // ── Permission Matrix v2 — per-user overrides ──
  // user_permissions overrides role_permissions for a specific user. Lets the
  // owner give one salesperson reports.full without granting it to all
  // salespersons. Lookup order: user_permissions → role_permissions → parent
  // feature → 'none'.
  raw.exec(`CREATE TABLE IF NOT EXISTS user_permissions (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    feature_key TEXT NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('none','view','limited','full')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by INTEGER,
    PRIMARY KEY (user_id, feature_key)
  )`);

  // ── Catalogue module (standalone) ──
  // Self-contained AI catalogue generator: upload front+back of a garment,
  // get back model-on / multi-angle images via fal.ai. Intentionally NOT
  // foreign-keyed to products/sales — owner can wipe this whole module by
  // dropping these three tables + removing the route mount, without any
  // cascade risk to the rest of the ERP.
  raw.exec(`CREATE TABLE IF NOT EXISTS catalogue_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    total_cost_inr REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by INTEGER REFERENCES users(id)
  )`);
  raw.exec(`CREATE TABLE IF NOT EXISTS catalogue_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES catalogue_items(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    variant TEXT,
    file_path TEXT NOT NULL,
    cost_inr REAL DEFAULT 0,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  raw.exec(`CREATE TABLE IF NOT EXISTS ai_usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    related_item_id INTEGER REFERENCES catalogue_items(id) ON DELETE SET NULL,
    cost_usd REAL NOT NULL DEFAULT 0,
    cost_inr REAL NOT NULL DEFAULT 0,
    ok INTEGER NOT NULL DEFAULT 1,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by INTEGER REFERENCES users(id)
  )`);
  // Catalogue model templates — owner uploads pose/model reference images
  // ONCE; the pipeline re-uses them across every product. `kind=model_pose`
  // is what virtual-try-on calls take; we keep `kind` flexible so future
  // template types (e.g. background plates) slot in without a migration.
  raw.exec(`CREATE TABLE IF NOT EXISTS catalogue_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'model_pose',
    variant TEXT,
    pose_label TEXT,
    file_path TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 100,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by INTEGER REFERENCES users(id)
  )`);
  // Track lifecycle of a generation run so the UI can poll progress and
  // we can surface partial failures (e.g. 6 of 8 angles succeeded).
  raw.exec(`CREATE TABLE IF NOT EXISTS catalogue_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES catalogue_items(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'queued',
    total_steps INTEGER NOT NULL DEFAULT 0,
    completed_steps INTEGER NOT NULL DEFAULT 0,
    cost_inr REAL NOT NULL DEFAULT 0,
    error TEXT,
    options TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  )`);
  // Idempotent: catch DBs that already had the table without `options`.
  try { ensureColumn('catalogue_jobs', 'options', 'options TEXT'); } catch (_) {}

  // Catalogue per-item parameters that drive the AI pipeline:
  //   • cloth_type — which body region the garment occupies. Drives the
  //     CAT-VTON `cloth_type` parameter (upper / lower / overall).
  //   • scene_key  — which luxury background scene to composite onto
  //     after try-on (matches keys in src/utils/cataloguePipeline.js).
  //   • editorial_copy — auto-generated 2-line product blurb for the
  //     premium magazine layout. Owner can edit / regenerate.
  ensureColumn('catalogue_items', 'cloth_type',     "cloth_type TEXT NOT NULL DEFAULT 'upper'");
  ensureColumn('catalogue_items', 'scene_key',      "scene_key TEXT NOT NULL DEFAULT 'pure_white'");
  ensureColumn('catalogue_items', 'editorial_copy', 'editorial_copy TEXT');

  // Audit log — richer fields so the activity log is actually useful
  // for debugging/security ("who did what FROM WHERE on WHICH browser").
  // Old rows keep working: missing columns just show as empty in the UI.
  ensureColumn('audit_log', 'user_agent',    'user_agent TEXT');
  ensureColumn('audit_log', 'method',        'method TEXT');
  ensureColumn('audit_log', 'path',          'path TEXT');
  ensureColumn('audit_log', 'referer',       'referer TEXT');
  ensureColumn('audit_log', 'forwarded_for', 'forwarded_for TEXT');

  // HR: work types master + linkage from per-piece work log
  raw.exec(`CREATE TABLE IF NOT EXISTS work_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    default_rate REAL NOT NULL DEFAULT 0,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  // employee_pieces only exists once the HR schema has been applied — guard with try/catch
  try { ensureColumn('employee_pieces', 'work_type_id', 'work_type_id INTEGER REFERENCES work_types(id)'); } catch (_) {}
  // Salary slip attendance breakdown — added after the initial release; old
  // slips will have NULL for these columns and the view falls back gracefully.
  try {
    ensureColumn('salary_payments', 'month_days',     'month_days INTEGER');
    ensureColumn('salary_payments', 'paid_days',      'paid_days REAL');
    ensureColumn('salary_payments', 'half_day_count', 'half_day_count INTEGER NOT NULL DEFAULT 0');
    ensureColumn('salary_payments', 'leave_count',    'leave_count INTEGER NOT NULL DEFAULT 0');
    ensureColumn('salary_payments', 'holiday_count',  'holiday_count INTEGER NOT NULL DEFAULT 0');
    ensureColumn('salary_payments', 'unmarked_count', 'unmarked_count INTEGER NOT NULL DEFAULT 0');
  } catch (_) {}

  // Field-visits module
  raw.exec(`CREATE TABLE IF NOT EXISTS dealer_visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visit_no TEXT UNIQUE NOT NULL,
    salesperson_id INTEGER NOT NULL,
    visit_type TEXT NOT NULL CHECK(visit_type IN ('existing','prospect')),
    dealer_id INTEGER,
    prospect_name TEXT,
    prospect_phone TEXT,
    prospect_shop TEXT,
    prospect_city TEXT,
    promoted_to_dealer_id INTEGER,
    photo_path TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    accuracy_m REAL,
    taken_at TEXT,
    device_info TEXT,
    ip TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (salesperson_id) REFERENCES users(id),
    FOREIGN KEY (dealer_id) REFERENCES dealers(id),
    FOREIGN KEY (promoted_to_dealer_id) REFERENCES dealers(id)
  )`);
  // Cache the most recent visit's GPS on the dealer master so the next
  // visit can warn if the salesperson is far from the dealer's last known
  // location. Built up automatically as visits are logged.
  ensureColumn('dealers', 'last_visit_lat', 'last_visit_lat REAL');
  ensureColumn('dealers', 'last_visit_lng', 'last_visit_lng REAL');
  ensureColumn('dealers', 'last_visit_at',  'last_visit_at  TEXT');

  // Phase 3+: each dealer can be tagged to an office (Bettiah HQ vs
  // Muzaffarpur Regional). Drives the office filter on the list, the
  // By-Office report split, and lets a salesperson re-assignment NOT
  // accidentally swap a dealer's office tag. NULL = unassigned.
  ensureColumn('dealers', 'office_id', 'office_id INTEGER REFERENCES locations(id)');

  // Prospect lifecycle on dealer_visits — distinguishes a prospect
  // that's still being pursued (NULL) from one that's been written off
  // (lost_at set). Promotion success is already tracked via
  // promoted_to_dealer_id; "lost" is the explicit failure terminal.
  ensureColumn('dealer_visits', 'lost_at',     'lost_at TEXT');
  ensureColumn('dealer_visits', 'lost_reason', 'lost_reason TEXT');

  // Employee KYC & verification — live photo + ID document uploads +
  // police verification status. Photos stored under
  // public/uploads/employees/. Aadhaar/DL/PAN numbers may be useful
  // for payroll & compliance audits.
  ensureColumn('employees', 'photo_path',            'photo_path TEXT');
  ensureColumn('employees', 'aadhaar_no',            'aadhaar_no TEXT');
  ensureColumn('employees', 'aadhaar_doc_path',      'aadhaar_doc_path TEXT');
  ensureColumn('employees', 'pan_doc_path',          'pan_doc_path TEXT');
  ensureColumn('employees', 'dl_no',                 'dl_no TEXT');
  ensureColumn('employees', 'dl_doc_path',           'dl_doc_path TEXT');
  ensureColumn('employees', 'police_verif_status',   "police_verif_status TEXT DEFAULT 'not_done'");
  // eTimeOffice biometric Empcode — maps cloud punch records to this
  // employee. Falls back to employees.code when blank.
  ensureColumn('employees', 'biometric_code',        'biometric_code TEXT');
  ensureColumn('employees', 'police_verif_doc_path', 'police_verif_doc_path TEXT');
  ensureColumn('employees', 'police_verif_date',     'police_verif_date TEXT');
  ensureColumn('employees', 'police_verif_notes',    'police_verif_notes TEXT');

  // Production stage entries — for BUNDLE batches qty_rejected is now
  // interpreted as PIECES (not bundles), since rejections happen at
  // piece-level (1 defective shirt out of a 26-pc bundle). The optional
  // rejected_variant_id points to the size variant the rejected pieces
  // came from, when the user wants to tag it for drill-down. NULL =
  // unspecified or non-bundle batch.
  ensureColumn('production_stage_entries', 'rejected_variant_id',
               'rejected_variant_id INTEGER REFERENCES products(id)');

  // Factory in/out logs — bookend the day for salesperson KM calculation.
  // log_type='in' is when they leave the factory in the morning; 'out' is
  // when they return. One row per (salesperson, log_date, log_type) — a
  // re-take overwrites the existing row for that day.
  raw.exec(`CREATE TABLE IF NOT EXISTS factory_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    salesperson_id INTEGER NOT NULL,
    log_type TEXT NOT NULL CHECK(log_type IN ('in','out')),
    log_date TEXT NOT NULL,
    photo_path TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    accuracy_m REAL,
    device_info TEXT,
    ip TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(salesperson_id, log_date, log_type),
    FOREIGN KEY (salesperson_id) REFERENCES users(id)
  )`);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_factory_logs_sp_date ON factory_logs(salesperson_id, log_date)`);

  // Admin fund accounts — the owner gives a designated admin a cash float
  // (e.g. ₹50,000) for petty manufacturing expenses. Top-ups add to the
  // balance; mfg expenses debit it (via mfg_expenses.funded_by_user_id).
  // Balance is computed live, not cached, so it can never drift.
  raw.exec(`CREATE TABLE IF NOT EXISTS admin_funds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    opening_balance REAL NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    notes TEXT,
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
  )`);
  raw.exec(`CREATE TABLE IF NOT EXISTS admin_fund_topups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fund_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    txn_date TEXT NOT NULL DEFAULT (date('now')),
    mode TEXT,
    reference_no TEXT,
    notes TEXT,
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (fund_id) REFERENCES admin_funds(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id)
  )`);
  // Tag each mfg expense with the user whose fund it was paid from (nullable
  // — expenses paid from the company account / not from a personal fund leave
  // it NULL).
  ensureColumn('mfg_expenses', 'funded_by_user_id', 'funded_by_user_id INTEGER REFERENCES users(id)');
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_mfg_expenses_fundedby ON mfg_expenses(funded_by_user_id)`);

  // Tasks / to-do assignment module. due_at holds the deadline as a plain
  // local-time string "YYYY-MM-DD HH:MM" (what the user typed) — NOT UTC,
  // so it's displayed as-is. estimated_hours = hours allotted to finish.
  raw.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    assigned_to INTEGER NOT NULL,
    created_by INTEGER NOT NULL,
    priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high')),
    status TEXT NOT NULL DEFAULT 'pending',
    estimated_hours REAL,
    due_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (assigned_to) REFERENCES users(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
  )`);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to, status)`);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_at)`);
  // Task discussion thread — progress notes / "what's going on".
  raw.exec(`CREATE TABLE IF NOT EXISTS task_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id, id)`);
  // Earlier builds created tasks.status with a CHECK limiting it to 4 values.
  // We now allow more statuses (on_hold, review, …) and validate in the app
  // layer instead — drop the constraint by rebuilding the table if present.
  const tasksInfo = raw.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`).get();
  if (tasksInfo && /CHECK\s*\(\s*status\s+IN/i.test(tasksInfo.sql)) {
    raw.exec(`
      CREATE TABLE tasks_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        assigned_to INTEGER NOT NULL,
        created_by INTEGER NOT NULL,
        priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high')),
        status TEXT NOT NULL DEFAULT 'pending',
        estimated_hours REAL,
        due_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (assigned_to) REFERENCES users(id),
        FOREIGN KEY (created_by) REFERENCES users(id)
      );
      INSERT INTO tasks_new SELECT * FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_new RENAME TO tasks;
      CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to, status);
      CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_at);
    `);
  }

  // Drop the CHECK constraint on users.role so we can add new roles like 'purchaser'.
  // Many tables FK-reference users(id), so we must temporarily disable FK enforcement during the swap.
  const usersInfo = raw.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='users'`).get();
  if (usersInfo && /CHECK\s*\(\s*role\s+IN/i.test(usersInfo.sql)) {
    raw.exec('PRAGMA foreign_keys = OFF');
    try {
      // Clean up any orphan from a prior failed migration attempt
      raw.exec('DROP TABLE IF EXISTS users_new');
      // ensureColumn calls above may have added newer columns (e.g. reports_to).
      // Build users_new from the actual current column list so INSERT lines up.
      const liveCols = raw.prepare('PRAGMA table_info(users)').all().map(c => c.name);
      const hasReportsTo = liveCols.includes('reports_to');
      raw.exec(`
        CREATE TABLE users_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          email TEXT UNIQUE NOT NULL,
          phone TEXT,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))${hasReportsTo ? ',\n          reports_to INTEGER REFERENCES users(id)' : ''}
        );
      `);
      const copyCols = ['id','name','email','phone','password_hash','role','active','created_at','updated_at'];
      if (hasReportsTo) copyCols.push('reports_to');
      raw.exec(`
        INSERT INTO users_new (${copyCols.join(',')}) SELECT ${copyCols.join(',')} FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
      `);
    } finally {
      raw.exec('PRAGMA foreign_keys = ON');
    }
  }

  // Drop the CHECK constraint on production_stage_entries.stage so custom stages work.
  // SQLite has no DROP CONSTRAINT — recreate the table if the constraint is still there.
  const psqlInfo = raw.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='production_stage_entries'`).get();
  if (psqlInfo && /CHECK\s*\(\s*stage\s+IN/i.test(psqlInfo.sql)) {
    // The source table may already carry columns added by ensureColumn
    // earlier in this run (e.g. rejected_variant_id on a FRESH install,
    // where the schema's CHECK constraint is still present). Copy with
    // an explicit column list so the rebuild never breaks on count.
    const oldCols = raw.prepare(`PRAGMA table_info(production_stage_entries)`).all().map(c => c.name);
    const hasVariant = oldCols.includes('rejected_variant_id');
    raw.exec(`
      CREATE TABLE production_stage_entries_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id INTEGER NOT NULL,
        stage TEXT NOT NULL,
        qty_in INTEGER NOT NULL DEFAULT 0,
        qty_out INTEGER NOT NULL DEFAULT 0,
        qty_rejected INTEGER NOT NULL DEFAULT 0,
        worker_name TEXT,
        rate_per_piece REAL DEFAULT 0,
        total_cost REAL DEFAULT 0,
        entry_date TEXT NOT NULL DEFAULT (date('now')),
        notes TEXT,
        created_by INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        ${hasVariant ? 'rejected_variant_id INTEGER REFERENCES products(id),' : ''}
        FOREIGN KEY (batch_id) REFERENCES production_batches(id),
        FOREIGN KEY (created_by) REFERENCES users(id)
      );
    `);
    const copyCols = ['id','batch_id','stage','qty_in','qty_out','qty_rejected','worker_name','rate_per_piece','total_cost','entry_date','notes','created_by','created_at'];
    if (hasVariant) copyCols.push('rejected_variant_id');
    raw.exec(`
      INSERT INTO production_stage_entries_new (${copyCols.join(',')}) SELECT ${copyCols.join(',')} FROM production_stage_entries;
      DROP TABLE production_stage_entries;
      ALTER TABLE production_stage_entries_new RENAME TO production_stage_entries;
      CREATE INDEX IF NOT EXISTS idx_stage_entries_batch ON production_stage_entries(batch_id);
    `);
  }

  // Seed default production stages if master is empty
  const stageCount = raw.prepare('SELECT COUNT(*) AS n FROM production_stages_master').get().n;
  if (stageCount === 0) {
    const ins = raw.prepare(`INSERT INTO production_stages_master (stage_key, label, sort_order, is_default) VALUES (?,?,?,1)`);
    [
      ['cutting',   'Cutting',   10],
      ['stitching', 'Stitching', 20],
      ['washing',   'Washing',   30],
      ['finishing', 'Finishing', 40],
      ['packing',   'Packing',   50],
    ].forEach(([k, l, o]) => ins.run(k, l, o));
  }

  // Migrate existing single product image_path → product_photos (idempotent)
  const oldPhotos = raw.prepare(`SELECT id, image_path FROM products WHERE image_path IS NOT NULL AND image_path != ''`).all();
  if (oldPhotos.length > 0) {
    const insPhoto = raw.prepare(`INSERT INTO product_photos (product_id, image_path, is_primary, sort_order) VALUES (?,?,1,0)`);
    const checkExist = raw.prepare(`SELECT 1 FROM product_photos WHERE product_id=? AND image_path=?`);
    oldPhotos.forEach(p => {
      if (!checkExist.get(p.id, p.image_path)) {
        try { insPhoto.run(p.id, p.image_path); } catch {}
      }
    });
  }

  // Backfill inventory_pieces from existing ready_stock (one-time)
  const piecesCount = raw.prepare('SELECT COUNT(*) AS n FROM inventory_pieces').get().n;
  if (piecesCount === 0) {
    const stockRows = raw.prepare(`
      SELECT rs.product_id, rs.quantity, p.code, p.cost_price
      FROM ready_stock rs JOIN products p ON p.id = rs.product_id
      WHERE rs.quantity > 0
    `).all();
    const insPiece = raw.prepare(`INSERT INTO inventory_pieces (piece_code, product_id, batch_id, status, cost_per_piece, notes) VALUES (?,?,?,?,?,?)`);
    stockRows.forEach(r => {
      const startSeq = 1;
      for (let i = 0; i < r.quantity; i++) {
        const code = r.code + '-' + String(startSeq + i).padStart(5, '0');
        try { insPiece.run(code, r.product_id, null, 'in_stock', r.cost_price || 0, 'legacy-backfill'); } catch (e) { /* dupe — skip */ }
      }
    });
  }

  // Seed default role permissions if matrix is empty
  const permCount = raw.prepare('SELECT COUNT(*) AS n FROM role_permissions').get().n;
  // Order: feature, owner, admin, accountant, salesperson, production, store, purchaser
  const featureDefaults = [
    ['dashboard',     'full', 'full', 'full', 'limited', 'limited', 'limited', 'limited'],
    ['products',      'full', 'full', 'view', 'view',    'view',    'view',    'view'   ],
    ['materials',     'full', 'full', 'view', 'none',    'full',    'full',    'full'   ],
    ['bom',           'full', 'full', 'view', 'none',    'view',    'none',    'view'   ],
    ['production',    'full', 'full', 'view', 'none',    'full',    'view',    'view'   ],
    ['fabric_costs',  'full', 'full', 'full', 'none',    'view',    'none',    'view'   ],
    ['stock',         'full', 'full', 'view', 'view',    'view',    'full',    'view'   ],
    ['dealers',       'full', 'full', 'view', 'limited', 'none',    'none',    'none'   ],
    ['sales',         'full', 'full', 'view', 'limited', 'none',    'view',    'none'   ],
    ['payments',      'full', 'full', 'full', 'limited', 'none',    'none',    'none'   ],
    ['dispatch',      'full', 'full', 'full', 'view',    'none',    'full',    'none'   ],
    ['reports',       'full', 'full', 'full', 'limited', 'limited', 'limited', 'limited'],
    ['notifications', 'full', 'full', 'full', 'limited', 'none',    'none',    'limited'],
    ['settings',      'full', 'full', 'none', 'none',    'none',    'none',    'none'   ],
    ['purchasing',    'full', 'full', 'view', 'none',    'view',    'view',    'full'   ],
    ['activity',      'full', 'full', 'view', 'none',    'none',    'none',    'none'   ],
    ['hr',            'full', 'full', 'full', 'none',    'view',    'view',    'view'   ],
    ['training',      'full', 'full', 'view', 'view',    'view',    'view',    'view'   ],
    ['visits',        'full', 'full', 'view', 'limited', 'none',    'none',    'none'   ],
    // Factory in/out is split from visits so anyone (production, store, etc.)
    // can punch their own attendance without seeing dealer visits.
    // 'limited' = can do their own in/out + see their own log row.
    // 'full'    = can also see the team factory log of everyone.
    ['factory_log',   'full', 'full', 'full', 'limited', 'limited', 'limited', 'limited'],
    // Tasks: everyone gets 'limited' so they can see their own assigned
    // tasks and update status. 'full' (owner/admin) can assign to others,
    // edit any task, and delete.
    ['tasks',         'full', 'full', 'limited', 'limited', 'limited', 'limited', 'limited'],
    // Admin Funds — only the owner sets up funds, tops them up, and sees
    // every admin's balance sheet. Admins with funds can see their own
    // balance via the "view" level (handled in-route).
    ['admin_funds',   'full', 'view', 'view', 'none',    'none',    'none',    'none'   ],
    // Standalone Catalogue / AI module — owner-driven by default. Set to
    // 'view' for anyone who should be able to browse the gallery; only owner
    // gets 'full' (i.e. can spend money calling fal.ai).
    ['catalogue',     'full', 'view', 'none', 'none',    'none',    'none',    'none'   ],
    // ── Fine-grained sub-features (introduced in Permission Matrix v2) ──
    // These split the coarse keys above so roles can be tuned precisely.
    // On top-up we copy the parent's existing level for each role rather than
    // using the static defaults below, so existing custom matrices keep their
    // current behaviour. Defaults here are used only for fresh installs.
    // Order: feature, owner, admin, accountant, salesperson, production, store, purchaser
    ['hr_employees',           'full', 'full', 'full', 'none',    'view',    'view',    'view'   ],
    ['hr_attendance',          'full', 'full', 'full', 'view',    'full',    'limited', 'view'   ],
    ['hr_payroll',             'full', 'full', 'full', 'none',    'none',    'none',    'none'   ],
    ['reports_sales',          'full', 'full', 'full', 'limited', 'view',    'view',    'view'   ],
    ['reports_production',     'full', 'full', 'view', 'none',    'limited', 'view',    'view'   ],
    ['reports_finance',        'full', 'full', 'full', 'none',    'none',    'none',    'none'   ],
    ['sales_orders',           'full', 'full', 'view', 'limited', 'none',    'view',    'none'   ],
    ['sales_invoices',         'full', 'full', 'full', 'view',    'none',    'view',    'none'   ],
    ['settings_users',         'full', 'full', 'none', 'none',    'none',    'none',    'none'   ],
    ['settings_access',        'full', 'full', 'none', 'none',    'none',    'none',    'none'   ],
    ['settings_payment_modes', 'full', 'full', 'full', 'none',    'none',    'none',    'none'   ],
    ['settings_categories',    'full', 'full', 'view', 'view',    'view',    'view',    'view'   ],
    ['settings_sms',           'full', 'full', 'view', 'none',    'none',    'none',    'none'   ],
    ['settings_stages',        'full', 'full', 'view', 'none',    'view',    'none',    'none'   ],
    ['settings_import',        'full', 'full', 'none', 'none',    'none',    'none',    'none'   ],
  ];
  // Sub-feature → parent map (kept in sync with src/middleware/permissions.js).
  // Used by the top-up logic to copy a parent's existing level when a new
  // sub-feature row is created — preserves any customisations the owner made
  // to the umbrella key.
  const FEATURE_PARENTS = {
    hr_employees: 'hr', hr_attendance: 'hr', hr_payroll: 'hr',
    reports_sales: 'reports', reports_production: 'reports', reports_finance: 'reports',
    sales_orders: 'sales', sales_invoices: 'sales',
    settings_users: 'settings', settings_access: 'settings',
    settings_payment_modes: 'settings', settings_categories: 'settings',
    settings_sms: 'settings', settings_stages: 'settings', settings_import: 'settings',
  };
  const roles = ['owner', 'admin', 'accountant', 'salesperson', 'production', 'store', 'purchaser'];
  if (permCount === 0) {
    const ins = raw.prepare('INSERT INTO role_permissions (role, feature_key, level) VALUES (?,?,?)');
    featureDefaults.forEach(row => {
      const feature = row[0];
      roles.forEach((role, idx) => ins.run(role, feature, row[idx + 1]));
    });
  } else {
    // Top up: ensure every (role × feature) combo from the defaults exists.
    // For NEW sub-feature keys, prefer the parent's currently-configured level
    // for each role over the static default — so an admin who tightened
    // `settings=limited` doesn't suddenly get full access to all settings_*.
    const ins = raw.prepare('INSERT OR IGNORE INTO role_permissions (role, feature_key, level) VALUES (?,?,?)');
    const getLvl = raw.prepare('SELECT level FROM role_permissions WHERE role=? AND feature_key=?');
    featureDefaults.forEach(row => {
      const feature = row[0];
      const parent = FEATURE_PARENTS[feature];
      roles.forEach((role, idx) => {
        let level = row[idx + 1];
        if (parent) {
          const pr = getLvl.get(role, parent);
          if (pr) level = pr.level;
        }
        ins.run(role, feature, level);
      });
    });
  }
}

function seedIfEmpty() {
  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (userCount > 0) return;
  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare(`INSERT INTO users (name,email,phone,password_hash,role) VALUES (?,?,?,?,?)`)
    .run('Owner', 'owner@portal.local', '9999999999', hash, 'owner');
  db.prepare(`INSERT INTO users (name,email,phone,password_hash,role) VALUES (?,?,?,?,?)`)
    .run('Admin', 'admin@portal.local', '8888888888', hash, 'admin');
  db.prepare(`INSERT INTO users (name,email,phone,password_hash,role) VALUES (?,?,?,?,?)`)
    .run('Salesperson 1', 'sales1@portal.local', '7777777777', hash, 'salesperson');

  const modes = ['Cash','UPI','Bank Transfer','Cheque','Card'];
  const insMode = db.prepare('INSERT INTO payment_modes (name) VALUES (?)');
  modes.forEach(m => insMode.run(m));

  const cats = ['Shirts','T-Shirts','Trousers','Jeans','Kurtis','Sarees'];
  const insCat = db.prepare('INSERT INTO product_categories (name) VALUES (?)');
  cats.forEach(c => insCat.run(c));

  const exp = ['Electricity','Rent','Salary','Transport','Misc','Tailoring'];
  const insExp = db.prepare('INSERT INTO expense_categories (name) VALUES (?)');
  exp.forEach(c => insExp.run(c));

  console.log('Seeded default users (owner@portal.local / admin@portal.local / sales1@portal.local — pwd: admin123)');
}

module.exports = { db, initDb };
