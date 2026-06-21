// eTimeOffice (Team Office) cloud API client.
//
// The owner's office biometric pushes punches to etimeoffice.com; this
// client pulls the day-wise in/out summary back into the ERP. Endpoint
// format reverse-engineered from the vendor's partner integrations
// (same shape Horilla HRMS uses):
//
//   GET https://api.etimeoffice.com/api/DownloadInOutPunchData
//       ?Empcode=ALL&FromDate=DD/MM/YYYY&ToDate=DD/MM/YYYY
//   Authorization: Basic base64("corpId:username:password:true" + ":")
//
// Response: { Error: false, Msg: 'Success', InOutPunchData: [
//   { Empcode, Name, DateString: 'DD/MM/YYYY', INTime: 'HH:MM',
//     OUTTime: 'HH:MM', Status: 'P'|'A'|'WO'|'½P'|..., Remark, ... } ] }

const { db } = require('../db');

const BASE = 'https://api.etimeoffice.com/api/';

function getSetting(key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  return row ? row.value : null;
}

function saveSetting(key, value, userId) {
  db.prepare(`INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?,?,datetime('now'),?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
    .run(key, value, userId || null);
}

function getCredentials() {
  return {
    corpId:   getSetting('ETO_CORP_ID') || '',
    username: getSetting('ETO_USERNAME') || '',
    password: getSetting('ETO_PASSWORD') || '',
  };
}

function configured() {
  const c = getCredentials();
  return !!(c.corpId && c.username && c.password);
}

// 'YYYY-MM-DD' → 'DD/MM/YYYY' (the API's expected format)
function toApiDate(iso) {
  const [y, m, d] = String(iso).split('-');
  return `${d}/${m}/${y}`;
}

// 'DD/MM/YYYY' → 'YYYY-MM-DD'
function fromApiDate(s) {
  const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// Map eTimeOffice status strings onto our attendance enum.
//   P → present · A → absent · WO/H/HLD → holiday · L/CL/SL/EL → leave
//   ½P / 0.5P / HD → half_day. Anything unknown but with an IN punch →
//   present; otherwise null (skip — don't invent absences).
function mapStatus(raw, inTime) {
  const s = String(raw || '').trim().toUpperCase();
  if (!s) return inTime ? 'present' : null;
  if (s.includes('½') || s.includes('0.5') || s === 'HD' || s.includes('HALF')) return 'half_day';
  // Mixed present+absent strings (half-day) MUST be tested before the
  // plain-present check, else 'P/A' matches startsWith('P/') and is
  // wrongly recorded as a full present day.
  if (s.includes('P') && s.includes('A') && !s.includes('PRESENT')) return 'half_day';
  if (s === 'P' || s === 'PP' || s.includes('PRESENT')) return 'present';
  if (s === 'A' || s.includes('ABSENT')) return 'absent';
  if (s === 'WO' || s === 'H' || s === 'HLD' || s.includes('HOLIDAY') || s.includes('WEEKLY')) return 'holiday';
  if (s === 'L' || s === 'CL' || s === 'SL' || s === 'EL' || s.includes('LEAVE')) return 'leave';
  if (s.includes('P')) return 'present';
  if (s.includes('A')) return 'absent';
  return inTime ? 'present' : null;
}

// Pull day-wise in/out rows for the range. Returns { ok, rows, error }.
async function fetchInOutPunchData(fromIso, toIso) {
  if (!configured()) return { ok: false, error: 'eTimeOffice credentials not set. Save them first.' };
  const c = getCredentials();
  const authUser = `${c.corpId}:${c.username}:${c.password}:true`;
  const url = BASE + 'DownloadInOutPunchData?Empcode=ALL'
    + '&FromDate=' + encodeURIComponent(toApiDate(fromIso))
    + '&ToDate='   + encodeURIComponent(toApiDate(toIso));
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: 'Basic ' + Buffer.from(authUser + ':').toString('base64') },
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    return { ok: false, error: 'Could not reach api.etimeoffice.com: ' + e.message };
  }
  if (!res.ok) return { ok: false, error: `eTimeOffice HTTP ${res.status} — check credentials.` };
  let body;
  try { body = await res.json(); }
  catch (_) { return { ok: false, error: 'eTimeOffice returned non-JSON (likely bad credentials).' }; }
  if (body.Error === true || (body.Msg && !/success/i.test(String(body.Msg)))) {
    return { ok: false, error: 'eTimeOffice error: ' + (body.Msg || 'unknown') };
  }
  const rows = Array.isArray(body.InOutPunchData) ? body.InOutPunchData : [];
  return { ok: true, rows };
}

module.exports = { getCredentials, saveSetting, configured, fetchInOutPunchData, mapStatus, fromApiDate };
