'use strict';
// Creates / updates the "ess" schema. Safe to run repeatedly.
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

(async () => {
  const dir = path.join(__dirname, '..', 'sql');
  const files = fs.readdirSync(dir).filter(f => /^\d{3}_.*\.sql$/.test(f) && !f.startsWith('000_')).sort();
  for (const f of files) {
    process.stdout.write('Applying ' + f + ' ... ');
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
    console.log('ok');
  }
  await pool.end();
})().catch(e => { console.error('\nMigration failed:', e.message); process.exit(1); });
