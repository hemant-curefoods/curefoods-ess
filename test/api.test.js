'use strict';
// End-to-end API tests. Needs a running server with the sample Employee Master loaded:
//   BASE=http://127.0.0.1:3100 node --test test/
// (Uses the dummy employees from the prototype: CFD90001 employee, CFD90006 HR, CFD90007 HR Head, CFD90008 Admin.)
const test = require('node:test');
const assert = require('node:assert');
const BASE = process.env.BASE || 'http://127.0.0.1:3100';

async function api(body) {
  const r = await fetch(BASE + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return Object.assign(await r.json(), { _status: r.status });
}
// first-time sign-in: DOB -> set PIN -> session
async function signup(code, dob, pin) {
  const s = await api({ action: 'start', empCode: code });
  if (s.ok && !s.hasPin) {
    const v = await api({ action: 'verifyDob', empCode: code, dob });
    assert.ok(v.ok, JSON.stringify(v));
    const p = await api({ action: 'setPin', setupToken: v.setupToken, pin });
    assert.ok(p.ok, JSON.stringify(p));
    return p.session;
  }
  const l = await api({ action: 'loginPin', empCode: code, pin });
  assert.ok(l.ok, JSON.stringify(l));
  return l.session;
}

const S = {};
test('unknown / exited IDs', async () => {
  assert.match((await api({ action: 'start', empCode: 'NOPE1' })).error, /couldn’t find/);
  assert.match((await api({ action: 'start', empCode: 'CFD80011' })).error, /exited/);
});

test('first-time sign-in, weak PIN rules, login', async () => {
  const v = await api({ action: 'verifyDob', empCode: 'cfd90001', dob: '1998-04-12' });
  assert.ok(v.ok);
  assert.match((await api({ action: 'setPin', setupToken: v.setupToken, pin: '1234' })).error, /sequences/);
  assert.match((await api({ action: 'setPin', setupToken: v.setupToken, pin: '1998' })).error, /birth/);
  assert.match((await api({ action: 'setPin', setupToken: v.setupToken, pin: '1204' })).error, /birth/); // DDMM
  const p = await api({ action: 'setPin', setupToken: v.setupToken, pin: '4826' });
  assert.ok(p.ok);
  assert.equal(p.employee['Mobile Number'], 'XXXXXX5678', 'full mobile must never be sent');
  assert.equal(p.employee['Role'], 'employee');
  assert.equal(p.employee._route.partner.code, 'CFD90006');
  // setup token is single-use
  assert.equal((await api({ action: 'setPin', setupToken: v.setupToken, pin: '4827' })).ok, false);
  // DOB path closed once a PIN exists
  assert.match((await api({ action: 'verifyDob', empCode: 'CFD90001', dob: '1998-04-12' })).error, /already set/);
  S.emp = (await api({ action: 'loginPin', empCode: 'CFD90001', pin: '4826' })).session;
  assert.ok(S.emp);
});

test('roles derived from the master', async () => {
  S.hr = await signup('CFD90006', '1997-02-26', '7391');
  S.head = await signup('CFD90007', '1983-07-22', '5182');
  S.admin = await signup('CFD90008', '1995-03-01', '6604');
  S.l1 = await signup('CFD90002', '1991-09-23', '3917');
  assert.equal((await api({ action: 'me', session: S.hr })).employee.Role, 'hr');
  assert.equal((await api({ action: 'me', session: S.head })).employee.Role, 'hrhead');
  const a = (await api({ action: 'me', session: S.admin })).employee;
  assert.equal(a['Is Admin'], true);
  assert.equal((await api({ action: 'me', session: S.l1 })).employee.Role, 'l1');
});

test('wrong DOB / PIN lockout after 5 tries', async () => {
  for (let i = 1; i <= 4; i++) {
    const r = await api({ action: 'verifyDob', empCode: 'CFD90004', dob: '2000-01-01' });
    assert.equal(r.left, 5 - i);
  }
  const r5 = await api({ action: 'verifyDob', empCode: 'CFD90004', dob: '2000-01-01' });
  assert.match(r5.error, /locked/);
  // even the correct DOB is refused while locked
  assert.match((await api({ action: 'verifyDob', empCode: 'CFD90004', dob: '1987-06-30' })).error, /locked/);
  assert.match((await api({ action: 'start', empCode: 'CFD90004' })).error, /locked/);
});

test('HR PIN reset unlocks; employees cannot reset', async () => {
  assert.equal((await api({ action: 'resetPin', session: S.emp, empCode: 'CFD90004' }))._status, 403);
  const st = await api({ action: 'pinStatus', session: S.hr, empCode: 'CFD90004' });
  assert.equal(st.locked, true);
  assert.ok((await api({ action: 'resetPin', session: S.hr, empCode: 'CFD90004' })).ok);
  assert.ok((await api({ action: 'verifyDob', empCode: 'CFD90004', dob: '1987-06-30' })).ok);
  // HR can't reset the HR Head / Admin
  assert.match((await api({ action: 'resetPin', session: S.hr, empCode: 'CFD90007' })).error, /HR Head/);
});

test('reset kills existing sessions', async () => {
  const tmp = await api({ action: 'loginPin', empCode: 'CFD90002', pin: '3917' });
  assert.ok((await api({ action: 'resetPin', session: S.hr, empCode: 'CFD90002' })).ok);
  assert.equal((await api({ action: 'me', session: tmp.session }))._status, 401);
  S.l1 = await signup('CFD90002', '1991-09-23', '3917');
});

test('helpdesk: routing, visibility, HR actions', async () => {
  const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 test').toString('base64');
  const t1 = await api({ action: 'raiseTicket', session: S.emp, category: 'Payroll & Salary', description: 'Salary credited short this month', files: [{ name: 'slip.pdf', data: pdf }] });
  assert.ok(t1.ok, JSON.stringify(t1));
  assert.equal(t1.assignedTo, 'CFD90006');
  S.t1 = t1.id;
  const posh = await api({ action: 'raiseTicket', session: S.emp, category: 'POSH', description: 'Confidential concern to report' });
  assert.equal(posh.assignedTo, 'CFD90007', 'POSH goes to HR Head');
  S.posh = posh.id;
  // bad attachment type rejected
  assert.match((await api({ action: 'raiseTicket', session: S.emp, category: 'Other', description: 'with an exe file attached', files: [{ name: 'x.exe', data: pdf }] })).error, /isn’t allowed/);

  const empList = (await api({ action: 'tickets', session: S.emp })).items.map(t => t.id);
  assert.ok(empList.includes(S.t1) && empList.includes(S.posh));
  const hrList = (await api({ action: 'tickets', session: S.hr })).items.map(t => t.id);
  assert.ok(hrList.includes(S.t1));
  assert.ok(!hrList.includes(S.posh), 'HR partner must not see POSH ticket');
  const l1List = (await api({ action: 'tickets', session: S.l1 })).items.map(t => t.id);
  assert.ok(!l1List.includes(S.t1), 'other employees cannot see it');
  const headList = (await api({ action: 'tickets', session: S.head })).items.map(t => t.id);
  assert.ok(headList.includes(S.t1) && headList.includes(S.posh));

  // employee cannot act as HR
  assert.equal((await api({ action: 'ticketRemark', session: S.emp, id: S.t1, text: 'hi' }))._status, 403);
  assert.ok((await api({ action: 'ticketRemark', session: S.hr, id: S.t1, text: 'Checking with payroll' })).ok);
  let t = (await api({ action: 'tickets', session: S.emp })).items.find(x => x.id === S.t1);
  assert.equal(t.status, 'In Progress');
  assert.equal(t.raiser.designation, undefined, 'employees get no HR-only raiser details');
  // HR can't touch the POSH ticket assigned to Head
  assert.match((await api({ action: 'ticketClose', session: S.hr, id: S.posh, text: 'x' })).error, /assigned HR/);
  // reassign to head, then HR still sees it (acted on it)
  assert.ok((await api({ action: 'ticketReassign', session: S.hr, id: S.t1, to: 'CFD90007', note: 'Needs head approval' })).ok);
  assert.ok((await api({ action: 'tickets', session: S.hr })).items.some(x => x.id === S.t1));
  assert.ok((await api({ action: 'ticketClose', session: S.head, id: S.t1, text: 'Arrears paid' })).ok);
  t = (await api({ action: 'tickets', session: S.emp })).items.find(x => x.id === S.t1);
  assert.equal(t.status, 'Closed');
  assert.deepEqual(t.events.map(e => e.type), ['created', 'assigned', 'remark', 'reassigned', 'closed']);
  S.fileId = t.files[0].id;
});

test('attachments only for people who can see the ticket', async () => {
  const get = tok => fetch(BASE + '/api/file/' + S.fileId, { headers: { Authorization: 'Bearer ' + tok } });
  const ok = await get(S.emp);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'application/pdf');
  assert.equal((await get(S.l1)).status, 404);
  assert.equal((await get('garbage')).status, 401);
});

