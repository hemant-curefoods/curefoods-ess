'use strict';
// Helpdesk: tickets, routing, remarks, reassignment, closing, attachments.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const { query, tx, audit } = require('../db');
const E = require('../employees');

const CATEGORIES = ['Payroll & Salary', 'Attendance & Leave', 'Reimbursements', 'Letters & Documents',
  'Insurance & Benefits', 'Grievance', 'Conduct', 'POSH', 'Other'];

// Allowed attachment types — MIME is decided by extension, never by the browser.
const FILE_TYPES = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

fs.mkdirSync(config.uploadDir, { recursive: true });

const ms = d => (d ? new Date(d).getTime() : null);

// Which tickets can this person see?
//   own tickets; tickets assigned to them; tickets they acted on (HR); everything for the HR Head.
function visibilitySql(alias) {
  const t = alias || 't';
  return `(${t}.raised_by = $1 OR ${t}.assigned_to = $1 OR $2::boolean
           OR ($3::boolean AND EXISTS (SELECT 1 FROM ess.ticket_events v WHERE v.ticket_id = ${t}.id AND v.by_code = $1)))`;
}
function visParams(ctx) {
  return [ctx.me.employee_code, ctx.role === 'hrhead', E.isHrRole(ctx.role)];
}

async function loadTickets(ctx, onlyId) {
  const params = visParams(ctx);
  let where = visibilitySql('t');
  if (onlyId) { params.push(onlyId); where += ' AND t.id = $4'; }
  const t = await query(
    `SELECT t.*, e.employee_name AS raiser_name, e.designation AS raiser_designation, e.base_location AS raiser_location
       FROM ess.tickets t JOIN ess.employees e ON e.employee_code = t.raised_by
      WHERE ${where} ORDER BY t.created_at DESC LIMIT 2000`, params);
  if (!t.rows.length) return { items: [], names: {} };
  const ids = t.rows.map(r => r.id);
  const [ev, fl] = await Promise.all([
    query('SELECT * FROM ess.ticket_events WHERE ticket_id = ANY($1) ORDER BY at, id', [ids]),
    query('SELECT id, ticket_id, name, size, mime FROM ess.ticket_files WHERE ticket_id = ANY($1) ORDER BY created_at', [ids]),
  ]);
  const hr = E.isHrRole(ctx.role) && !ctx.viewAs;
  const codes = [];
  const items = t.rows.map(r => {
    codes.push(r.raised_by, r.assigned_to);
    const events = ev.rows.filter(x => x.ticket_id === r.id).map(x => {
      codes.push(x.by_code);
      return { at: ms(x.at), by: x.by_code, type: x.type, text: x.text };
    });
    return {
      id: r.id, raisedBy: r.raised_by, category: r.category, description: r.description,
      assignedTo: r.assigned_to, status: r.status, createdAt: ms(r.created_at), closedAt: ms(r.closed_at),
      files: fl.rows.filter(x => x.ticket_id === r.id).map(x => ({ id: x.id, name: x.name, size: x.size, type: x.mime })),
      events,
      raiser: hr ? { name: r.raiser_name, designation: r.raiser_designation, location: r.raiser_location } : { name: r.raiser_name },
    };
  });
  return { items, names: await E.namesFor(codes) };
}

async function tickets(body, req, ctx) {
  const r = await loadTickets(ctx);
  return { ok: true, items: r.items, names: r.names };
}

async function hrListAction() {
  const rows = await E.hrList();
  return { ok: true, items: rows.map(h => ({ code: h.employee_code, name: h.employee_name, designation: h.designation || 'HR' })) };
}

function decodeFile(f) {
  const name = String(f && f.name || '').replace(/[\\/\0]/g, '_').slice(0, 200);
  const ext = path.extname(name).toLowerCase();
  if (!FILE_TYPES[ext]) throw userError(name + ': this file type isn’t allowed.');
  const m = /^data:[^;,]*;base64,(.*)$/s.exec(String(f.data || ''));
  if (!m) throw userError(name + ': could not read the file.');
  const buf = Buffer.from(m[1], 'base64');
  if (!buf.length) throw userError(name + ': file is empty.');
  if (buf.length > config.maxFileBytes) throw userError(name + ' is over 2 MB.');
  return { name, ext, mime: FILE_TYPES[ext], buf };
}
function userError(msg) { const e = new Error(msg); e.userMessage = msg; return e; }

