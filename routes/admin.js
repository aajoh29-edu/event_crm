const express = require('express');
const db = require('../db/connection');
const { runManualBlast, runEventBlast } = require('../agents/blasts');
const router = express.Router();

const GENERIC_ERROR = 'An error occurred. Please try again.';

// ===== DASHBOARD ANALYTICS =====
router.get('/analytics', (req, res) => {
  try {
    const totalCustomers = db.prepare('SELECT COUNT(*) as c FROM customers').get().c;
    const vipCustomers = db.prepare('SELECT COUNT(*) as c FROM customers WHERE vip_status = 1').get().c;
    const totalEvents = db.prepare("SELECT COUNT(*) as c FROM events WHERE status = 'active'").get().c;
    const upcomingEvents = db.prepare("SELECT COUNT(*) as c FROM events WHERE status = 'active' AND event_date >= date('now')").get().c;
    const totalBookings = db.prepare('SELECT COUNT(*) as c FROM bookings').get().c;
    const totalRevenue = db.prepare('SELECT COALESCE(SUM(total_price), 0) as r FROM bookings').get().r;
    const pendingReservations = db.prepare("SELECT COUNT(*) as c FROM reservations WHERE status = 'pending'").get().c;
    const unreadMessages = db.prepare("SELECT COUNT(*) as c FROM contact_messages WHERE status = 'unread'").get().c;
    const subscribers = db.prepare('SELECT COUNT(*) as c FROM newsletter_subscribers WHERE active = 1').get().c;

    const revenueByEvent = db.prepare(`
      SELECT e.title, COALESCE(SUM(b.total_price), 0) as revenue, COUNT(b.id) as bookings
      FROM events e LEFT JOIN bookings b ON e.id = b.event_id
      GROUP BY e.id ORDER BY revenue DESC LIMIT 5
    `).all();

    const recentBookings = db.prepare(`
      SELECT date(booking_date) as day, COUNT(*) as count, COALESCE(SUM(total_price), 0) as revenue
      FROM bookings
      WHERE booking_date >= date('now', '-7 days')
      GROUP BY date(booking_date)
      ORDER BY day ASC
    `).all();

    res.json({
      totalCustomers, vipCustomers, totalEvents, upcomingEvents,
      totalBookings, totalRevenue, pendingReservations, unreadMessages, subscribers,
      revenueByEvent, recentBookings
    });
  } catch (err) {
    res.status(500).json({ error: GENERIC_ERROR });
  }
});

// ===== CUSTOMERS =====
router.get('/customers', (req, res) => {
  const q = req.query.q || '';
  const rows = q
    ? db.prepare(`SELECT * FROM customers WHERE first_name LIKE ? OR last_name LIKE ? OR email LIKE ? ORDER BY created_at DESC`).all(`%${q}%`, `%${q}%`, `%${q}%`)
    : db.prepare('SELECT * FROM customers ORDER BY created_at DESC').all();
  res.json(rows);
});

router.get('/customers/:id', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Not found' });
  const bookings = db.prepare(`
    SELECT b.*, e.title as event_title, e.event_date FROM bookings b
    LEFT JOIN events e ON b.event_id = e.id WHERE b.customer_id = ?
    ORDER BY b.booking_date DESC
  `).all(req.params.id);
  const reservations = db.prepare('SELECT * FROM reservations WHERE customer_id = ? ORDER BY reservation_date DESC').all(req.params.id);
  const inferredPreferences = db.prepare(`
    SELECT e.genre, e.venue, COUNT(*) AS attended_count
    FROM bookings b
    JOIN events e ON e.id = b.event_id
    WHERE b.customer_id = ? AND b.status = 'confirmed'
    GROUP BY e.genre, e.venue
    ORDER BY attended_count DESC
  `).all(req.params.id);
  const preferences = db.prepare(`
    SELECT * FROM preference_game_submissions
    WHERE customer_id = ?
    ORDER BY created_at DESC
    LIMIT 10
  `).all(req.params.id);
  res.json({ ...customer, bookings, reservations, preferences, inferredPreferences });
});

