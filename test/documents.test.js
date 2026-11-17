'use strict';
// Unit tests for offer-letter matching rules (no Google access needed).
process.env.PGDATABASE = process.env.PGDATABASE || 'x';
const test = require('node:test');
const assert = require('node:assert');
const { offerMatches, isoDate, isoDateTime, driveId } = require('../src/api/documents')._test;

const emp = { employee_code: 'CFD90001', mobile_number: '9741005678', date_of_birth: '1998-04-12' };
const base = { Status: 'Sent', 'Offer URL': 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123/view', 'Phone Number': '+91 97410 05678', 'Date of Birth': '12/04/1998', 'Generated On': '20-Oct-2023 11:02' };

test('offer matching', () => {
  assert.ok(offerMatches(base, emp));
  assert.ok(!offerMatches({ ...base, Status: 'Failed' }, emp));
  assert.ok(!offerMatches({ ...base, 'Phone Number': '9845000000' }, emp), 'old number -> no match');
  assert.ok(!offerMatches({ ...base, 'Date of Birth': '1999-01-01' }, emp), 'different DOB -> no match');
  assert.ok(offerMatches({ ...base, 'Date of Birth': '' }, emp), 'blank DOB is a placeholder');
  assert.ok(offerMatches({ ...base, 'Date of Birth': '20-Oct-2023' }, emp), 'DOB = issue date is a placeholder');
  assert.ok(!offerMatches({ ...base, 'Date of Birth': '01-Jan-2000' }, emp), 'real but different DOB -> no match');
  assert.ok(!offerMatches(base, { ...emp, mobile_number: '' }));
});
test('dates and drive ids', () => {
  assert.equal(isoDate('12-Apr-1998'), '1998-04-12');
  assert.equal(isoDate('3/11/2023'), '2023-11-03');
  assert.equal(isoDateTime('20-Oct-2023 11:02'), '2023-10-20 11:02');
  assert.equal(isoDateTime('2023-10-20'), '2023-10-20');
  assert.equal(driveId(base['Offer URL']), '1AbCdEfGhIjKlMnOpQrStUvWxYz0123');
  assert.equal(driveId('https://drive.google.com/open?id=1AbCdEfGhIjKlMnOpQrStUvWxYz0123'), '1AbCdEfGhIjKlMnOpQrStUvWxYz0123');
  assert.equal(driveId('demo'), '');
});