test('admin view-as is read-only and audited', async () => {
  assert.equal((await api({ action: 'impersonate', session: S.hr, empCode: 'CFD90001', reason: 'checking' }))._status, 403);
  assert.match((await api({ action: 'impersonate', session: S.admin, empCode: 'CFD90001', reason: 'x' })).error, /reason/);
  const v = await api({ action: 'impersonate', session: S.admin, empCode: 'CFD90001', reason: 'Ticket HD check' });
  assert.ok(v.ok);
  assert.equal(v.employee['Employee Code'], 'CFD90001');
  assert.ok((await api({ action: 'tickets', session: v.session })).items.length >= 2);
  assert.match((await api({ action: 'raiseTicket', session: v.session, category: 'Other', description: 'should not be allowed' })).error, /Read-only/);
  assert.match((await api({ action: 'changePin', session: v.session, oldPin: '4826', newPin: '9174' })).error, /Read-only/);
  // admin can't view another admin
  assert.ok((await api({ action: 'logout', session: v.session })).ok);
  assert.equal((await api({ action: 'me', session: v.session }))._status, 401);
});

test('change PIN', async () => {
  assert.match((await api({ action: 'changePin', session: S.emp, oldPin: '0000', newPin: '9174' })).error, /incorrect/);
  assert.ok((await api({ action: 'changePin', session: S.emp, oldPin: '4826', newPin: '9174' })).ok);
  assert.ok((await api({ action: 'loginPin', empCode: 'CFD90001', pin: '9174' })).ok);
});

test('documents report not-connected cleanly', async () => {
  const r = await api({ action: 'myOffers', session: S.emp });
  assert.equal(r.ok, false);
  assert.match(r.error, /aren’t connected/);
});

test('no session / bad action', async () => {
  assert.equal((await api({ action: 'tickets' }))._status, 401);
  assert.equal((await api({ action: 'dropTables' }))._status, 400);
});