async function raiseTicket(body, req, ctx) {
  const category = String(body.category || '');
  const description = String(body.description || '').trim();
  if (!CATEGORIES.includes(category)) return { ok: false, error: 'Select a ticket category.' };
  if (description.length < 10) return { ok: false, error: 'Please describe the issue in a little more detail (at least 10 characters).' };
  if (description.length > 2000) return { ok: false, error: 'Description is too long (2000 characters max).' };
  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length > config.maxFiles) return { ok: false, error: 'Up to 5 files per ticket.' };
  let decoded;
  try { decoded = files.map(decodeFile); } catch (e) { if (e.userMessage) return { ok: false, error: e.userMessage }; throw e; }

  const route = await E.routeTicket(ctx.me, category);
  const written = [];
  try {
    const id = await tx(async c => {
      const t = await c.query(
        `INSERT INTO ess.tickets (raised_by, category, description, assigned_to) VALUES ($1,$2,$3,$4) RETURNING id`,
        [ctx.me.employee_code, category, description, route.emp.employee_code]);
      const tid = t.rows[0].id;
      await c.query(`INSERT INTO ess.ticket_events (ticket_id, by_code, type, text) VALUES ($1,$2,'created','Ticket raised')`,
        [tid, ctx.me.employee_code]);
      await c.query(`INSERT INTO ess.ticket_events (ticket_id, by_code, type, text) VALUES ($1,'system','assigned',$2)`,
        [tid, 'Auto-assigned to ' + route.emp.employee_name + ' (' + route.why + ')']);
      for (const f of decoded) {
        const fid = crypto.randomUUID();
        const stored = fid + f.ext;
        fs.writeFileSync(path.join(config.uploadDir, stored), f.buf, { mode: 0o640 });
        written.push(stored);
        await c.query(
          `INSERT INTO ess.ticket_files (id, ticket_id, name, size, mime, stored_name, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [fid, tid, f.name, f.buf.length, f.mime, stored, ctx.me.employee_code]);
      }
      return tid;
    });
    return { ok: true, id, assignedTo: route.emp.employee_code, assignedName: route.emp.employee_name };
  } catch (e) {
    written.forEach(s => fs.rm(path.join(config.uploadDir, s), () => {}));
    throw e;
  }
}

// Ticket the current HR user may act on (open, and assigned to them or they're HR Head)
async function actionable(ctx, id) {
  const r = await query('SELECT * FROM ess.tickets WHERE id = $1', [String(id || '')]);
  const t = r.rows[0];
  if (!t) return { error: 'Ticket not found.' };
  if (t.status === 'Closed') return { error: 'This ticket is already closed.' };
  if (!(t.assigned_to === ctx.me.employee_code || ctx.role === 'hrhead')) return { error: 'Only the assigned HR can act on this ticket.' };
  return { t };
}

async function ticketRemark(body, req, ctx) {
  const text = String(body.text || '').trim().slice(0, 2000);
  if (!text) return { ok: false, error: 'Write a remark first.' };
  const a = await actionable(ctx, body.id); if (a.error) return { ok: false, error: a.error };
  await tx(async c => {
    await c.query(`INSERT INTO ess.ticket_events (ticket_id, by_code, type, text) VALUES ($1,$2,'remark',$3)`, [a.t.id, ctx.me.employee_code, text]);
    if (a.t.status === 'Open') await c.query(`UPDATE ess.tickets SET status = 'In Progress' WHERE id = $1`, [a.t.id]);
  });
  return { ok: true };
}

async function ticketReassign(body, req, ctx) {
  const note = String(body.note || '').trim().slice(0, 1000);
  if (!note) return { ok: false, error: 'Add a handover note.' };
  const a = await actionable(ctx, body.id); if (a.error) return { ok: false, error: a.error };
  const to = String(body.to || '').toUpperCase();
  const hr = (await E.hrList()).find(h => h.employee_code.toUpperCase() === to);
  if (!hr) return { ok: false, error: 'Pick an active HR person.' };
  if (hr.employee_code === a.t.assigned_to) return { ok: false, error: 'It’s already with them.' };
  const names = await E.namesFor([a.t.assigned_to]);
  await tx(async c => {
    await c.query('UPDATE ess.tickets SET assigned_to = $2 WHERE id = $1', [a.t.id, hr.employee_code]);
    await c.query(`INSERT INTO ess.ticket_events (ticket_id, by_code, type, text) VALUES ($1,$2,'reassigned',$3)`,
      [a.t.id, ctx.me.employee_code, 'From ' + (names[a.t.assigned_to] || a.t.assigned_to) + ' to ' + hr.employee_name + ' — ' + note]);
  });
  return { ok: true, name: hr.employee_name };
}

async function ticketClose(body, req, ctx) {
  const text = String(body.text || '').trim().slice(0, 2000);
  if (!text) return { ok: false, error: 'Add a resolution note.' };
  const a = await actionable(ctx, body.id); if (a.error) return { ok: false, error: a.error };
  await tx(async c => {
    await c.query(`UPDATE ess.tickets SET status = 'Closed', closed_at = now() WHERE id = $1`, [a.t.id]);
    await c.query(`INSERT INTO ess.ticket_events (ticket_id, by_code, type, text) VALUES ($1,$2,'closed',$3)`, [a.t.id, ctx.me.employee_code, text]);
  });
  return { ok: true };
}

// GET /api/file/:id — streams an attachment if the viewer can see its ticket.
async function sendFile(req, res, ctx) {
  const id = String(req.params.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(404).end();
  const f = (await query('SELECT * FROM ess.ticket_files WHERE id = $1', [id])).rows[0];
  if (!f) return res.status(404).end();
  const vis = await query(`SELECT 1 FROM ess.tickets t WHERE t.id = $4 AND ${visibilitySql('t')}`, [...visParams(ctx), f.ticket_id]);
  if (!vis.rowCount) return res.status(404).end();
  const inline = /^(image\/(png|jpeg)|application\/pdf)$/.test(f.mime);
  res.set('Content-Type', f.mime);
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Disposition', (inline ? 'inline' : 'attachment') + '; filename*=UTF-8\'\'' + encodeURIComponent(f.name));
  res.sendFile(path.join(config.uploadDir, f.stored_name));
}

module.exports = {
  CATEGORIES,
  session: {
    tickets, hrList: hrListAction,
    raiseTicket: { fn: raiseTicket, write: true },
  },
  hr: {
    ticketRemark: { fn: ticketRemark, write: true },
    ticketReassign: { fn: ticketReassign, write: true },
    ticketClose: { fn: ticketClose, write: true },
  },
  sendFile,
};
