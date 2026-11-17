'use strict';
// Small shared parsers for dates / ids / amounts coming from Google Sheets.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MON3 = MONTHS.map(m => m.slice(0, 3).toLowerCase());

// '2023-10-20', '20/10/2023', '20-Oct-2023', '20 October 2023' -> '2023-10-20'; otherwise returns input trimmed
function isoDate(s) {
  s = String(s == null ? '' : s).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s); if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/.exec(s); if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  m = /^(\d{1,2})[\s\-]([A-Za-z]{3})[A-Za-z]*[\s\-,]+(\d{4})/.exec(s);
  if (m && MON3.includes(m[2].toLowerCase())) return m[3] + '-' + String(MON3.indexOf(m[2].toLowerCase()) + 1).padStart(2, '0') + '-' + m[1].padStart(2, '0');
  return s;
}
// '20-Oct-2023 11:02' (how the offer tool writes it) -> '2023-10-20 11:02'
function isoDateTime(s) {
  const str = String(s == null ? '' : s).trim();
  const d = isoDate(str);
  const t = /(\d{1,2}):(\d{2})/.exec(str.slice(8));
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d + (t ? ' ' + t[1].padStart(2, '0') + ':' + t[2] : '') : str;
}
// Drive URL or bare id -> id
function driveId(urlOrId) {
  const s = String(urlOrId || '').trim();
  const m = /\/d\/([A-Za-z0-9_-]{20,})/.exec(s) || /[?&]id=([A-Za-z0-9_-]{20,})/.exec(s);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{20,}$/.test(s) ? s : '';
}
// '₹14,000.00' -> 14000 ; '' -> null
function amount(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[₹,\s]|Rs\.?|INR/gi, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}
function digits(s) { return String(s || '').replace(/\D/g, '').slice(-10); }

module.exports = { MONTHS, isoDate, isoDateTime, driveId, amount, digits };
