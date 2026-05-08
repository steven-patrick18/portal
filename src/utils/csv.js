function escapeCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCsv(rows, columns) {
  const header = columns.map(escapeCell).join(',');
  const body = rows.map(r => columns.map(c => escapeCell(r[c])).join(',')).join('\r\n');
  return header + '\r\n' + body + (rows.length ? '\r\n' : '');
}

function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  // BOM so Excel opens UTF-8 correctly
  res.send('﻿' + csv);
}

module.exports = { toCsv, sendCsv, escapeCell };
