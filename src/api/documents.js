'use strict';
// Offer letters + NAPS payslips, read from Google Sheets; PDFs from Google Drive.
// Uses a Google service account (GOOGLE_APPLICATION_CREDENTIALS). Share the two
// sheets and the PDF folders with the service account's email as Viewer.
const config = require('../config');
const { audit } = require('../db');
const E = require('../employees');

const G = config.google;
let clients = null;
function google() {
  if (!G.credentialsFile) return null;
  if (clients) return clients;
  const { sheets, auth } = require('@googleapis/sheets');
  const { drive } = require('@googleapis/drive');
  const a = new auth.GoogleAuth({
    keyFile: G.credentialsFile,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly', 'https://www.googleapis.com/auth/drive.readonly'],
  });
  clients = { sheets: sheets({ version: 'v4', auth: a }), drive: drive({ version: 'v3', auth: a }) };
  return clients;
}

// ---- sheet reading with a small cache ----
const cache = new Map();
async function readSheet(id, tab) {
  const key = id + '|' + tab;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < G.cacheSeconds * 1000) return hit.rows;
  const r = await google().sheets.spreadsheets.values.get({
    spreadsheetId: id, range: "'" + tab.replace(/'/g, "''") + "'", valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING',
  });
  const values = r.data.values || [];
  const head = (values[0] || []).map(h => String(h).trim());
  const rows = values.slice(1).map((v, i) => {
    const o = { _row: i + 2 };
    head.forEach((h, j) => { if (h) o[h] = v[j] == null ? '' : v[j]; });
    return o;
  });
  cache.set(key, { at: Date.now(), rows });
  return rows;
}

// ---- helpers ----
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MON3 = MONTHS.map(m => m.slice(0, 3).toLowerCase());
function isoDate(s) {
  s = String(s || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/.exec(s); if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  m = /^(\d{1,2})[\s\-]([A-Za-z]{3})[A-Za-z]*[\s\-,]+(\d{4})/.exec(s);
  if (m && MON3.includes(m[2].toLowerCase())) return m[3] + '-' + String(MON3.indexOf(m[2].toLowerCase()) + 1).padStart(2, '0') + '-' + m[1].padStart(2, '0');
  return s;
}
// "20-Oct-2023 11:02" (how the offer tool writes it) -> "2023-10-20 11:02"
function isoDateTime(s) {
  const str = String(s || '').trim();
  const d = isoDate(str);
  const t = /(\d{1,2}):(\d{2})/.exec(str.slice(8));
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d + (t ? ' ' + t[1].padStart(2, '0') + ':' + t[2] : '') : str;
}
function driveId(urlOrId) {
  const s = String(urlOrId || '').trim();
  const m = /\/d\/([A-Za-z0-9_-]{20,})/.exec(s) || /[?&]id=([A-Za-z0-9_-]{20,})/.exec(s);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{20,}$/.test(s) ? s : '';
}
function slipKey(x) {
  return x['Pay Year'] + '-' + String(MONTHS.indexOf(String(x['Pay Month']).trim()) + 1).padStart(2, '0');
}

// Same rule as the prototype: status Sent + has URL, phone matches the master, and
// DOB matches — unless the offer's DOB is clearly a placeholder (blank / < 15 yrs before issue).
function offerMatches(o, emp) {
  if (String(o['Status']).toLowerCase() !== 'sent' || !o['Offer URL']) return false;
  const mob = E.digits(emp.mobile_number);
  if (mob.length !== 10 || E.digits(o['Phone Number']) !== mob) return false;
  const od = isoDate(o['Date of Birth']);
  const gen = isoDateTime(o['Generated On']).slice(0, 4);
  const placeholder = !/^\d{4}-\d{2}-\d{2}$/.test(od) || (/^\d{4}$/.test(gen) && Number(od.slice(0, 4)) > Number(gen) - 15);
  return placeholder || od === emp.date_of_birth;
}

const NOT_CONNECTED = 'Documents aren’t connected yet. HR is setting this up — please check back soon.';

async function myOfferRows(emp) {
  const rows = await readSheet(G.offerSheetId, G.offerSheetTab);
  return rows.filter(o => offerMatches(o, emp));
}
async function myPayslipRows(emp) {
  const all = [];
  for (let i = 0; i < G.napsSheetIds.length; i++) {
    (await readSheet(G.napsSheetIds[i], G.napsSheetTab)).forEach(r => { r._sheet = i; all.push(r); });
  }
  return all.filter(r => String(r['Employee ID']).trim().toUpperCase() === emp.employee_code.toUpperCase()
    && String(r['Status']).trim() === 'Generated');
}

async function myOffers(body, req, ctx) {
  if (!google() || !G.offerSheetId) return { ok: false, error: NOT_CONNECTED };
  const items = (await myOfferRows(ctx.me)).map(o => {
    const x = {};
    Object.keys(o).forEach(k => { if (k !== 'Phone Number' && k !== 'Offer URL' && k !== '_row') x[k] = o[k]; });
    x['Generated On'] = isoDateTime(o['Generated On']);
    x['Date of Joining'] = isoDate(o['Date of Joining']);
    x['Date of Birth'] = isoDate(o['Date of Birth']);
    x.id = 'o' + o._row;
    return x;
  });
  return { ok: true, items };
}

async function myPayslips(body, req, ctx) {
  if (!google() || !G.napsSheetIds.length) return { ok: false, error: NOT_CONNECTED };
  const items = (await myPayslipRows(ctx.me)).map(r => {
    const x = {};
    Object.keys(r).forEach(k => { if (k[0] !== '_' && k !== 'PDF File ID') x[k] = r[k]; });
    x.id = 'p' + r._sheet + '-' + slipKey(r);
    return x;
  });
  return { ok: true, items };
}

async function downloadPdf(fileId) {
  const r = await google().drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
  return Buffer.from(r.data).toString('base64');
}

// The id is re-checked against the signed-in employee's own rows, so nobody can
// fetch someone else's document by guessing ids.
async function offerPdf(body, req, ctx) {
  if (!google() || !G.offerSheetId) return { ok: false, error: NOT_CONNECTED };
  const o = (await myOfferRows(ctx.me)).find(x => 'o' + x._row === String(body.id));
  const fid = o && driveId(o['Offer URL']);
  if (!fid) return { ok: false, error: 'Could not open the document.' };
  await audit(ctx.sess.viewed_by || ctx.me.employee_code, 'doc_offer', ctx.me.employee_code, { row: o._row }, req.ip);
  return { ok: true, base64: await downloadPdf(fid) };
}

async function payslipPdf(body, req, ctx) {
  if (!google() || !G.napsSheetIds.length) return { ok: false, error: NOT_CONNECTED };
  const r = (await myPayslipRows(ctx.me)).find(x => 'p' + x._sheet + '-' + slipKey(x) === String(body.id));
  const fid = r && driveId(r['PDF File ID']);
  if (!fid) return { ok: false, error: 'The PDF for this payslip isn’t available yet.' };
  await audit(ctx.sess.viewed_by || ctx.me.employee_code, 'doc_payslip', ctx.me.employee_code, { month: slipKey(r) }, req.ip);
  return { ok: true, base64: await downloadPdf(fid) };
}

module.exports = {
  session: { myOffers, myPayslips, offerPdf, payslipPdf },
  _test: { offerMatches, isoDate, isoDateTime, driveId },
};
