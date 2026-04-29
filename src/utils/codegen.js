const { db } = require('../db');

function nextCode(table, column, prefix, width = 5) {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  let candidate;
  let n = row.n;
  // ensure uniqueness in case of gaps
  while (true) {
    n += 1;
    candidate = `${prefix}${String(n).padStart(width, '0')}`;
    const exists = db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`).get(candidate);
    if (!exists) return candidate;
  }
}

module.exports = { nextCode };
