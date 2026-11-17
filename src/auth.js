'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { query, audit } = require('./db');

const BCRYPT_ROUNDS = 11;

// PIN -> HMAC(pepper) -> bcrypt. A stolen DB alone can't be brute-forced
// (only 10,000 PINs exist) without the pepper from .env.
function peppered(code, pin) {
  return crypto.createHmac('sha256', config.pinPepper).update(String(code).toUpperCase() + '|' + pin).digest('base64');
}
function hashPin(code, pin) {
  return bcrypt.hash(peppered(code, pin), BCRYPT_ROUNDS);
}
function checkPin(code, pin, hash) {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(peppered(code, pin), hash);
}

function weakPin(pin, dob) {
  if (!/^\d{4}$/.test(pin)) return 'PIN must be 4 digits.';
  if (/^(\d)\1{3}$/.test(pin)) return 'Avoid repeating digits like 1111.';
  if ('0123456789'.includes(pin) || '9876543210'.includes(pin)) return 'Avoid sequences like 1234.';
  if (dob) {
    const y = dob.slice(0, 4), m = dob.slice(5, 7), d = dob.slice(8, 10);
    if (pin === y || pin === d + m || pin === m + d) return 'Don’t use your birth year or birthday as your PIN.';
  }
  return '';
}

// ---- auth row (fails / lockout) ----
async function authRow(code) {
  await query('INSERT INTO ess.auth (employee_code) VALUES ($1) ON CONFLICT DO NOTHING', [code]);
  const r = await query('SELECT * FROM ess.auth WHERE employee_code = $1', [code]);
  return r.rows[0];
}
function isLocked(row) {
  return !!(row && row.locked_until && new Date(row.locked_until) > new Date());
}
// Records a failed attempt; returns the response to send.
async function recordFail(code, ip, what) {
  const r = await query(
    `UPDATE ess.auth SET fails = fails + 1 WHERE employee_code = $1 RETURNING fails`, [code]);
  const fails = r.rows[0].fails;
  if (fails >= config.maxFails) {
    await query(
      `UPDATE ess.auth SET fails = 0, locked_until = now() + ($2 || ' minutes')::interval WHERE employee_code = $1`,
      [code, String(config.lockMinutes)]);
    await audit(code, 'locked', code, { after: what }, ip);
    return { ok: false, error: 'Too many wrong attempts. This ID is locked for ' + config.lockMinutes + ' minutes.' };
  }
  await audit(code, 'fail_' + what, code, { fails }, ip);
  return { ok: false, error: null, left: config.maxFails - fails };
}
async function clearFails(code) {
  await query('UPDATE ess.auth SET fails = 0, locked_until = NULL WHERE employee_code = $1', [code]);
}

// ---- sessions ----
function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}
function tokenHash(t) {
  return crypto.createHash('sha256').update(String(t)).digest('hex');
}

async function createSession(code, kind, req, opts) {
  opts = opts || {};
  const token = newToken();
  const minutes =
    kind === 'setup' ? config.setupMinutes :
    kind === 'viewas' ? config.viewAsMinutes :
    config.sessionMaxHours * 60;
  await query(
    `INSERT INTO ess.sessions (token_hash, employee_code, kind, viewed_by, reason, expires_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' minutes')::interval, $7, $8)`,
    [tokenHash(token), code, kind, opts.viewedBy || null, opts.reason || null, String(minutes),
     req.ip, String(req.get('user-agent') || '').slice(0, 300)]
  );
  return token;
}

// Returns session row (+ employee_code) or null. Applies idle timeout for user sessions.
async function getSession(token, kind) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const r = await query(
    `UPDATE ess.sessions SET last_seen = now()
      WHERE token_hash = $1 AND kind = ANY($2) AND expires_at > now()
        AND (kind <> 'user' OR last_seen > now() - ($3 || ' minutes')::interval)
      RETURNING *`,
    [tokenHash(token), kind ? [kind] : ['user', 'viewas'], String(config.sessionIdleMinutes)]
  );
  return r.rows[0] || null;
}

async function dropSession(token) {
  if (!token) return;
  await query('DELETE FROM ess.sessions WHERE token_hash = $1', [tokenHash(token)]);
}
async function dropAllSessions(code) {
  await query(`DELETE FROM ess.sessions WHERE employee_code = $1 AND kind <> 'viewas'`, [code]);
}
async function purgeExpired() {
  await query(`DELETE FROM ess.sessions WHERE expires_at < now() - interval '1 day'`);
}

module.exports = {
  hashPin, checkPin, weakPin, authRow, isLocked, recordFail, clearFails,
  createSession, getSession, dropSession, dropAllSessions, purgeExpired,
};
