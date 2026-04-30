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
  ];
  const roles = ['owner', 'admin', 'accountant', 'salesperson', 'production', 'store', 'purchaser'];
  if (permCount === 0) {
    const ins = raw.prepare('INSERT INTO role_permissions (role, feature_key, level) VALUES (?,?,?)');
    featureDefaults.forEach(row => {
      const feature = row[0];
      roles.forEach((role, idx) => ins.run(role, feature, row[idx + 1]));
    });
  } else {
    // Top up: ensure every (role × feature) combo from the defaults exists, including new ones (purchasing, purchaser).
    const ins = raw.prepare('INSERT OR IGNORE INTO role_permissions (role, feature_key, level) VALUES (?,?,?)');
    featureDefaults.forEach(row => {
      const feature = row[0];
      roles.forEach((role, idx) => ins.run(role, feature, row[idx + 1]));
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
