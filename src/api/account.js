'use strict';
// Sign-in, PIN management, HR PIN reset and admin "view as".
const config = require('../config');
const { query, audit } = require('../db');
const A = require('../auth');
const E = require('../employees');

const NOT_FOUND = 'We couldn’t find that Employee ID. Check the ID on your offer letter or payslip.';

function normCode(c) { return String(c || '').trim().toUpperCase().slice(0, 40); }

async function start(body) {
  const e = await E.getEmployee(normCode(body.empCode));
  if (!e) return { ok: false, error: NOT_FOUND };
  if (!E.isActive(e)) return { ok: false, error: 'This ID is marked as exited. Use the Alumni Portal below.' };
  const r = await A.authRow(e.employee_code);
  if (A.isLocked(r)) return { ok: false, error: 'This ID is locked after too many wrong attempts. Try again later or contact HR.' };
  return { ok: true, hasPin: !!r.pin_hash };
}

async function loginPin(body, req) {
  const e = await E.getEmployee(normCode(body.empCode));
  if (!E.isActive(e)) return { ok: false, error: 'Please start again.' };
  const r = await A.authRow(e.employee_code);
  if (!r.pin_hash) return { ok: false, error: 'Please start again.' };
  if (A.isLocked(r)) return { ok: false, error: 'This ID is locked. Try again later or contact HR.' };
  if (!(await A.checkPin(e.employee_code, String(body.pin || ''), r.pin_hash))) {
    return A.recordFail(e.employee_code, req.ip, 'pin');
  }
  await A.clearFails(e.employee_code);
  const session = await A.createSession(e.employee_code, 'user', req);
  await audit(e.employee_code, 'login', e.employee_code, {}, req.ip);
  return { ok: true, session, employee: await E.toClient(e) };
}

async function verifyDob(body, req) {
  const e = await E.getEmployee(normCode(body.empCode));
  if (!E.isActive(e)) return { ok: false, error: 'Please start again.' };
  const r = await A.authRow(e.employee_code);
  if (r.pin_hash) return { ok: false, error: 'A PIN is already set for this ID. Sign in with your PIN.' };
  if (A.isLocked(r)) return { ok: false, error: 'This ID is locked. Try again later or contact HR.' };
  const dob = String(body.dob || '').slice(0, 10);
  if (!e.date_of_birth || e.date_of_birth !== dob) return A.recordFail(e.employee_code, req.ip, 'dob');
  await A.clearFails(e.employee_code);
  const setupToken = await A.createSession(e.employee_code, 'setup', req);
  return { ok: true, setupToken, dob };
}

async function setPin(body, req) {
  const s = await A.getSession(body.setupToken, 'setup');
  if (!s) return { ok: false, error: 'Session expired. Please start again.' };
  const e = await E.getEmployee(s.employee_code);
  if (!E.isActive(e)) return { ok: false, error: 'Session expired. Please start again.' };
  const pin = String(body.pin || '');
  const w = A.weakPin(pin, e.date_of_birth || ''); if (w) return { ok: false, error: w };
  const r = await A.authRow(e.employee_code);
  if (r.pin_hash) return { ok: false, error: 'A PIN is already set for this ID. Sign in with your PIN.' };
  await query('UPDATE ess.auth SET pin_hash = $2, pin_set_on = now(), fails = 0, locked_until = NULL WHERE employee_code = $1',
    [e.employee_code, await A.hashPin(e.employee_code, pin)]);
  await A.dropSession(body.setupToken);
  await audit(e.employee_code, 'pin_set', e.employee_code, {}, req.ip);
  const session = await A.createSession(e.employee_code, 'user', req);
  return { ok: true, session, employee: await E.toClient(e) };
}

async function me(body, req, ctx) {
  return { ok: true, employee: await E.toClient(ctx.me), viewAs: ctx.viewAs ? { by: ctx.sess.viewed_by } : null };
}

async function logout(body, req, ctx) {
  await A.dropSession(body.session);
  if (ctx.viewAs) await audit(ctx.sess.viewed_by, 'viewas_end', ctx.me.employee_code, {}, req.ip);
  return { ok: true };
}

