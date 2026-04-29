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
  seedIfEmpty();
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
