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

// Like fmtINR but preserves sub-paisa precision for unit prices.
// Raw materials like packing labels can cost ₹0.0008 / pc — over 10,000
// pieces that's ₹8, and rounding to ₹0.00 would hide the rate entirely.
// Shows 2 decimals minimum (so ₹100 prints as ₹100.00) and up to 4
// decimals for finer-grained values, trimming trailing zeros past the
// 2-decimal floor.
function fmtRate(n) {
  if (n === null || n === undefined || isNaN(n)) return '₹0.00';
  const num = Number(n);
  const sign = num < 0 ? '-' : '';
  const abs = Math.abs(num);
  // Render with 4 decimals, then trim trailing zeros — but never trim
  // below 2 decimals (so 100 stays as 100.00, not 100).
  let fixed = abs.toFixed(4);
  // Strip trailing 0s but leave at least 2 after the dot.
  fixed = fixed.replace(/(\.\d{2})(\d*?)0+$/, '$1$2');
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

// Amount in words, Indian numbering (lakh / crore). Used on printed
// salary slips and other money documents where the written-out amount
// is the legally-binding one. e.g. 123456.50 →
// "One Lakh Twenty Three Thousand Four Hundred Fifty Six Rupees and Fifty Paise Only"
function amountInWordsINR(n) {
  if (n === null || n === undefined || isNaN(n)) return '';
  const num = Math.abs(Number(n));
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  function two(x) {
    if (x < 20) return ones[x];
    return tens[Math.floor(x / 10)] + (x % 10 ? ' ' + ones[x % 10] : '');
  }
  function three(x) {
    return (x >= 100 ? ones[Math.floor(x / 100)] + ' Hundred' + (x % 100 ? ' ' : '') : '') + (x % 100 ? two(x % 100) : '');
  }
  let rupees = Math.floor(num);
  const paise = Math.round((num - rupees) * 100);
  if (rupees === 0 && paise === 0) return 'Zero Rupees Only';
  const parts = [];
  const crore = Math.floor(rupees / 10000000); rupees %= 10000000;
  const lakh  = Math.floor(rupees / 100000);   rupees %= 100000;
  const thou  = Math.floor(rupees / 1000);     rupees %= 1000;
  if (crore)  parts.push(three(crore) + ' Crore');
  if (lakh)   parts.push(three(lakh) + ' Lakh');
  if (thou)   parts.push(three(thou) + ' Thousand');
  if (rupees) parts.push(three(rupees));
  let out = parts.length ? parts.join(' ') + ' Rupees' : '';
  if (paise) out += (out ? ' and ' : '') + two(paise) + ' Paise';
  return (Number(n) < 0 ? 'Minus ' : '') + out + ' Only';
}

module.exports = { fmtINR, fmtRate, fmtDate, fmtDateTime, fmtTime, todayISO, todayLocal, genCode, amountInWordsINR };
