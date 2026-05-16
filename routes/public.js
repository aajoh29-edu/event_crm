'use strict';

const express = require('express');
const db      = require('../db/connection');
const router  = express.Router();

const GENERIC_ERROR = 'An error occurred. Please try again.';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Look up a promoter by QR token.
 * Returns { id, name } if found + active, otherwise null.
 */
function resolvePromoter(ref) {
  if (!ref || typeof ref !== 'string' || ref.length > 64) return null;
  return db.prepare(
    'SELECT id, name FROM promoters WHERE qr_token = ? AND active = 1'
  ).get(ref) || null;
}

/**
 * Upsert customer; returns customer id.
 */
function upsertCustomer(full_name, email, phone) {
  let customer = db.prepare('SELECT id FROM customers WHERE email = ?').get(email);
  if (!customer) {
    const parts = String(full_name).trim().split(' ');
    const first = parts[0];
    const last  = parts.slice(1).join(' ') || '';
    const r = db.prepare(
      'INSERT INTO customers (first_name, last_name, email, phone) VALUES (?, ?, ?, ?)'
    ).run(first, last, email, phone || null);
    customer = { id: r.lastInsertRowid };
  }
  return customer.id;
}

/**
 * Link a customer to a promoter (no-op if already linked).
 */
function linkPromoterClient(promoter_id, customer_id) {
  try {
    db.prepare(
      'INSERT INTO promoter_clients (promoter_id, customer_id) VALUES (?, ?)'
    ).run(promoter_id, customer_id);
  } catch (e) {
    if (!e.code === 'SQLITE_CONSTRAINT_UNIQUE') throw e;
  }
}

// ── GET /api/events ───────────────────────────────────────────────────────────
router.get('/events', (req, res) => {
  try {
    const events = db.prepare(`
      SELECT * FROM events
      WHERE status = 'active' AND event_date >= date('now')
      ORDER BY event_date ASC
    `).all();
    res.json(events);
  } catch (_) {
    res.status(500).json({ error: GENERIC_ERROR });
  }
});

// ── GET /api/verify-ref ───────────────────────────────────────────────────────
// Called by the QR landing page to display the promoter's name.
router.get('/verify-ref', (req, res) => {
  const promoter = resolvePromoter(req.query.ref);
  if (!promoter) return res.status(404).json({ error: 'Invalid or expired link.' });
  res.json({ promoter_name: promoter.name });
});

// ── POST /api/reservations ────────────────────────────────────────────────────
router.post('/reservations', (req, res) => {
  try {
    const {
      full_name, email, phone, party_size,
      reservation_date, reservation_time, table_type,
      special_requests, ref,
    } = req.body;

    if (!full_name || !email || !reservation_date) {
      return res.status(400).json({ error: 'Name, email, and date are required.' });
    }

    const validTableTypes = ['standard', 'premium', 'vip'];
    const resolvedType    = validTableTypes.includes(table_type) ? table_type : 'standard';
    const size            = Math.max(1, Math.min(20, parseInt(party_size) || 2));
    const promoter        = resolvePromoter(ref);
    const customer_id     = upsertCustomer(full_name, email, phone);

    if (promoter) linkPromoterClient(promoter.id, customer_id);

    const result = db.prepare(`
      INSERT INTO reservations
        (customer_id, full_name, email, phone, party_size,
         reservation_date, reservation_time, table_type, special_requests, promoter_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      customer_id, full_name, email, phone || null, size,
      reservation_date, reservation_time || null, resolvedType,
      special_requests || null,
      promoter ? promoter.id : null,
    );

    res.json({ success: true, reservation_id: result.lastInsertRowid });
  } catch (_) {
    res.status(500).json({ error: GENERIC_ERROR });
  }
});

// ── POST /api/contact ─────────────────────────────────────────────────────────
router.post('/contact', (req, res) => {
  try {
    const { name, email, subject, message } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Name, email, and message are required.' });
    }
    const result = db.prepare(
      'INSERT INTO contact_messages (name, email, subject, message) VALUES (?, ?, ?, ?)'
    ).run(name, email, subject || null, message);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (_) {
    res.status(500).json({ error: GENERIC_ERROR });
  }
});

// ── POST /api/subscribe ───────────────────────────────────────────────────────
router.post('/subscribe', (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required.' });
    try {
      db.prepare('INSERT INTO newsletter_subscribers (email) VALUES (?)').run(email);
    } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return res.json({ success: true, message: 'Already subscribed' });
      }
      throw e;
    }
    res.json({ success: true });
  } catch (_) {
    res.status(500).json({ error: GENERIC_ERROR });
  }
});

// ── POST /api/bookings ────────────────────────────────────────────────────────
router.post('/bookings', (req, res) => {
  try {
    const { event_id, full_name, email, phone, quantity, ref } = req.body;

    if (!event_id || !full_name || !email) {
      return res.status(400).json({ error: 'Event, name, and email are required.' });
    }

    const eventId = parseInt(event_id);
    if (!Number.isInteger(eventId) || eventId < 1) {
      return res.status(400).json({ error: 'Invalid event.' });
    }

    const qty   = Math.max(1, Math.min(20, parseInt(quantity) || 1));
    const event = db.prepare(
      "SELECT * FROM events WHERE id = ? AND status = 'active'"
    ).get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found.' });

    const promoter    = resolvePromoter(ref);
    const customer_id = upsertCustomer(full_name, email, phone);

    if (promoter) linkPromoterClient(promoter.id, customer_id);

    const total  = event.ticket_price * qty;
    const result = db.prepare(`
      INSERT INTO bookings (customer_id, event_id, quantity, total_price, promoter_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(customer_id, eventId, qty, total, promoter ? promoter.id : null);

    db.prepare(
      'UPDATE customers SET total_spent = total_spent + ? WHERE id = ?'
    ).run(total, customer_id);

    res.json({ success: true, booking_id: result.lastInsertRowid, total });
  } catch (_) {
    res.status(500).json({ error: GENERIC_ERROR });
  }
});

module.exports = router;