async function changePin(body, req, ctx) {
  const code = ctx.me.employee_code;
  const r = await A.authRow(code);
  if (A.isLocked(r)) return { ok: false, error: 'This ID is locked. Try again later or contact HR.' };
  if (!(await A.checkPin(code, String(body.oldPin || ''), r.pin_hash))) {
    const f = await A.recordFail(code, req.ip, 'pin_change');
    return { ok: false, error: f.error || 'Current PIN is incorrect.', left: f.left };
  }
  const pin = String(body.newPin || '');
  const w = A.weakPin(pin, ctx.me.date_of_birth || ''); if (w) return { ok: false, error: w };
  await query('UPDATE ess.auth SET pin_hash = $2, pin_set_on = now(), fails = 0 WHERE employee_code = $1',
    [code, await A.hashPin(code, pin)]);
  await audit(code, 'pin_change', code, {}, req.ip);
  return { ok: true };
}

// ---- HR: PIN status + reset ----
async function pinStatus(body, req, ctx) {
  const e = await E.getEmployee(normCode(body.empCode));
  if (!e) return { ok: false, error: 'No employee with that ID.' };
  const r = await A.authRow(e.employee_code);
  const names = await E.namesFor([r.reset_by]);
  return {
    ok: true,
    employee: {
      'Employee Code': e.employee_code, 'Employee Name': e.employee_name,
      'Designation': e.designation || '', 'Base location (Office)': e.base_location || '',
      'Employment Status': e.employment_status,
    },
    hasPin: !!r.pin_hash, locked: A.isLocked(r),
    pinSetOn: r.pin_set_on ? new Date(r.pin_set_on).getTime() : null,
    resetOn: r.reset_on ? new Date(r.reset_on).getTime() : null,
    resetBy: r.reset_by || null, names,
  };
}

async function resetPin(body, req, ctx) {
  const e = await E.getEmployee(normCode(body.empCode));
  if (!e) return { ok: false, error: 'No employee with that ID.' };
  if (e.employee_code === ctx.me.employee_code) return { ok: false, error: 'You can’t reset your own PIN here. Use Change PIN, or ask another HR.' };
  const target = await E.rolesFor(e.employee_code);
  if ((target.isAdmin || target.role === 'hrhead') && ctx.role !== 'hrhead') {
    return { ok: false, error: 'Only the HR Head can reset an Admin or HR Head PIN.' };
  }
  await A.authRow(e.employee_code);
  await query(
    `UPDATE ess.auth SET pin_hash = NULL, pin_set_on = NULL, fails = 0, locked_until = NULL,
            reset_on = now(), reset_by = $2 WHERE employee_code = $1`,
    [e.employee_code, ctx.me.employee_code]);
  await A.dropAllSessions(e.employee_code);
  await audit(ctx.me.employee_code, 'pin_reset', e.employee_code, {}, req.ip);
  return { ok: true };
}

// ---- Admin: read-only "view as employee" ----
async function impersonate(body, req, ctx) {
  const reason = String(body.reason || '').trim().slice(0, 300);
  if (reason.length < 5) return { ok: false, error: 'Enter a reason (at least 5 characters).' };
  const e = await E.getEmployee(normCode(body.empCode));
  if (!E.isActive(e)) return { ok: false, error: 'No active employee with that ID.' };
  if (e.employee_code === ctx.me.employee_code) return { ok: false, error: 'That’s your own ID.' };
  if ((await E.rolesFor(e.employee_code)).isAdmin) return { ok: false, error: 'Admin accounts can’t be viewed this way.' };
  const session = await A.createSession(e.employee_code, 'viewas', req, { viewedBy: ctx.me.employee_code, reason });
  await audit(ctx.me.employee_code, 'viewas_start', e.employee_code, { reason }, req.ip);
  return { ok: true, session, employee: await E.toClient(e) };
}

module.exports = {
  public: { start, loginPin, verifyDob, setPin },
  session: { me, logout, changePin: { fn: changePin, write: true } },
  hr: { pinStatus, resetPin: { fn: resetPin, write: true } },
  admin: { impersonate: { fn: impersonate, write: true } },
};
