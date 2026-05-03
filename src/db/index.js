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
  ensureColumn('sales_orders',       'discount_amount',   'discount_amount REAL NOT NULL DEFAULT 0');
  ensureColumn('invoices',           'discount_amount',   'discount_amount REAL NOT NULL DEFAULT 0');
  // Org hierarchy — each user can report to another user (their manager).
  // Nullable because top-level (owner) reports to nobody.
  ensureColumn('users',              'reports_to',        'reports_to INTEGER REFERENCES users(id)');

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

  // Drop the CHECK constraint on users.role so we can add new roles like 'purchaser'.
  // Many tables FK-reference users(id), so we must temporarily disable FK enforcement during the swap.
  const usersInfo = raw.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='users'`).get();
  if (usersInfo && /CHECK\s*\(\s*role\s+IN/i.test(usersInfo.sql)) {
    raw.exec('PRAGMA foreign_keys = OFF');
    try {
      // Clean up any orphan from a prior failed migration attempt
      raw.exec('DROP TABLE IF EXISTS users_new');
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
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO users_new SELECT * FROM users;
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
        FOREIGN KEY (batch_id) REFERENCES production_batches(id),
        FOREIGN KEY (created_by) REFERENCES users(id)
      );
      INSERT INTO production_stage_entries_new SELECT * FROM production_stage_entries;
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
