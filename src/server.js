'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const config = require('./config');
config.validate();
const { pool } = require('./db');
const api = require('./api');
const { purgeExpired } = require('./auth');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      frameSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      connectSrc: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      ...(config.https ? { upgradeInsecureRequests: [] } : {}),
    },
  },
  hsts: config.https ? { maxAge: 15552000 } : false,
  crossOriginEmbedderPolicy: false,
}));

// ---- rate limits ----
// Sign-in actions: per IP. (Per-employee lockout after 5 wrong tries is enforced separately.)
const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { ok: false, error: 'Too many attempts from this network. Please wait a few minutes.' },
  skip: req => !api.AUTH_ACTIONS.has(req.body && req.body.action),
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Please slow down.' },
});

// 5 attachments x 2 MB, base64-encoded ≈ 14 MB
app.post('/api', express.json({ limit: '15mb' }), apiLimiter, authLimiter, api.handle);
app.get('/api/file/:id', apiLimiter, api.file);
app.get('/healthz', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); } catch (e) { res.status(503).json({ ok: false }); }
});

app.use(express.static(path.join(__dirname, '..', 'public'), {
  index: 'index.html',
  setHeaders(res, p) {
    if (p.endsWith('.html')) res.set('Cache-Control', 'no-cache');
  },
}));
app.use((req, res) => res.status(404).send('Not found'));

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ ok: false, error: 'Attachments are too large (2 MB per file, 5 files max).' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: 'Bad request.' });
  console.error(err);
  res.status(500).json({ ok: false, error: 'Server error.' });
});

const server = app.listen(config.port, config.host, () => {
  console.log(`Curefoods ESS listening on http://${config.host}:${config.port}`);
});
setInterval(() => purgeExpired().catch(() => {}), 60 * 60 * 1000).unref();

function shutdown() {
  server.close(() => pool.end().then(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
