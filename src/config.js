'use strict';
require('dotenv').config({ quiet: true });
const path = require('path');

function list(v) {
  return String(v || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
}
function bool(v, d) {
  if (v == null || v === '') return d;
  return /^(1|true|yes|on)$/i.test(String(v));
}

const config = {
  port: Number(process.env.PORT || 3100),
  host: process.env.HOST || '127.0.0.1',
  // true once the site is served over HTTPS (enables HSTS + upgrade-insecure-requests)
  https: bool(process.env.HTTPS, false),
  trustProxy: process.env.TRUST_PROXY || 'loopback',

  db: {
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl: bool(process.env.PGSSL, false) ? { rejectUnauthorized: bool(process.env.PGSSL_VERIFY, false) } : false,
    max: Number(process.env.PGPOOL_MAX || 10),
  },

  // Secret mixed into every PIN hash. Keep it in .env only — losing it means everyone re-sets their PIN.
  pinPepper: process.env.PIN_PEPPER || '',

  adminCodes: list(process.env.ADMIN_CODES),
  hrHeadCodes: list(process.env.HR_HEAD_CODES),

  maxFails: Number(process.env.MAX_FAILS || 5),
  // per IP: all sign-in requests per 5 min (generous: shared store Wi-Fi), and FAILED ones per hour (strict:
  // stops someone trying one common PIN across many Employee IDs)
  authRateLimit: Number(process.env.AUTH_RATE_LIMIT || 300),
  authFailLimit: Number(process.env.AUTH_FAIL_LIMIT || 30),
  lockMinutes: Number(process.env.LOCK_MINUTES || 30),
  sessionIdleMinutes: Number(process.env.SESSION_IDLE_MINUTES || 60),
  sessionMaxHours: Number(process.env.SESSION_MAX_HOURS || 12),
  setupMinutes: 10,
  viewAsMinutes: 30,
  slaHours: 48,

  uploadDir: path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads')),
  maxFiles: 5,
  maxFileBytes: 2 * 1024 * 1024,

  // where offer letters / payslips come from: 'db' (pushed by Apps Script PortalSync) or 'google' (service account)
  docsSource: (process.env.DOCS_SOURCE || 'db').toLowerCase(),
  docsDir: path.resolve(process.env.DOCS_DIR || path.join(__dirname, '..', 'data', 'documents')),
  // shared secret used by the Apps Script PortalSync job to sign pushes (32+ chars)
  ingestSecret: process.env.INGEST_SECRET || '',

  google: {
    credentialsFile: process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
    offerSheetId: process.env.OFFER_SHEET_ID || '',
    offerSheetTab: process.env.OFFER_SHEET_TAB || 'Offer Log',
    // one Payroll spreadsheet per entity -> comma-separated list of spreadsheet IDs
    napsSheetIds: String(process.env.NAPS_SHEET_IDS || process.env.NAPS_SHEET_ID || '').split(',').map(s => s.trim()).filter(Boolean),
    napsSheetTab: process.env.NAPS_SHEET_TAB || 'Payroll',
    cacheSeconds: Number(process.env.SHEETS_CACHE_SECONDS || 300),
  },
};

config.validate = function validate() {
  const missing = [];
  if (!config.db.database) missing.push('PGDATABASE');
  if (!config.db.user) missing.push('PGUSER');
  if (!config.pinPepper || config.pinPepper.length < 32) missing.push('PIN_PEPPER (32+ random chars)');
  if (!config.hrHeadCodes.length) missing.push('HR_HEAD_CODES');
  if (config.ingestSecret && config.ingestSecret.length < 32) missing.push('INGEST_SECRET (32+ random chars, or leave blank)');
  if (missing.length) {
    console.error('Missing/invalid settings in .env: ' + missing.join(', '));
    process.exit(1);
  }
};

module.exports = config;
