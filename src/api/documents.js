'use strict';
// Offer letters + NAPS payslips for the signed-in employee.
//
// DOCS_SOURCE=db (default)  -> documents pushed into the portal by the Apps Script
//                              PortalSync job (bridge/PortalSync.gs, see README).
// DOCS_SOURCE=google        -> read live from Google Sheets/Drive with a service account.
//
// Either way, ids are re-checked against the employee's own records before a PDF is
// returned, so nobody can open someone else's document by guessing ids.
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { query, audit } = require('../db');
const U = require('../util');

const NOT_CONNECTED = 'Documents aren’t connected yet. HR is setting this up — please check back soon.';

// Same rule as the prototype: phone matches the master, and DOB matches —
// unless the offer's DOB is clearly a placeholder (blank / < 15 years before issue).
function offerMatches(o, emp) {
  if (String(o['Status'] == null ? 'sent' : o['Status']).toLowerCase() !== 'sent') return false;
  const mob = U.digits(emp.mobile_number);
  if (mob.length !== 10 || U.digits(o['Phone Number']) !== mob) return false;
  const od = U.isoDate(o['Date of Birth']);
  const gen = U.isoDateTime(o['Generated On']).slice(0, 4);
  const placeholder = !/^\d{4}-\d{2}-\d{2}$/.test(od) || (/^\d{4}$/.test(gen) && Number(od.slice(0, 4)) > Number(gen) - 15);
  return placeholder || od === emp.date_of_birth;
}
function slipKey(x) {
  return x['Pay Year'] + '-' + String(U.MONTHS.indexOf(String(x['Pay Month']).trim()) + 1).padStart(2, '0');
}
function logOpen(ctx, req, what, detail) {
  return audit(ctx.sess.viewed_by || ctx.me.employee_code, what, ctx.me.employee_code, detail, req.ip);
}

// =================== source: portal database (option C) ===================
const db = {
  async offerRows(emp) {
    const mob = U.digits(emp.mobile_number);
    if (mob.length !== 10) return [];
    const r = await query('SELECT * FROM ess.offer_letters WHERE phone = $1 ORDER BY generated_on DESC', [mob]);
    return r.rows.map(x => ({
      _id: 'd' + x.id, _stored: x.stored_name,
      'Generated On': x.generated_on || '', 'Entity': x.entity || '', 'Employee Name': x.employee_name || '',
      'Letter Type': x.letter_type || '', 'Designation': x.designation || '', 'Category': x.category || '',
      'State': x.state || '', 'Kitchen Location': x.kitchen_location || '', 'Date of Joining': x.date_of_joining || '',
      'Date of Birth': x.date_of_birth || '', 'Phone Number': x.phone, 'Manager Name': x.manager_name || '',
      'Net Salary': x.net_salary == null ? '' : Number(x.net_salary), 'DBT Amount': x.dbt_amount == null ? '' : Number(x.dbt_amount),
      'Status': 'Sent',
    })).filter(o => offerMatches(o, emp));
  },
  async slipRows(emp) {
    const r = await query('SELECT * FROM ess.payslips WHERE employee_id = upper($1)', [emp.employee_code]);
    return r.rows.map(x => Object.assign({}, x.data, {
      'Employee ID': x.employee_id, 'Pay Month': x.pay_month, 'Pay Year': x.pay_year, _id: 'd' + x.id, _stored: x.stored_name,
    }));
  },
  async pdf(row) {
    const buf = await fs.promises.readFile(path.join(config.docsDir, row._stored));
    return buf.toString('base64');
  },
  ready() { return true; },
};

