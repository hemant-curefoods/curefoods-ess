/**
 * Curefoods ESS — PortalSync
 * ---------------------------------------------------------------------------
 * Copies generated offer letters and NAPS payslips (row data + PDF) from Google
 * into the ESS portal, so employees can view them there.
 *
 *  - Reads the "Offer Log" tab (Status = Sent) and every entity's "Payroll" tab
 *    (Status = Generated). Nothing in those sheets is changed.
 *  - Asks the portal what it already has and pushes only new or regenerated
 *    documents, so the first run back-fills history and later runs are small.
 *  - Every request is signed (HMAC-SHA256 with PORTAL_SECRET) and time-stamped.
 *
 * SETUP (once) — see README "Offer letters + payslips":
 *  1. script.google.com -> New project "ESS PortalSync" (use the HR account that can
 *     open the Offer Letter sheet, all Payroll sheets and the PDF folders).
 *  2. Paste this file. Project Settings -> Script Properties, add:
 *       PORTAL_URL      https://ess.curefoods.in          (no trailing slash)
 *       PORTAL_SECRET   <same value as INGEST_SECRET in the portal .env>
 *       OFFER_SHEET_ID  <id of the Offer Letter Automation spreadsheet>
 *       NAPS_SHEET_IDS  <payroll sheet id>,<payroll sheet id>,...   (one per entity)
 *     optional: OFFER_TAB (default "Offer Log"), NAPS_TAB (default "Payroll")
 *  3. Run testPortalConnection() once (authorise when asked).
 *  4. Run setupPortalSync()  -> runs syncToPortal() every 15 minutes.
 *     The first runs back-fill everything already generated (a few hundred per run).
 * ---------------------------------------------------------------------------
 */

// Column names in the sheets (change here if HR renames a column)
var COLS = {
  OFFER_STATUS: 'Status', OFFER_URL: 'Offer URL',
  PAY_EMP: 'Employee ID', PAY_MONTH: 'Pay Month', PAY_YEAR: 'Pay Year',
  PAY_STATUS: 'Status', PAY_PDF: 'PDF File ID'
};
var OFFER_SENT = 'sent';
var PAY_GENERATED = 'generated';
var MAX_RUN_MS = 4.5 * 60 * 1000;   // Apps Script hard limit is 6 min
var BATCH = 8;                      // parallel pushes per round-trip

// ============================== entry points ==============================

function syncToPortal() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { console.log('Previous sync still running — skipping.'); return; }
  var started = Date.now();
  var stats = { offers: 0, payslips: 0, skipped: 0, errors: [] };
  try {
    var cfg = config_();
    var known = call_(cfg, '/ingest/known', {});
    var knownOffers = {};
    (known.offers || []).forEach(function (id) { knownOffers[id] = true; });
    var knownSlips = known.payslips || {};

    // ---- offer letters ----
    var jobs = [];
    readTab_(cfg.offerSheetId, cfg.offerTab).forEach(function (row) {
      if (String(row[COLS.OFFER_STATUS]).trim().toLowerCase() !== OFFER_SENT) return;
      var fid = driveId_(row[COLS.OFFER_URL]);
      if (!fid || knownOffers[fid]) return;
      jobs.push({ path: '/ingest/offer', fileId: fid, body: { row: row } });
    });
    stats.offers = runJobs_(cfg, jobs, started, stats);

    // ---- payslips (one sheet per entity) ----
    jobs = [];
    cfg.napsSheetIds.forEach(function (sheetId) {
      readTab_(sheetId, cfg.napsTab).forEach(function (row) {
        if (String(row[COLS.PAY_STATUS]).trim().toLowerCase() !== PAY_GENERATED) return;
        var fid = driveId_(row[COLS.PAY_PDF]);
        if (!fid) return;
        var key = [sheetId, String(row[COLS.PAY_EMP]).trim().toUpperCase(), String(row[COLS.PAY_YEAR]).trim(), monthName_(row[COLS.PAY_MONTH])].join('|');
        if (knownSlips[key] === fid) return;          // same PDF already in the portal
        jobs.push({ path: '/ingest/payslip', fileId: fid, body: { sheetId: sheetId, row: row } });
      });
    });
    stats.payslips = runJobs_(cfg, jobs, started, stats);
  } catch (e) {
    stats.errors.push(String(e && e.message || e));
  } finally {
    var summary = new Date().toISOString() + ' offers+' + stats.offers + ' payslips+' + stats.payslips +
      (stats.skipped ? ' pending ' + stats.skipped + ' (next run)' : '') +
      (stats.errors.length ? ' errors ' + stats.errors.length + ': ' + stats.errors.slice(0, 5).join(' | ') : '');
    PropertiesService.getScriptProperties().setProperty('LAST_SYNC', summary.slice(0, 2000));
    console.log(summary);
    lock.releaseLock();
  }
}

function setupPortalSync() {
  config_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncToPortal') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncToPortal').timeBased().everyMinutes(15).create();
  console.log('PortalSync scheduled every 15 minutes. Running the first sync now...');
  syncToPortal();
}

