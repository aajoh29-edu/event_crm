'use strict';

const express     = require('express');
const session     = require('express-session');
const rateLimit   = require('express-rate-limit');
const cron        = require('node-cron');
const path        = require('path');
require('dotenv').config();

// Run DB migration on startup (creates new tables; no-ops if already present)
require('./db/migrate');

const { router: authRouter, requireAuth } = require('./routes/auth');
const publicRouter    = require('./routes/public');
const adminRouter     = require('./routes/admin');
const promoterRouter  = require('./routes/promoters');
const venueRouter     = require('./routes/venue');
const { runReengagementAgent } = require('./agents/reengagement');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Security headers ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options',  'nosniff');
  res.setHeader('X-Frame-Options',         'DENY');
  res.setHeader('X-XSS-Protection',        '1; mode=block');
  res.setHeader('Referrer-Policy',         'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; " +
    "font-src https://cdnjs.cloudflare.com; " +
    "script-src 'self' 'unsafe-inline'; " +
    "img-src 'self' https://images.unsplash.com data: blob:;"
  );
  next();
});

// ── Body parsing (10 KB cap) ──────────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// ── Session ───────────────────────────────────────────────────────────────────
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret || sessionSecret === 'change-this-to-a-long-random-string-before-production') {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: SESSION_SECRET not set. Refusing to start in production.');
    process.exit(1);
  } else {
    console.warn('WARNING: SESSION_SECRET is not set. Set it before deploying.');
  }
}

app.use(session({
  secret:            sessionSecret || 'dev-only-insecure-secret',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge:   24 * 60 * 60 * 1000,
  },
}));

// ── Rate limiters ─────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 min
  max: 20,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many login attempts. Please try again later.' },
});

const bookingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests. Please slow down.' },
});

const agentLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 5,
  message: { error: 'Agent run rate limit reached. Try again later.' },
});

// ── Static public files ───────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Public QR booking page ────────────────────────────────────────────────────
app.get('/book', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'book.html'));
});

// ── Public API ────────────────────────────────────────────────────────────────
app.use('/api', bookingLimiter, publicRouter);

// ── Auth ──────────────────────────────────────────────────────────────────────
app.use('/auth', authLimiter, authRouter);

// ── Admin login page ──────────────────────────────────────────────────────────
app.get('/admin/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'login.html'));
});

// ── Admin API (authenticated) ─────────────────────────────────────────────────
app.use('/admin/api',           requireAuth, adminRouter);
app.use('/admin/api/promoters', requireAuth, promoterRouter);
app.use('/admin/api/venue',     requireAuth, venueRouter);

// ── Admin: AI agent endpoints ─────────────────────────────────────────────────
const db = require('./db/connection');

app.post('/admin/api/agent/run', requireAuth, agentLimiter, async (req, res) => {
  try {
    const result = await runReengagementAgent('admin');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Agent encountered an error.' });
  }
});

app.get('/admin/api/agent/runs', requireAuth, (req, res) => {
  try {
    const runs = db.prepare('SELECT * FROM agent_runs ORDER BY run_at DESC LIMIT 30').all();
    res.json(runs);
  } catch (_) { res.status(500).json({ error: 'An error occurred.' }); }
});

app.get('/admin/api/agent/outreach', requireAuth, (req, res) => {
  try {
    const logs = db.prepare(`
      SELECT ao.*, c.first_name, c.last_name, c.email AS customer_email
      FROM   agent_outreach ao
      LEFT JOIN customers c ON ao.customer_id = c.id
      ORDER BY ao.sent_at DESC LIMIT 200
    `).all();
    res.json(logs);
  } catch (_) { res.status(500).json({ error: 'An error occurred.' }); }
});

app.get('/admin/api/agent/dormant', requireAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT c.*,
        MAX(b.booking_date) AS last_booking_date,
        CAST(julianday('now') - julianday(MAX(b.booking_date)) AS INTEGER) AS days_since
      FROM customers c
      LEFT JOIN bookings b ON b.customer_id = c.id AND b.status = 'confirmed'
      GROUP BY c.id
      HAVING last_booking_date IS NULL OR days_since > 30
      ORDER BY days_since DESC
    `).all();
    res.json(rows);
  } catch (_) { res.status(500).json({ error: 'An error occurred.' }); }
});

// ── Admin static files ────────────────────────────────────────────────────────
app.use('/admin', requireAuth, express.static(path.join(__dirname, 'admin')));

// ── 404 fallback ──────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).send('Not found'));

// ── Scheduled AI agent: daily at 9 AM ────────────────────────────────────────
cron.schedule('0 9 * * *', async () => {
  console.log('[cron] Running re-engagement agent…');
  try {
    const r = await runReengagementAgent('cron');
    console.log(`[cron] Done — ${r.outreach_sent} messages sent to ${r.customers_found} dormant customers.`);
  } catch (err) {
    console.error('[cron] Agent error:', err.message);
  }
});

app.listen(PORT, () => {
  console.log(`\n🎵 Classic Productions running at http://localhost:${PORT}`);
  console.log(`   Public site:  http://localhost:${PORT}`);
  console.log(`   Admin CRM:    http://localhost:${PORT}/admin`);
  console.log(`   QR Booking:   http://localhost:${PORT}/book?ref=<token>\n`);
});
