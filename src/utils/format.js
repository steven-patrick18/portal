function fmtINR(n) {
  if (n === null || n === undefined || isNaN(n)) return '₹0';
  const num = Number(n);
  // Indian numbering: lakhs/crores
  const sign = num < 0 ? '-' : '';
  const abs = Math.abs(num);
  const fixed = abs.toFixed(2);
  const [intPart, decPart] = fixed.split('.');
  let lastThree = intPart.slice(-3);
  const otherNumbers = intPart.slice(0, -3);
  if (otherNumbers !== '') lastThree = ',' + lastThree;
  const formatted = otherNumbers.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + lastThree;
  return `${sign}₹${formatted}.${decPart}`;
}

// Default display timezone. SQLite stores datetime('now') as UTC; the
// business is in India so we convert at the display layer.
const DISPLAY_TZ = process.env.DISPLAY_TZ || 'Asia/Kolkata';

// Parse a SQLite-style datetime string into a Date. SQLite returns UTC like
// "2026-05-08 16:02:33" with NO timezone suffix; Node's Date() would treat
// that as local time, which is wrong. We append "Z" so it's parsed as UTC.
function parseDbDate(d) {
  if (!d) return null;
  if (d instanceof Date) return d;
  let s = String(d);
  // "YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DDTHH:MM:SS" with no TZ → treat as UTC
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    s = s.replace(' ', 'T') + 'Z';
  }
  const date = new Date(s);
  return isNaN(date.getTime()) ? null : date;
}

function _partsInTz(date, tz) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const o = {};
  for (const x of p) if (x.type !== 'literal') o[x.type] = x.value;
  // en-GB returns "24" instead of "00" for midnight in some Node versions
  if (o.hour === '24') o.hour = '00';
  return o;
}

function fmtDate(d) {
  const date = parseDbDate(d);
  if (!date) return d || '';
  const p = _partsInTz(date, DISPLAY_TZ);
  return `${p.day}-${p.month}-${p.year}`;
}

function fmtDateTime(d) {
  const date = parseDbDate(d);
  if (!date) return d || '';
  const p = _partsInTz(date, DISPLAY_TZ);
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}`;
}

function fmtTime(d) {
  const date = parseDbDate(d);
  if (!date) return '';
  const p = _partsInTz(date, DISPLAY_TZ);
  return `${p.hour}:${p.minute}`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function todayLocal() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function genCode(prefix, n) {
  return `${prefix}${String(n).padStart(5, '0')}`;
}

module.exports = { fmtINR, fmtDate, fmtDateTime, fmtTime, todayISO, todayLocal, genCode };
