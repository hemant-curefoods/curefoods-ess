'use strict';
// POST /api  { action, session?, ...params }  ->  { ok, ... }
// One endpoint, same contract the prototype's LiveAuth/Docs layer already speaks.
const A = require('../auth');
const E = require('../employees');
const account = require('./account');
const tickets = require('./tickets');
const documents = require('./documents');

// level: public | session | hr | admin.  write: blocked in read-only view-as sessions.
const ACTIONS = {};
function register(level, group) {
  Object.entries(group).forEach(([name, h]) => {
    ACTIONS[name] = typeof h === 'function' ? { level, fn: h, write: false } : { level, fn: h.fn, write: !!h.write };
  });
}
register('public', account.public);
register('session', account.session);
register('hr', account.hr);
register('admin', account.admin);
register('session', tickets.session);
register('hr', tickets.hr);
register('session', documents.session);

const AUTH_ACTIONS = new Set(['start', 'loginPin', 'verifyDob', 'setPin']);

// Resolves the session into ctx = { sess, me, role, isAdmin, viewAs }
async function context(token) {
  const sess = await A.getSession(token);
  if (!sess) return null;
  const me = await E.getEmployee(sess.employee_code);
  if (!E.isActive(me)) return null;
  const roles = await E.rolesFor(me.employee_code);
  return { sess, me, role: roles.role, isAdmin: roles.isAdmin, viewAs: sess.kind === 'viewas' };
}

async function handle(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const def = ACTIONS[body.action];
  if (!def) return res.status(400).json({ ok: false, error: 'Unknown action.' });
  try {
    let ctx = null;
    if (def.level !== 'public') {
      ctx = await context(body.session);
      if (!ctx) return res.status(401).json({ ok: false, error: 'Your session has expired. Please sign in again.', expired: true });
      if (def.write && ctx.viewAs) return res.json({ ok: false, error: 'Read-only: exit view-as to make changes.' });
      if (def.level === 'hr' && !E.isHrRole(ctx.role)) return res.status(403).json({ ok: false, error: 'HR access only.' });
      if (def.level === 'admin' && !ctx.isAdmin) return res.status(403).json({ ok: false, error: 'Admin access only.' });
    }
    const out = await def.fn(body, req, ctx);
    if (AUTH_ACTIONS.has(body.action) && out && out.ok === false) res.locals.authFailed = true;
    res.json(out);
  } catch (e) {
    console.error('[api]', body.action, e);
    res.status(500).json({ ok: false, error: 'Something went wrong on our side. Please try again.' });
  }
}

async function file(req, res) {
  const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  try {
    const ctx = await context(token);
    if (!ctx) return res.status(401).end();
    await tickets.sendFile(req, res, ctx);
  } catch (e) {
    console.error('[file]', e);
    res.status(500).end();
  }
}

module.exports = { handle, file, AUTH_ACTIONS };