router.post('/customers', (req, res) => {
  try {
    const {
      first_name, last_name, email, phone, social_handles, preferred_event_types,
      preferred_drinks, preferred_party_types, preferred_music, preferred_venue_types,
      email_opt_in, sms_opt_in, social_opt_in, vip_status, notes
    } = req.body;
    const result = db.prepare(`
      INSERT INTO customers
        (first_name, last_name, email, phone, social_handles, preferred_event_types,
         preferred_drinks, preferred_party_types, preferred_music, preferred_venue_types,
         email_opt_in, sms_opt_in, social_opt_in, vip_status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      first_name, last_name, email, phone || null, social_handles || null,
      preferred_event_types || null, preferred_drinks || null, preferred_party_types || null,
      preferred_music || null, preferred_venue_types || null,
      email_opt_in === false ? 0 : 1, sms_opt_in === false ? 0 : 1, social_opt_in === false ? 0 : 1,
      vip_status ? 1 : 0, notes || null
    );
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    res.status(400).json({ error: GENERIC_ERROR });
  }
});

router.put('/customers/:id', (req, res) => {
  try {
    const {
      first_name, last_name, email, phone, social_handles, preferred_event_types,
      preferred_drinks, preferred_party_types, preferred_music, preferred_venue_types,
      email_opt_in, sms_opt_in, social_opt_in, vip_status, notes
    } = req.body;
    db.prepare(`
      UPDATE customers
      SET first_name=?, last_name=?, email=?, phone=?, social_handles=?, preferred_event_types=?,
          preferred_drinks=?, preferred_party_types=?, preferred_music=?, preferred_venue_types=?,
          email_opt_in=?, sms_opt_in=?, social_opt_in=?, vip_status=?, notes=?
      WHERE id=?
    `).run(
      first_name, last_name, email, phone || null, social_handles || null,
      preferred_event_types || null, preferred_drinks || null, preferred_party_types || null,
      preferred_music || null, preferred_venue_types || null,
      email_opt_in === false ? 0 : 1, sms_opt_in === false ? 0 : 1, social_opt_in === false ? 0 : 1,
      vip_status ? 1 : 0, notes || null, req.params.id
    );
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: GENERIC_ERROR });
  }
});

router.delete('/customers/:id', (req, res) => {
  db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ===== EVENTS =====
router.get('/events', (req, res) => {
  const events = db.prepare(`
    SELECT e.*, COUNT(b.id) as bookings_count, COALESCE(SUM(b.total_price), 0) as revenue
    FROM events e LEFT JOIN bookings b ON e.id = b.event_id
    GROUP BY e.id ORDER BY event_date DESC
  `).all();
  res.json(events);
});

router.post('/events', async (req, res) => {
  try {
    const { title, genre, description, event_date, event_time, venue, image_url, ticket_price, capacity, status } = req.body;
    const validStatuses = ['active', 'cancelled', 'completed'];
    const resolvedStatus = validStatuses.includes(status) ? status : 'active';
    const result = db.prepare(`
      INSERT INTO events (title, genre, description, event_date, event_time, venue, image_url, ticket_price, capacity, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(title, genre || null, description || null, event_date, event_time || null, venue || null, image_url || null, ticket_price || 0, capacity || 100, resolvedStatus);
    let blast = null;
    if (resolvedStatus === 'active') {
      blast = await runEventBlast(result.lastInsertRowid, req.session?.username || 'admin');
    }
    res.json({ success: true, id: result.lastInsertRowid, blast });
  } catch (err) {
    res.status(400).json({ error: GENERIC_ERROR });
  }
});

router.put('/events/:id', (req, res) => {
  try {
    const { title, genre, description, event_date, event_time, venue, image_url, ticket_price, capacity, status } = req.body;
    const validStatuses = ['active', 'cancelled', 'completed'];
    const resolvedStatus = validStatuses.includes(status) ? status : 'active';
    db.prepare(`
      UPDATE events SET title=?, genre=?, description=?, event_date=?, event_time=?, venue=?, image_url=?, ticket_price=?, capacity=?, status=? WHERE id=?
    `).run(title, genre || null, description || null, event_date, event_time || null, venue || null, image_url || null, ticket_price || 0, capacity || 100, resolvedStatus, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: GENERIC_ERROR });
  }
});

router.delete('/events/:id', (req, res) => {
  db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ===== BOOKINGS =====
router.get('/bookings', (req, res) => {
  const rows = db.prepare(`
    SELECT b.*, c.first_name, c.last_name, c.email, e.title as event_title, e.event_date
    FROM bookings b
    LEFT JOIN customers c ON b.customer_id = c.id
    LEFT JOIN events e ON b.event_id = e.id
    ORDER BY b.booking_date DESC
  `).all();
  res.json(rows);
});

router.put('/bookings/:id', (req, res) => {
  const validStatuses = ['confirmed', 'cancelled', 'refunded'];
  const status = validStatuses.includes(req.body.status) ? req.body.status : 'confirmed';
  db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ success: true });
});

router.delete('/bookings/:id', (req, res) => {
  db.prepare('DELETE FROM bookings WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ===== RESERVATIONS =====
router.get('/reservations', (req, res) => {
  const rows = db.prepare('SELECT * FROM reservations ORDER BY reservation_date DESC, created_at DESC').all();
  res.json(rows);
});

router.put('/reservations/:id', (req, res) => {
  const validStatuses = ['pending', 'confirmed', 'cancelled'];
  const status = validStatuses.includes(req.body.status) ? req.body.status : 'pending';
  db.prepare('UPDATE reservations SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ success: true });
});

router.delete('/reservations/:id', (req, res) => {
  db.prepare('DELETE FROM reservations WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ===== CONTACT MESSAGES =====
router.get('/messages', (req, res) => {
  res.json(db.prepare('SELECT * FROM contact_messages ORDER BY created_at DESC').all());
});

router.put('/messages/:id', (req, res) => {
  const validStatuses = ['unread', 'read', 'replied'];
  const status = validStatuses.includes(req.body.status) ? req.body.status : 'unread';
  db.prepare('UPDATE contact_messages SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ success: true });
});

router.delete('/messages/:id', (req, res) => {
  db.prepare('DELETE FROM contact_messages WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ===== SUBSCRIBERS =====
router.get('/subscribers', (req, res) => {
  res.json(db.prepare('SELECT * FROM newsletter_subscribers ORDER BY subscribed_at DESC').all());
});

router.delete('/subscribers/:id', (req, res) => {
  db.prepare('DELETE FROM newsletter_subscribers WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ===== BLASTS =====
router.get('/blasts', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT bc.*, e.title AS event_title
      FROM blast_campaigns bc
      LEFT JOIN events e ON e.id = bc.event_id
      ORDER BY bc.created_at DESC
      LIMIT 50
    `).all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: GENERIC_ERROR });
  }
});

router.get('/blasts/:id/messages', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT bm.*, c.first_name, c.last_name, c.email
      FROM blast_messages bm
      LEFT JOIN customers c ON c.id = bm.customer_id
      WHERE bm.campaign_id = ?
      ORDER BY bm.created_at DESC
      LIMIT 300
    `).all(req.params.id);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: GENERIC_ERROR });
  }
});

router.post('/blasts', async (req, res) => {
  try {
    const { title, subject, body, channels } = req.body;
    if (!body) return res.status(400).json({ error: 'Message body is required.' });
    const result = await runManualBlast({
      title,
      subject,
      body,
      channels,
      triggeredBy: req.session?.username || 'admin',
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: GENERIC_ERROR });
  }
});

router.post('/events/:id/blast', async (req, res) => {
  try {
    const result = await runEventBlast(req.params.id, req.session?.username || 'admin');
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: GENERIC_ERROR });
  }
});

module.exports = router;
