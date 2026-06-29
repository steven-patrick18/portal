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
  // Credit-limit approval workflow: when a salesperson invoices a dealer over
  // their credit limit, the SO parks here until their reporting manager approves.
  ensureColumn('sales_orders',       'approval_status',   'approval_status TEXT');          // null | pending | approved | rejected
  ensureColumn('sales_orders',       'approval_by',       'approval_by INTEGER');           // the assigned/acting approver (users.id)
  ensureColumn('sales_orders',       'approval_at',       'approval_at TEXT');
  ensureColumn('sales_orders',       'approval_note',     'approval_note TEXT');
  ensureColumn('sales_orders',       'requested_by',      'requested_by INTEGER');          // who asked for approval
  ensureColumn('sales_orders',       'credit_approved',   'credit_approved INTEGER NOT NULL DEFAULT 0');
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

  // HR document fields — feed the offer/appointment letter merge and the
  // probation-confirmation tracking. All optional; merge falls back to
  // sensible placeholders so a half-filled employee still generates.
  ensureColumn('employees', 'father_name',       'father_name TEXT');
  ensureColumn('employees', 'dob',               'dob TEXT');
  ensureColumn('employees', 'probation_months',  'probation_months INTEGER NOT NULL DEFAULT 3');
  ensureColumn('employees', 'notice_period_days', 'notice_period_days INTEGER NOT NULL DEFAULT 30');
  ensureColumn('employees', 'confirmation_date', 'confirmation_date TEXT');
  ensureColumn('employees', 'reporting_to',      'reporting_to TEXT');
  // Optional custom salary breakup — JSON array [{name, amount}]. When
  // set, letters use these components; when empty/null, the standard
  // Basic/HRA/Special split is auto-calculated from base_salary.
  ensureColumn('employees', 'salary_components', 'salary_components TEXT');

  // ══ Website / public-site CMS (sharvexport.com) ═══════════════
  // Single-row content store for the public marketing site. Editable
  // from the ERP "Website" module; rendered by the no-auth /site route.
  raw.exec(`CREATE TABLE IF NOT EXISTS site_content (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    company_name TEXT, tagline TEXT,
    hero_title TEXT, hero_subtitle TEXT, hero_cta_text TEXT, hero_video_url TEXT,
    about_title TEXT, about_html TEXT,
    stats_json TEXT, why_json TEXT, process_json TEXT,
    phone TEXT, email TEXT, whatsapp TEXT, address TEXT,
    instagram TEXT, linkedin TEXT, facebook TEXT, youtube TEXT,
    meta_title TEXT, meta_desc TEXT, og_image TEXT,
    published INTEGER NOT NULL DEFAULT 1,
    updated_by INTEGER, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  raw.exec(`CREATE TABLE IF NOT EXISTS site_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, tagline TEXT, image_path TEXT,
    sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
  )`);
  raw.exec(`CREATE TABLE IF NOT EXISTS site_certifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, image_path TEXT,
    sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
  )`);
  // Phase 2 — buyer enquiries captured from the public site, + a
  // curated Instagram feed shown on the site.
  raw.exec(`CREATE TABLE IF NOT EXISTS site_enquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, company TEXT, phone TEXT, email TEXT,
    product_interest TEXT, message TEXT,
    status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','contacted','converted','spam','archived')),
    converted_dealer_id INTEGER,
    notes TEXT, handled_by INTEGER, ip TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (converted_dealer_id) REFERENCES dealers(id)
  )`);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_site_enq_status ON site_enquiries(status, id DESC)`);
  raw.exec(`CREATE TABLE IF NOT EXISTS site_instagram (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_path TEXT, caption TEXT, link TEXT,
    sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
  )`);
  // Phase 3 — search-engine verification tokens + a blog.
  ensureColumn('site_content', 'google_verification', 'google_verification TEXT');
  ensureColumn('site_content', 'bing_verification',   'bing_verification TEXT');
  // Pre-filled greeting for the floating WhatsApp button (?text=).
  ensureColumn('site_content', 'wa_greeting',         'wa_greeting TEXT');
  // Live auto-updating social feeds (embed approach).
  ensureColumn('site_content', 'fb_page_url',         'fb_page_url TEXT');   // Facebook Page Plugin
  ensureColumn('site_content', 'ig_embed_code',       'ig_embed_code TEXT'); // Instagram widget embed (SnapWidget/LightWidget)
  raw.exec(`CREATE TABLE IF NOT EXISTS site_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    excerpt TEXT,
    body_html TEXT,
    cover_image TEXT,
    meta_title TEXT, meta_desc TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
    published_at TEXT,
    updated_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_site_posts_pub ON site_posts(status, published_at DESC)`);

  // ── SMS templates (Fast2SMS / DLT) ────────────────────────────
  // One row per message. `event` ties it to an auto-fire hook
  // (invoice/payment/dispatch/outstanding) or 'manual'. `dlt_template_id`
  // is the Fast2SMS/DLT template id; `var_order` is the comma-separated
  // placeholder order the DLT template expects (for variables_values).
  raw.exec(`CREATE TABLE IF NOT EXISTS sms_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL DEFAULT 'manual',
    label TEXT NOT NULL,
    dlt_template_id TEXT,
    body TEXT NOT NULL,
    var_order TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  if (raw.prepare('SELECT COUNT(*) AS n FROM sms_templates').get().n === 0) {
    const insT = raw.prepare(`INSERT INTO sms_templates (event,label,dlt_template_id,body,var_order,active) VALUES (?,?,?,?,?,1)`);
    insT.run('invoice', 'Invoice generated', '', 'Dear {dealer}, your invoice {invoice_no} of Rs {amount} has been generated. Outstanding: Rs {outstanding}. Thank you - {company}', 'dealer,invoice_no,amount,outstanding');
    insT.run('payment', 'Payment received', '', 'Dear {dealer}, we have received your payment of Rs {amount}. Outstanding balance: Rs {outstanding}. Thank you - {company}', 'dealer,amount,outstanding');
    insT.run('dispatch', 'Dispatch created', '', 'Dear {dealer}, your order on invoice {invoice_no} has been dispatched. Vehicle {vehicle}, LR No {lr}. - {company}', 'dealer,invoice_no,vehicle,lr');
    insT.run('outstanding', 'Outstanding reminder', '', 'Dear {dealer}, your outstanding balance is Rs {amount} across {count} invoice(s). Please clear at earliest. - {company}', 'dealer,amount,count');
  }
  // Ledger / balance-awareness template — ensured separately so existing
  // installs (table already seeded) also get it. Sent on a schedule so each
  // dealer knows their official outstanding (guards against mis-stated balances).
  if (!raw.prepare("SELECT 1 FROM sms_templates WHERE event='ledger'").get()) {
    raw.prepare(`INSERT INTO sms_templates (event,label,dlt_template_id,body,var_order,active) VALUES ('ledger',?,?,?,?,1)`)
      .run('Ledger / balance awareness', '', 'Dear {dealer}, as per our records your current outstanding balance is Rs {outstanding}. Please tally with your ledger; for any difference contact us directly. - {company}', 'dealer,outstanding');
  }
  // Per-template DLT header. A DLT content template is bound to ONE header;
  // when an install uses more than one (e.g. SHA3RV + SHARVX) each template
  // must send under its own. Blank = use the account default sender id.
  ensureColumn('sms_templates', 'sender_id', 'sender_id TEXT');
  // dispatch & outstanding are registered under the SHARVX header — backfill
  // it once (only untouched rows; user edits set '' and are never clobbered).
  raw.exec("UPDATE sms_templates SET sender_id='SHARVX' WHERE event IN ('dispatch','outstanding') AND sender_id IS NULL");
  // The Fast2SMS `message` field wants Fast2SMS's OWN short Message ID (seen
  // in its Dev-API builder), NOT the 19-digit govt DLT Content Template ID.
  // Map each of Sharv's templates from the (wrong) DLT id to the Fast2SMS id.
  // Keyed on the exact wrong value, so it only ever corrects those rows once
  // and never touches a value the user has since changed.
  const F2_MSG_ID = {
    '1707178239816522596': '218659', // Payment   (SHA3RV)
    '1707178239996120902': '218660', // Ledger    (SHA3RV)
    '1707178240016425320': '218661', // Invoice   (SHA3RV)
    '1707178239967425409': '218662', // Dispatch  (SHARVX)
    '1707178240032175240': '218663', // Outstanding (SHARVX)
  };
  const fixMsg = raw.prepare('UPDATE sms_templates SET dlt_template_id=? WHERE dlt_template_id=?');
  for (const [dltId, f2Id] of Object.entries(F2_MSG_ID)) fixMsg.run(f2Id, dltId);

  // One-time scheduled campaign/promotional broadcasts (festival blasts etc.).
  raw.exec(`CREATE TABLE IF NOT EXISTS scheduled_broadcasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL,
    audience TEXT NOT NULL DEFAULT 'all',
    office_id INTEGER,
    extra_json TEXT,
    run_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','cancelled')),
    result TEXT,
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Daily Search Console rank snapshots → keyword position history (#7).
  raw.exec(`CREATE TABLE IF NOT EXISTS seo_rank_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day TEXT NOT NULL,
    query TEXT NOT NULL,
    position REAL, clicks INTEGER, impressions INTEGER,
    UNIQUE(day, query)
  )`);
  // Website change timeline ("what changed") shown against traffic (#3).
  raw.exec(`CREATE TABLE IF NOT EXISTS site_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    type TEXT NOT NULL,
    label TEXT
  )`);

  // ── Careers / hiring — public job openings + applications inbox ──
  raw.exec(`CREATE TABLE IF NOT EXISTS site_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    dept TEXT, location TEXT, type TEXT,
    summary TEXT, requirements TEXT,
    sort INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  raw.exec(`CREATE TABLE IF NOT EXISTS site_job_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER,
    role_applied TEXT,
    name TEXT NOT NULL, phone TEXT, email TEXT,
    experience TEXT, location TEXT, message TEXT, cv_path TEXT,
    status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','reviewed','shortlisted','rejected','hired','archived')),
    notes TEXT, handled_by INTEGER, ip TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (job_id) REFERENCES site_jobs(id)
  )`);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_site_jobapp_status ON site_job_applications(status, id DESC)`);
  ensureColumn('site_job_applications', 'cv_path', 'cv_path TEXT');   // résumé upload (added later)
  ensureColumn('site_job_applications', 'in_pipeline', 'in_pipeline INTEGER NOT NULL DEFAULT 0'); // promoted to HR applicant portal
  ensureColumn('site_job_applications', 'converted_employee_id', 'converted_employee_id INTEGER'); // set when hired → employee
  // Seed a starter set of openings (only when the table is empty).
  if (raw.prepare('SELECT COUNT(*) AS n FROM site_jobs').get().n === 0) {
    const insJ = raw.prepare('INSERT INTO site_jobs (title, dept, location, type, summary, requirements, sort) VALUES (?,?,?,?,?,?,?)');
    [
      ['Washing Master (Denim)', 'Production', 'Bettiah, Bihar', 'Full-time',
        'Lead our denim wash department — dry & wet process, shade matching and recipe control for jeans.',
        '5+ yrs in denim washing (enzyme, stone, bleach, PP spray). Can run sampling + bulk and keep rejections low.'],
      ['Pattern Master & Grader (CAD)', 'Production', 'Bettiah, Bihar', 'Full-time',
        'Make and grade patterns for jeans & garments; size-sets and marker planning.',
        '5+ yrs pattern making + grading. CAD (Gerber / Optitex / Tukatech) preferred. Strong fit sense.'],
      ['Fashion Designer', 'Design', 'Bettiah, Bihar', 'Full-time',
        'Design new denim & garment ranges — trend research, tech-packs and sampling follow-up.',
        'Degree/diploma in fashion design + portfolio. Knows denim, washes and current market trends.'],
      ['Tailors / Machine Operators', 'Production', 'Bettiah, Bihar', 'Full-time',
        'Single-needle / overlock / flatlock operators for the jeans line.',
        '2+ yrs stitching experience. Speed + quality. Training given for the right hands.'],
    ].forEach((r, i) => insJ.run(r[0], r[1], r[2], r[3], r[4], r[5], i));
  }

  // ── Email — SMTP templates + send log (HR / candidate communication) ──
  raw.exec(`CREATE TABLE IF NOT EXISTS email_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tkey TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'candidate',
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  raw.exec(`CREATE TABLE IF NOT EXISTS email_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    to_email TEXT, to_name TEXT, subject TEXT, body TEXT,
    template_key TEXT,
    context_type TEXT, context_id INTEGER,
    status TEXT NOT NULL DEFAULT 'sent',
    error TEXT, sent_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_email_log ON email_log(created_at DESC)`);
  // Incoming replies pulled from the hr@ mailbox via IMAP (matched to candidates by from-address).
  raw.exec(`CREATE TABLE IF NOT EXISTS email_inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT UNIQUE,
    from_email TEXT, from_name TEXT, subject TEXT, body TEXT,
    received_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_email_inbox_from ON email_inbox(from_email)`);
  if (raw.prepare('SELECT COUNT(*) AS n FROM email_templates').get().n === 0) {
    const insE = raw.prepare('INSERT INTO email_templates (tkey,label,category,subject,body,sort) VALUES (?,?,?,?,?,?)');
    const tpls = [
      ['app_received', 'Application received', 'candidate', 'We received your application — {company}',
        'Dear {name},\n\nThank you for applying for the {role} position at {company}. We have received your application and our team will review it shortly.\n\nIf your profile matches, we will contact you for the next steps.\n\nWarm regards,\n{sender}\n{company}'],
      ['app_review', 'Application under review', 'candidate', 'Your application is under review — {company}',
        'Dear {name},\n\nYour application for {role} at {company} is currently under review by our hiring team. We appreciate your patience.\n\nWe will update you soon.\n\nRegards,\n{sender}\n{company}'],
      ['interview_invite', 'Interview / meeting invite', 'candidate', 'Interview invitation — {role} at {company}',
        'Dear {name},\n\nWe are pleased to invite you for an interview for the {role} position.\n\nDate: {date}\nTime: {time}\nVenue: {place}\n\nPlease bring your CV, ID proof and relevant documents. Reply to confirm your availability.\n\nRegards,\n{sender}\n{company}'],
      ['shortlisted', 'Shortlisted', 'candidate', 'You have been shortlisted — {company}',
        'Dear {name},\n\nGood news! You have been shortlisted for the {role} position at {company}. Our team will contact you shortly with the next steps.\n\nRegards,\n{sender}\n{company}'],
      ['selected', 'Selected / offer', 'candidate', 'Congratulations — you are selected! {company}',
        'Dear {name},\n\nCongratulations! We are happy to offer you the {role} position at {company}. Our HR team will share your offer details and joining formalities soon.\n\nWelcome aboard!\n\nRegards,\n{sender}\n{company}'],
      ['regret', 'Regret (polite rejection)', 'candidate', 'Update on your application — {company}',
        'Dear {name},\n\nThank you for your interest in the {role} position at {company} and for the time you invested. After careful consideration, we have decided to move forward with other candidates for this role.\n\nWe will keep your profile on file for future openings and wish you all the best.\n\nRegards,\n{sender}\n{company}'],
      ['documents_request', 'Document request', 'candidate', 'Please share your documents — {company}',
        'Dear {name},\n\nTo proceed with your application for {role}, please share the following documents:\n- Updated CV / resume\n- ID proof (Aadhaar / PAN)\n- Last salary slip (if any)\n- Experience / relieving letters\n\nKindly reply to this email with the documents attached.\n\nRegards,\n{sender}\n{company}'],
      ['meeting_invite', 'Meeting invite (staff)', 'employee', 'Meeting — {date} at {time}',
        'Dear {name},\n\nYou are requested to attend a meeting:\n\nDate: {date}\nTime: {time}\nVenue: {place}\n\nPlease be on time.\n\nRegards,\n{sender}\n{company}'],
      ['welcome_onboarding', 'Welcome / onboarding (staff)', 'employee', 'Welcome to {company}!',
        'Dear {name},\n\nWelcome to the {company} family! We are excited to have you join us as {role}.\n\nYour reporting date is {date}. Please report to the office with your documents. Our HR team will help you settle in.\n\nWarm regards,\n{sender}\n{company}'],
      ['general_notice', 'General notice (staff)', 'employee', 'Important notice — {company}',
        'Dear {name},\n\n{message}\n\nRegards,\n{sender}\n{company}'],
    ];
    tpls.forEach((t, i) => insE.run(t[0], t[1], t[2], t[3], t[4], i));
  }

  // Background bulk-SMS jobs (broadcast / ledger / survey push) — live status.
  raw.exec(`CREATE TABLE IF NOT EXISTS sms_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT, label TEXT,
    total INTEGER NOT NULL DEFAULT 0,
    sent INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'running',
    error TEXT, created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  )`);

  // ── Survey module ─────────────────────────────────────────────
  raw.exec(`CREATE TABLE IF NOT EXISTS surveys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    thank_you TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  raw.exec(`CREATE TABLE IF NOT EXISTS survey_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    survey_id INTEGER NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    qtype TEXT NOT NULL DEFAULT 'rating',
    qtext TEXT NOT NULL,
    options_json TEXT,
    required INTEGER NOT NULL DEFAULT 1
  )`);
  raw.exec(`CREATE TABLE IF NOT EXISTS survey_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    survey_id INTEGER NOT NULL,
    dealer_id INTEGER,
    name TEXT, phone TEXT,
    source TEXT NOT NULL DEFAULT 'web',
    submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  raw.exec(`CREATE TABLE IF NOT EXISTS survey_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    response_id INTEGER NOT NULL,
    question_id INTEGER NOT NULL,
    value TEXT
  )`);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_survey_resp ON survey_responses(survey_id, submitted_at DESC)`);
  // Bilingual (Hindi) columns — added idempotently so existing installs gain
  // them too. Must exist before seed/backfill below.
  ensureColumn('surveys', 'title_hi', 'title_hi TEXT');
  ensureColumn('surveys', 'description_hi', 'description_hi TEXT');
  ensureColumn('surveys', 'thank_you_hi', 'thank_you_hi TEXT');
  ensureColumn('survey_questions', 'qtext_hi', 'qtext_hi TEXT');
  ensureColumn('survey_questions', 'options_hi_json', 'options_hi_json TEXT');
  try {
    const surveySeed = require('./surveySeed');
    surveySeed.seedSurveys(raw);
    surveySeed.ensureSurveySmsTemplate(raw);
    surveySeed.backfillHindi(raw);   // fill Hindi onto already-seeded surveys
    // Repair templates whose event was reset to 'invoice' by an older editor
    // that lacked the survey/ledger options. {link} is unique to the survey
    // template; the ledger label is unique to the ledger template.
    raw.exec("UPDATE sms_templates SET event='survey' WHERE event<>'survey' AND (label='Survey invitation' OR body LIKE '%{link}%')");
    raw.exec("UPDATE sms_templates SET event='ledger' WHERE event<>'ledger' AND label LIKE 'Ledger%balance%'");
  } catch (e) { console.error('[survey seed]', e.message); }

  // Seed the home-page content once (fresh installs / first run).
  const siteSeeded = raw.prepare('SELECT COUNT(*) AS n FROM site_content').get().n;
  if (siteSeeded === 0) {
    const stats = JSON.stringify([
      { value: '10,000+', label: 'Garments / day capacity' },
      { value: '15+',     label: 'Years of manufacturing' },
      { value: '100%',    label: 'In-house production' },
      { value: 'PAN-India', label: 'Dealer network' },
    ]);
    const why = JSON.stringify([
      { icon: '🏭', title: 'Fully Integrated Unit', text: 'Cutting, stitching, washing, finishing and packing — all under one roof for tight quality control and on-time delivery.' },
      { icon: '✂️', title: 'Skilled Workforce',     text: 'Trained tailors and supervisors producing consistent, export-grade stitching at scale.' },
      { icon: '🎯', title: 'Custom & Private Label', text: 'We manufacture to your specifications — fabric, fit, branding and packing as per buyer requirement.' },
      { icon: '🚚', title: 'Reliable Supply',        text: 'Streamlined production planning and dispatch so your orders ship complete and on schedule.' },
    ]);
    const process = JSON.stringify([
      { step: '01', title: 'Fabric & Sourcing',  text: 'Quality fabric and trims sourced and inspected before production.' },
      { step: '02', title: 'Cutting',            text: 'Precision cutting for accurate sizing and minimal wastage.' },
      { step: '03', title: 'Stitching',          text: 'Operation-wise stitching lines with in-process quality checks.' },
      { step: '04', title: 'Washing & Finishing',text: 'Washing, pressing and finishing to a premium standard.' },
      { step: '05', title: 'QC & Packing',       text: 'Final quality inspection, tagging and export-ready packing.' },
    ]);
    raw.prepare(`INSERT INTO site_content
      (id, company_name, tagline, hero_title, hero_subtitle, hero_cta_text, hero_video_url,
       about_title, about_html, stats_json, why_json, process_json,
       phone, email, whatsapp, address, instagram, linkedin, facebook, youtube,
       meta_title, meta_desc)
      VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        'Sharv Enterprises',
        'Readymade Garment Manufacturer & Exporter',
        'Garments, Manufactured Right.',
        'A fully integrated garment manufacturing unit producing shirts, jeans, trousers and more — at export quality, at scale, for buyers across India and beyond.',
        'Enquire Now', '',
        'About Sharv Enterprises',
        '<p>Sharv Enterprises is a vertically integrated readymade-garment manufacturer based in Bettiah, Bihar. From fabric sourcing through cutting, stitching, washing, finishing and packing, every stage happens in-house — giving us complete control over quality, cost and delivery.</p><p>We manufacture the full range of garments for retailers, wholesalers, institutions and private-label buyers, and we welcome custom and bulk orders to specification.</p>',
        stats, why, process,
        '', 'info@sharvexports.com', '', 'Bettiah, West Champaran, Bihar, India',
        'https://instagram.com/sharvexports', 'https://linkedin.com/company/sharvexports',
        'https://facebook.com/sharvexports', 'https://youtube.com/@sharvexports',
        'Sharv Enterprises — Garment Manufacturer & Exporter',
        'Sharv Enterprises is an integrated readymade garment manufacturer and exporter in Bihar, India — shirts, jeans, trousers, t-shirts and private-label apparel at export quality and scale.'
      );
    // Product lineup (designed by us — "we manufacture all garments").
    const prods = [
      ['Formal Shirts',  'Crisp office and dress shirts'],
      ['Casual Shirts',  'Everyday and fashion shirts'],
      ['Denim Jeans',    'Washed & finished denim'],
      ['Trousers',       'Formal and casual bottoms'],
      ['T-Shirts',       'Round-neck, polo & printed tees'],
      ['Kids Wear',      'Durable, comfortable children’s clothing'],
      ['Ladies Wear',    'Tops, kurtis and ladies garments'],
      ['Uniforms',       'School, corporate & institutional uniforms'],
    ];
    const insP = raw.prepare('INSERT INTO site_products (name, tagline, sort) VALUES (?,?,?)');
    prods.forEach((p, i) => insP.run(p[0], p[1], i));
    // Target certifications (names now; photos uploaded after obtaining).
    const certs = ['ISO 9001:2015', 'OEKO-TEX Standard 100', 'GOTS (Organic)', 'SEDEX / SMETA', 'GST Registered', 'MSME / Udyam Registered'];
    const insC = raw.prepare('INSERT INTO site_certifications (name, sort) VALUES (?,?)');
    certs.forEach((c, i) => insC.run(c, i));
  }

  // ── HR documents (offer / appointment / relieving / warning / …) ──
  // Each issued letter freezes its rendered HTML so a later template
  // edit never alters a document the employee already signed. The
  // signed scan is uploaded back against the row.
  raw.exec(`CREATE TABLE IF NOT EXISTS employee_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_no TEXT,
    employee_id INTEGER NOT NULL,
    doc_type TEXT NOT NULL,
    title TEXT NOT NULL,
    body_html TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','issued','filed')),
    issued_date TEXT,
    signed_doc_path TEXT,
    notes TEXT,
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id)
  )`);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_emp_docs_emp ON employee_documents(employee_id)`);
  // Backstop against two simultaneous "Issue" actions minting the same
  // number. NULL doc_no (drafts) are treated as distinct by SQLite, so
  // multiple drafts coexist fine; only issued numbers must be unique.
  raw.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_emp_docs_no ON employee_documents(doc_type, doc_no)`);

  // ── Company policy handbook (single living document, versioned) ──
  // One handbook covers all staff (workers + sales + management). The
  // owner edits the body; bumping the version invalidates prior
  // acknowledgments so everyone re-signs the new edition.
  raw.exec(`CREATE TABLE IF NOT EXISTS company_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    body_html TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    effective_date TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    updated_by INTEGER,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // ── Per-employee acknowledgment of a policy version ──
  raw.exec(`CREATE TABLE IF NOT EXISTS policy_acknowledgments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    policy_id INTEGER NOT NULL,
    employee_id INTEGER NOT NULL,
    version INTEGER NOT NULL,
    ack_date TEXT NOT NULL DEFAULT (date('now')),
    signed_doc_path TEXT,
    method TEXT,
    recorded_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (policy_id, employee_id, version),
    FOREIGN KEY (policy_id) REFERENCES company_policies(id) ON DELETE CASCADE,
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
  )`);

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
  // One-time: standardise the company email to info@sharvexports.com
  // everywhere (company branding → letterhead/brand docs/print headers, and
  // the public website → home/contact/footer). Guarded by a flag so a later
  // manual change in Settings/Website sticks.
  if (!raw.prepare("SELECT 1 FROM app_settings WHERE key='EMAIL_STD_INFO'").get()) {
    raw.prepare("INSERT INTO app_settings (key,value) VALUES ('COMPANY_EMAIL','info@sharvexports.com') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
    try { raw.prepare("UPDATE site_content SET email='info@sharvexports.com' WHERE id=1").run(); } catch (_) {}
    raw.prepare("INSERT INTO app_settings (key,value) VALUES ('EMAIL_STD_INFO','1')").run();
  }

  // ── Credit Score factors ─────────────────────────────────────────────
  // Configurable scoring factors for the Credit Score module. Each row maps to
  // a `metric_type` the engine knows how to compute (see utils/creditScore.js);
  // weight = relative importance; params = JSON thresholds. Built-in factors
  // can be re-weighted / tuned / switched off; custom ones can also be deleted.
  raw.exec(`CREATE TABLE IF NOT EXISTS credit_factors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    description TEXT,
    metric_type TEXT NOT NULL,
    weight REAL NOT NULL DEFAULT 1,
    params TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    builtin INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  // Built-in factors. Upserted by key (ON CONFLICT DO NOTHING) so new built-ins
  // are added to existing installs over time WITHOUT overwriting any weights/
  // params the owner has already tuned. Custom factors are untouched.
  {
    const cf = raw.prepare('INSERT INTO credit_factors (key,label,description,metric_type,weight,params,active,builtin,sort_order) VALUES (?,?,?,?,?,?,?,1,?) ON CONFLICT(key) DO NOTHING');
    [
      ['pay_ratio',      'Payment record',             'How much of total dues the dealer has actually paid.',                'pay_ratio',             22, null, 1, 1],
      ['business_value', 'Business value',             'Bigger lifetime buyers score higher — rewards dealers who grow our sales.', 'business_value', 14, JSON.stringify({ full_value: 500000 }), 1, 2],
      ['prompt_pay',     'Prompt payment',             'Pays before bills get old (age of oldest unpaid bill).',              'overdue_age',           14, JSON.stringify({ grace_days: 30, bad_days: 90 }), 1, 3],
      ['overdue_invoices','Few overdue invoices',      'Share of their invoices that are NOT still unpaid/partial.',          'overdue_invoice_ratio',  9, null, 1, 4],
      ['low_burden',     'Low outstanding burden',     'Current dues are small versus total business done.',                  'outstanding_burden',     8, null, 1, 5],
      ['credit_util',    'Low credit utilisation',     'Uses only part of the credit limit you set (over-limit hurts).',      'credit_utilization',     7, null, 1, 6],
      ['full_payment',   'Pays in full (not dribbles)','Settles bills in a few payments, not many tiny part-payments.',       'payment_consolidation',  7, JSON.stringify({ worst: 4 }), 1, 7],
      ['cleared_invoices','Clears invoices fully',     'Share of their invoices marked fully paid.',                          'cleared_invoice_ratio',  6, null, 1, 8],
      ['recency',        'Recently active',            'Ordered recently (an active, engaged buyer).',                        'recency',                5, JSON.stringify({ fresh_days: 30, stale_days: 180 }), 1, 9],
      ['loyalty',        'Loyalty / tenure',           'Longer-running relationship counts in their favour.',                 'tenure',                 5, JSON.stringify({ full_months: 24 }), 1, 10],
      ['avg_order',      'Average order size',         'Bigger typical order value.',                                         'avg_order_value',        5, JSON.stringify({ full_value: 20000 }), 1, 11],
      ['consistency',    'Buys consistently',          'Orders in most months they have been on our books.',                  'purchase_consistency',   4, null, 1, 12],
      ['low_returns',    'Low returns',                'Few goods sent back versus billed.',                                  'returns_ratio',          4, JSON.stringify({ bad: 0.25 }), 1, 13],
      ['order_freq',     'Orders often',               'How often they place orders (orders per active month).',              'order_frequency',        3, JSON.stringify({ full_per_month: 4 }), 0, 14],
      ['growth',         'Growing buyer',              'Buying in the last 90 days vs the 90 days before.',                    'growth_trend',           3, JSON.stringify({ full_growth: 1 }), 0, 15],
    ].forEach(r => cf.run(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7]));
  }
  // Suggested-limit settings (global, JSON in app_settings).
  if (!raw.prepare("SELECT 1 FROM app_settings WHERE key='CREDIT_SETTINGS'").get()) {
    raw.prepare("INSERT INTO app_settings (key,value) VALUES ('CREDIT_SETTINGS', ?)").run(JSON.stringify({
      monthsByGrade: { A: 1.5, B: 1, C: 0.5, D: 0.25, E: 0 },
      businessBoost: 0.5, businessBoostRef: 500000,
      shortHistoryMonths: 3, shortHistoryDamp: 0.5, round: 500,
    }));
  }

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
    // Credit Score & Limits — view scores; only 'full' can change factors or
    // apply credit limits. Salesperson sees scores of their dealers (view).
    ['credit',        'full', 'full', 'full', 'view',    'none',    'none',    'none'   ],
    ['sales',         'full', 'full', 'view', 'limited', 'none',    'view',    'none'   ],
    ['payments',      'full', 'full', 'full', 'limited', 'none',    'none',    'none'   ],
    ['dispatch',      'full', 'full', 'full', 'view',    'none',    'full',    'none'   ],
    ['reports',       'full', 'full', 'full', 'limited', 'limited', 'limited', 'limited'],
    ['notifications', 'full', 'full', 'full', 'limited', 'none',    'none',    'limited'],
    ['surveys',       'full', 'full', 'full', 'limited', 'none',    'none',    'none'   ],
    ['sms_reports',   'full', 'full', 'full', 'none',    'none',    'none',    'none'   ],
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
    ['website',       'full', 'full', 'none', 'none',    'none',    'none',    'none'   ],
    ['website_enquiries', 'full', 'full', 'none', 'limited', 'none', 'none', 'none' ],
    ['website_insights',  'full', 'full', 'view', 'none',    'none', 'none', 'none' ],
    ['website_careers',   'full', 'full', 'none', 'none',    'none', 'none', 'none' ],
    ['website_brand',     'full', 'full', 'none', 'none',    'none', 'none', 'none' ],
    // ── Fine-grained sub-features (introduced in Permission Matrix v2) ──
    // These split the coarse keys above so roles can be tuned precisely.
    // On top-up we copy the parent's existing level for each role rather than
    // using the static defaults below, so existing custom matrices keep their
    // current behaviour. Defaults here are used only for fresh installs.
    // Order: feature, owner, admin, accountant, salesperson, production, store, purchaser
    ['hr_employees',           'full', 'full', 'full', 'none',    'view',    'view',    'view'   ],
    ['hr_attendance',          'full', 'full', 'full', 'view',    'full',    'limited', 'view'   ],
    ['hr_payroll',             'full', 'full', 'full', 'none',    'none',    'none',    'none'   ],
    ['hr_documents',           'full', 'full', 'full', 'none',    'none',    'none',    'none'   ],
    ['hr_recruitment',         'full', 'full', 'none', 'none',    'none',    'none',    'none'   ],
    ['reports_sales',          'full', 'full', 'full', 'limited', 'view',    'view',    'view'   ],
    ['reports_production',     'full', 'full', 'view', 'none',    'limited', 'view',    'view'   ],
    ['reports_finance',        'full', 'full', 'full', 'none',    'none',    'none',    'none'   ],
    ['sales_orders',           'full', 'full', 'view', 'limited', 'none',    'view',    'none'   ],
    ['sales_invoices',         'full', 'full', 'full', 'view',    'none',    'view',    'none'   ],
    // Field sub-pages — default to the same as `visits` for each role; parent
    // top-up below copies the live `visits` level so existing matrices carry over.
    ['visits_prospects',       'full', 'full', 'view', 'limited', 'none',    'none',    'none'   ],
    ['visits_plan',            'full', 'full', 'view', 'limited', 'none',    'none',    'none'   ],
    ['visits_map',             'full', 'full', 'view', 'limited', 'none',    'none',    'none'   ],
    ['visits_km',              'full', 'full', 'view', 'limited', 'none',    'none',    'none'   ],
    ['settings_users',         'full', 'full', 'none', 'none',    'none',    'none',    'none'   ],
    ['settings_access',        'full', 'full', 'none', 'none',    'none',    'none',    'none'   ],
    ['settings_locations',     'full', 'full', 'none', 'none',    'none',    'none',    'none'   ],
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
    hr_employees: 'hr', hr_attendance: 'hr', hr_payroll: 'hr', hr_documents: 'hr', hr_recruitment: 'hr',
    reports_sales: 'reports', reports_production: 'reports', reports_finance: 'reports',
    sales_orders: 'sales', sales_invoices: 'sales',
    visits_map: 'visits', visits_km: 'visits', visits_prospects: 'visits', visits_plan: 'visits',
    settings_users: 'settings', settings_access: 'settings', settings_locations: 'settings',
    settings_payment_modes: 'settings', settings_categories: 'settings',
    settings_sms: 'settings', settings_stages: 'settings', settings_import: 'settings',
    website_enquiries: 'website', website_insights: 'website',
    website_careers: 'website', website_brand: 'website',
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
