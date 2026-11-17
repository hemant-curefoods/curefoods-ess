'use strict';
const { Pool, types } = require('pg');
const config = require('./config');

// Return DATE columns as plain 'YYYY-MM-DD' strings (no timezone shifting).
types.setTypeParser(1082, v => v);

const pool = new Pool(config.db);
pool.on('error', err => console.error('[db] idle client error', err.message));

function query(text, params) {
  return pool.query(text, params);
}

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function audit(actor, action, target, detail, ip, client) {
  const q = client || pool;
  await q.query(
    'INSERT INTO ess.audit_log (actor, action, target, detail, ip) VALUES ($1,$2,$3,$4,$5)',
    [actor || null, action, target || null, detail || {}, ip || null]
  );
}

module.exports = { pool, query, tx, audit };
