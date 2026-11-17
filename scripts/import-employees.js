'use strict';
// Load / refresh the Employee Master from an Excel (.xlsx) or CSV export.
//
//   npm run import:employees -- path/to/employee_master.xlsx            (dry run: shows what would change)
//   npm run import:employees -- path/to/employee_master.xlsx --apply    (writes to the DB)
//   ... --sheet "Sheet1"            pick a worksheet (default: first)
//   ... --mark-missing-exited       employees NOT in the file are set to Employment Status = Exited
//
// Headers are matched case-insensitively against src/employees.js COLUMNS
// (e.g. "Employee Code", "Date Of Birth", "HR Manager Code"). Unknown columns are ignored.
// Rows are upserted by Employee Code — existing tickets/PINs are kept.
const path = require('path');
const ExcelJS = require('exceljs');
const { pool, tx } = require('../src/db');
const { COLUMNS, DATE_COLUMNS } = require('../src/employees');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const apply = args.includes('--apply');
const markMissing = args.includes('--mark-missing-exited');
const sheetArg = (() => { const i = args.indexOf('--sheet'); return i >= 0 ? args[i + 1] : null; })();
if (!file) { console.error('Usage: npm run import:employees -- <file.xlsx|file.csv> [--apply] [--sheet NAME] [--mark-missing-exited]'); process.exit(1); }

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const headerMap = new Map();
COLUMNS.forEach(([col, ...names]) => names.forEach(n => { if (!headerMap.has(norm(n))) headerMap.set(norm(n), col); }));

