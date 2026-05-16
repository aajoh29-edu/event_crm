const express = require('express');
const session = require('express-session');
const path = require('path');
require('dotenv').config();

const { router: authRouter, requireAuth } = require('./routes/auth');
const publicRouter = require('./routes/public');
const adminRouter = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; " +
    "font-src https://cdnjs.cloudflare.com; " +
    "script-src 'self' 'unsafe-inline'; " +
    "img-src 'self' https://images.unsplash.com data: blob:;"
  );
  next();
});

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret || sessionSecret === 'change-this-to-a-long-random-string-before-production') {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: SESSION_SECRET is not set. Refusing to start in production.');
    process.exit(1);
  } else {
    console.warn('WARNING: SESSION_SECRET is not set. Use a strong random value in production.');
  }
}

app.use(session({
  secret: sessionSecret || 'dev-only-insecure-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Public website static files
app.use(express.static(path.join(__dirname, 'public')));

// Public API (no auth) — for website forms
app.use('/api', publicRouter);

// Auth endpoints (login/logout)
app.use('/auth', authRouter);

// Admin login page — accessible without auth
app.get('/admin/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'login.html'));
});

// All other /admin routes & API require auth
app.use('/admin/api', requireAuth, adminRouter);
app.use('/admin', requireAuth, express.static(path.join(__dirname, 'admin')));

// Fallback
app.use((req, res) => {
  res.status(404).send('Not found');
});

app.listen(PORT, () => {
  console.log(`\n🎵 Classic Productions running at http://localhost:${PORT}`);
  console.log(`   Public site:  http://localhost:${PORT}`);
  console.log(`   Admin CRM:    http://localhost:${PORT}/admin`);
});