function testPortalConnection() {
  var cfg = config_();
  var known = call_(cfg, '/ingest/known', {});
  console.log('Connected. Portal already has ' + (known.offers || []).length + ' offer letter(s) and ' +
    Object.keys(known.payslips || {}).length + ' payslip(s).');
  console.log('Offer Log rows: ' + readTab_(cfg.offerSheetId, cfg.offerTab).length);
  cfg.napsSheetIds.forEach(function (id) { console.log('Payroll ' + id + ' rows: ' + readTab_(id, cfg.napsTab).length); });
}

/** Remove one document from the portal (e.g. letter issued to the wrong person).
 *  kind: 'offer' | 'payslip'; fileId: the Drive file id of that PDF. */
function removeFromPortal(kind, fileId) {
  console.log(JSON.stringify(call_(config_(), '/ingest/remove', { kind: kind, fileId: fileId })));
}

// ============================== internals ==============================

function config_() {
  var p = PropertiesService.getScriptProperties();
  var url = String(p.getProperty('PORTAL_URL') || '').replace(/\/+$/, '');
  var secret = p.getProperty('PORTAL_SECRET') || '';
  if (!/^https:\/\//.test(url) && p.getProperty('ALLOW_HTTP') !== 'yes')
    throw new Error('PORTAL_URL must start with https:// (payslips contain salary data).');
  if (secret.length < 32) throw new Error('PORTAL_SECRET is missing or too short.');
  var cfg = {
    url: url, secret: secret,
    offerSheetId: p.getProperty('OFFER_SHEET_ID') || '',
    offerTab: p.getProperty('OFFER_TAB') || 'Offer Log',
    napsSheetIds: String(p.getProperty('NAPS_SHEET_IDS') || '').split(',').map(function (s) { return s.trim(); }).filter(String),
    napsTab: p.getProperty('NAPS_TAB') || 'Payroll'
  };
  if (!cfg.offerSheetId) throw new Error('OFFER_SHEET_ID is not set.');
  return cfg;
}

// Rows as {header: displayed value}. Display values avoid timezone/number surprises.
function readTab_(sheetId, tabName) {
  var sh = SpreadsheetApp.openById(sheetId).getSheetByName(tabName);
  if (!sh) throw new Error('Tab "' + tabName + '" not found in ' + sheetId);
  var values = sh.getDataRange().getDisplayValues();
  if (values.length < 2) return [];
  var head = values[0].map(function (h) { return String(h).trim(); });
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var o = {}, any = false;
    for (var c = 0; c < head.length; c++) {
      if (!head[c]) continue;
      o[head[c]] = values[r][c];
      if (values[r][c] !== '') any = true;
    }
    if (any) out.push(o);
  }
  return out;
}

function runJobs_(cfg, jobs, started, stats) {
  var done = 0;
  for (var i = 0; i < jobs.length; i += BATCH) {
    if (Date.now() - started > MAX_RUN_MS) { stats.skipped += jobs.length - i; break; }
    var batch = jobs.slice(i, i + BATCH), reqs = [], sent = [];
    batch.forEach(function (j) {
      try {
        j.body.pdf = Utilities.base64Encode(DriveApp.getFileById(j.fileId).getBlob().getBytes());
        reqs.push(request_(cfg, j.path, j.body));
        sent.push(j);
      } catch (e) {
        stats.errors.push(j.fileId + ': ' + (e && e.message || e));
      }
    });
    if (!reqs.length) continue;
    var res = UrlFetchApp.fetchAll(reqs);
    res.forEach(function (r, k) {
      if (r.getResponseCode() === 200) done++;
      else stats.errors.push(sent[k].fileId + ': HTTP ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 150));
    });
  }
  return done;
}

function call_(cfg, path, body) {
  var req = request_(cfg, path, body);
  var r = UrlFetchApp.fetch(req.url, req);
  if (r.getResponseCode() !== 200) throw new Error(path + ' -> HTTP ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 200));
  return JSON.parse(r.getContentText());
}

// Signed request. Body is ASCII-only JSON so the signature is byte-exact.
function request_(cfg, path, body) {
  var json = asciiJson_(body);
  var ts = String(Date.now());
  var sig = Utilities.computeHmacSha256Signature(ts + '.' + json, cfg.secret, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  return {
    url: cfg.url + path, method: 'post', contentType: 'application/json',
    payload: json, muteHttpExceptions: true,
    headers: { 'X-ESS-Timestamp': ts, 'X-ESS-Signature': sig }
  };
}

function asciiJson_(o) {
  return JSON.stringify(o).replace(/[\u007f-￿]/g, function (c) {
    return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
  });
}

function driveId_(v) {
  var s = String(v || '').trim();
  var m = /\/d\/([A-Za-z0-9_-]{20,})/.exec(s) || /[?&]id=([A-Za-z0-9_-]{20,})/.exec(s);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{20,}$/.test(s) ? s : '';
}

var MONTHS_ = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function monthName_(m) {
  var s = String(m || '').trim().toLowerCase();
  for (var i = 0; i < 12; i++) {
    if (MONTHS_[i].toLowerCase() === s || MONTHS_[i].slice(0, 3).toLowerCase() === s) return MONTHS_[i];
  }
  return String(m || '').trim();
}