const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function toDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    if (isNaN(v)) return null;
    // ExcelJS gives UTC midnight for date-only cells
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === 'number') { // Excel serial date
    const d = new Date(Math.round((v - 25569) * 86400000));
    return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  if ((m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/.exec(s))) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; // DD/MM/YYYY (Indian format)
  if ((m = /^(\d{1,2})[\s\-]([A-Za-z]{3})[A-Za-z]*[\s\-,]+(\d{4})$/.exec(s)) && MON.includes(m[2].toLowerCase()))
    return `${m[3]}-${String(MON.indexOf(m[2].toLowerCase()) + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return undefined; // unparseable
}
function cellValue(v) {
  if (v == null) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (v.result !== undefined) return cellValue(v.result);     // formula
    if (v.text !== undefined) return String(v.text);             // hyperlink
    if (Array.isArray(v.richText)) return v.richText.map(r => r.text).join('');
  }
  return v;
}

async function readRows() {
  const wb = new ExcelJS.Workbook();
  let ws;
  if (path.extname(file).toLowerCase() === '.csv') ws = await wb.csv.readFile(file);
  else { await wb.xlsx.readFile(file); ws = sheetArg ? wb.getWorksheet(sheetArg) : wb.worksheets[0]; }
  if (!ws) throw new Error('Worksheet not found: ' + sheetArg);
  const header = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { header[i] = String(cellValue(c.value) || '').trim(); });
  const mapped = {}, ignored = [];
  header.forEach((h, i) => { if (!h) return; const col = headerMap.get(norm(h)); if (col && !Object.values(mapped).includes(col)) mapped[i] = col; else ignored.push(h); });
  const rows = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const o = { _line: n };
    Object.entries(mapped).forEach(([i, col]) => { o[col] = cellValue(row.getCell(Number(i)).value); });
    rows.push(o);
  });
  return { rows, mapped: Object.values(mapped), ignored };
}

(async () => {
  const { rows, mapped, ignored } = await readRows();
  console.log('Matched columns: ' + mapped.join(', '));
  if (ignored.length) console.log('Ignored columns: ' + ignored.join(', '));
  if (!mapped.includes('employee_code') || !mapped.includes('employee_name')) throw new Error('File must have "Employee Code" and "Employee Name" columns.');
  if (!mapped.includes('date_of_birth')) console.warn('WARNING: no "Date Of Birth" column — employees will not be able to do first-time sign-in.');

  const errors = [], clean = [], seen = new Set();
  for (const r of rows) {
    const code = String(r.employee_code || '').trim().toUpperCase();
    if (!code) continue; // blank line
    if (seen.has(code)) { errors.push(`line ${r._line}: duplicate Employee Code ${code}`); continue; }
    seen.add(code);
    const o = { employee_code: code };
    let bad = false;
    for (const col of mapped) {
      if (col === 'employee_code') continue;
      let v = r[col];
      if (DATE_COLUMNS.has(col)) {
        const d = toDate(v);
        if (d === undefined) { errors.push(`line ${r._line} (${code}): can't read ${col} "${v}" — use YYYY-MM-DD or DD/MM/YYYY (row skipped)`); bad = true; continue; }
        v = d;
      } else {
        v = v instanceof Date ? v.toISOString().slice(0, 10) : String(v == null ? '' : v).trim();
        if (col === 'mobile_number') v = v.replace(/\D/g, '').slice(-10);
        if (col.endsWith('_code')) v = v.toUpperCase();
        if (v === '') v = null;
      }
      o[col] = v;
    }
    if (bad) continue;
    if (!o.employee_name) { errors.push(`line ${r._line} (${code}): missing Employee Name`); continue; }
    if (mapped.includes('employment_status') && !o.employment_status) o.employment_status = 'Active';
    if (!o.first_name && mapped.includes('employee_name')) o.first_name = String(o.employee_name).split(/\s+/)[0];
    clean.push(o);
  }

  const existing = new Map((await pool.query('SELECT employee_code, employment_status FROM ess.employees')).rows.map(r => [r.employee_code, r]));
  const inserts = clean.filter(o => !existing.has(o.employee_code)).length;
  const updates = clean.length - inserts;
  const missing = [...existing.keys()].filter(c => !seen.has(c) && String(existing.get(c).employment_status).toLowerCase() === 'active');

  const noDob = clean.filter(o => !o.date_of_birth && String(o.employment_status || 'Active').toLowerCase() === 'active');
  const noMob = clean.filter(o => !o.mobile_number || o.mobile_number.length !== 10);
  if (noDob.length) console.log(`WARNING: ${noDob.length} active employee(s) have no Date Of Birth — they can't do first-time sign-in: ${noDob.slice(0, 20).map(o => o.employee_code).join(', ')}${noDob.length > 20 ? ' …' : ''}`);
  if (noMob.length) console.log(`Note: ${noMob.length} employee(s) have no valid 10-digit mobile — offer letters can't be matched for them.`);
  console.log(`\nRows read: ${rows.length}  valid: ${clean.length}  new: ${inserts}  updated: ${updates}  errors: ${errors.length}`);
  if (markMissing) console.log(`Active employees missing from file (would be marked Exited): ${missing.length}`);
  errors.slice(0, 50).forEach(e => console.log('  ! ' + e));
  if (errors.length > 50) console.log(`  ... and ${errors.length - 50} more`);

  if (!apply) { console.log('\nDry run only. Re-run with --apply to write these changes.'); await pool.end(); return; }

  // employment_status is only written when the file has that column (DB default for new rows is
  // 'Active'), so re-importing a file without it never re-activates exited employees.
  const cols = ['employee_code', ...mapped.filter(c => c !== 'employee_code')];
  if (!cols.includes('first_name')) cols.push('first_name');
  await tx(async c => {
    for (const o of clean) {
      const vals = cols.map(k => (o[k] === undefined ? null : o[k]));
      const sets = cols.slice(1).map(k => `${k} = EXCLUDED.${k}`).join(', ');
      await c.query(
        `INSERT INTO ess.employees (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')})
         ON CONFLICT (employee_code) DO UPDATE SET ${sets}, updated_at = now()`, vals);
    }
    if (markMissing && missing.length) {
      await c.query(`UPDATE ess.employees SET employment_status = 'Exited', updated_at = now() WHERE employee_code = ANY($1)`, [missing]);
    }
    await c.query(`INSERT INTO ess.audit_log (actor, action, detail) VALUES ('import', 'employee_import', $1)`,
      [{ file: path.basename(file), inserted: inserts, updated: updates, exited: markMissing ? missing.length : 0 }]);
  });
  console.log('\nDone. Employee Master updated.');
  await pool.end();
})().catch(e => { console.error('\nImport failed:', e.message); process.exit(1); });