// =================== source: Google Sheets/Drive (service account) ===================
const G = config.google;
let gclients = null;
function google() {
  if (!G.credentialsFile) return null;
  if (gclients) return gclients;
  const { sheets, auth } = require('@googleapis/sheets');
  const { drive } = require('@googleapis/drive');
  const a = new auth.GoogleAuth({
    keyFile: G.credentialsFile,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly', 'https://www.googleapis.com/auth/drive.readonly'],
  });
  gclients = { sheets: sheets({ version: 'v4', auth: a }), drive: drive({ version: 'v3', auth: a }) };
  return gclients;
}
const cache = new Map();
async function readSheet(id, tab) {
  const key = id + '|' + tab;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < G.cacheSeconds * 1000) return hit.rows;
  const r = await google().sheets.spreadsheets.values.get({ spreadsheetId: id, range: "'" + tab.replace(/'/g, "''") + "'", valueRenderOption: 'FORMATTED_VALUE' });
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
const gsrc = {
  async offerRows(emp) {
    return (await readSheet(G.offerSheetId, G.offerSheetTab)).filter(o => o['Offer URL'] && offerMatches(o, emp)).map(o => Object.assign({}, o, {
      _id: 'g' + o._row, _drive: U.driveId(o['Offer URL']),
      'Generated On': U.isoDateTime(o['Generated On']), 'Date of Joining': U.isoDate(o['Date of Joining']),
      'Net Salary': U.amount(o['Net Salary']), 'DBT Amount': U.amount(o['DBT Amount']),
    }));
  },
  async slipRows(emp) {
    const out = [];
    for (let i = 0; i < G.napsSheetIds.length; i++) {
      (await readSheet(G.napsSheetIds[i], G.napsSheetTab)).forEach(r => {
        if (String(r['Employee ID']).trim().toUpperCase() !== emp.employee_code.toUpperCase()) return;
        if (String(r['Status']).trim().toLowerCase() !== 'generated') return;
        const x = {};
        Object.keys(r).forEach(k => { const n = U.amount(r[k]); x[k] = (n != null && !['Employee ID', 'Pay Year', 'Apprenticeship Code'].includes(k)) ? n : r[k]; });
        x._id = 'g' + i + '-' + slipKey(r); x._drive = U.driveId(r['PDF File ID']);
        out.push(x);
      });
    }
    return out;
  },
  async pdf(row) {
    if (!row._drive) throw Object.assign(new Error('no pdf'), { userMessage: 'The PDF for this document isn’t available yet.' });
    const r = await google().drive.files.get({ fileId: row._drive, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
    return Buffer.from(r.data).toString('base64');
  },
  ready() { return !!(google() && G.offerSheetId); },
};

function source() { return config.docsSource === 'google' ? gsrc : db; }
function clean(o) {
  const x = {};
  Object.keys(o).forEach(k => { if (k[0] !== '_' && k !== 'Phone Number' && k !== 'Offer URL' && k !== 'PDF File ID') x[k] = o[k]; });
  x.id = o._id;
  return x;
}

async function myOffers(body, req, ctx) {
  const s = source(); if (!s.ready()) return { ok: false, error: NOT_CONNECTED };
  return { ok: true, items: (await s.offerRows(ctx.me)).map(clean) };
}
async function myPayslips(body, req, ctx) {
  const s = source(); if (!s.ready()) return { ok: false, error: NOT_CONNECTED };
  return { ok: true, items: (await s.slipRows(ctx.me)).map(clean) };
}
async function openPdf(kind, body, req, ctx) {
  const s = source(); if (!s.ready()) return { ok: false, error: NOT_CONNECTED };
  const rows = kind === 'offer' ? await s.offerRows(ctx.me) : await s.slipRows(ctx.me);
  const row = rows.find(x => x._id === String(body.id || ''));
  if (!row) return { ok: false, error: 'Could not open the document.' };
  try {
    const base64 = await s.pdf(row);
    await logOpen(ctx, req, kind === 'offer' ? 'doc_offer' : 'doc_payslip', { id: row._id });
    return { ok: true, base64 };
  } catch (e) {
    if (e.userMessage) return { ok: false, error: e.userMessage };
    if (e.code === 'ENOENT') return { ok: false, error: 'The PDF for this document isn’t available yet.' };
    throw e;
  }
}

module.exports = {
  session: {
    myOffers, myPayslips,
    offerPdf: (b, r, c) => openPdf('offer', b, r, c),
    payslipPdf: (b, r, c) => openPdf('payslip', b, r, c),
  },
  _test: { offerMatches, isoDate: U.isoDate, isoDateTime: U.isoDateTime, driveId: U.driveId },
};
