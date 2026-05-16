const express = require('express');
const db = require('../db/connection');
const router = express.Router();

const GENERIC_ERROR = 'An error occurred. Please try again.';

// Get all active upcoming events
router.get('/events', (req, res) => {
  try {
    const events = db.prepare(`
      SELECT * FROM events
      WHERE status = 'active' AND event_date >= date('now')
      ORDER BY event_date ASC
    `).all();
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: GENERIC_ERROR });
  }
});

// Submit a table reservation
router.post('/reservations', (req, res) => {
  try {
    const { full_name, email, phone, party_size, reservation_date, reservation_time, table_type, special_requests } = req.body;
    if (!full_name || !email || !reservation_date) {
      return res.status(400).json({ error: 'Name, email, and date are required.' });
    }

    const validTableTypes = ['standard', 'premium', 'vip'];
    const resolvedTableType = validTableTypes.includes(table_type) ? table_type : 'standard';

    const size = Math.max(1, Math.min(20, parseInt(party_size) || 2));

    // Find or create customer
    let customer = db.prepare('SELECT id FROM customers WHERE email = ?').get(email);
    if (!customer) {
      const nameParts = String(full_name).trim().split(' ');
      const first = nameParts[0];
      const last = nameParts.slice(1).join(' ') || '';
      const result = db.prepare(`
        INSERT INTO customers (first_name, last_name, email, phone) VALUES (?, ?, ?, ?)
      `).run(first, last, email, phone || null);
      customer = { id: result.lastInsertRowid };
    }

    const result = db.prepare(`
      INSERT INTO reservations
      (customer_id, full_name, email, phone, party_size, reservation_date, reservation_time, table_type, special_requests)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(customer.id, full_name, email, phone || null, size, reservation_date, reservation_time || null, resolvedTableType, special_requests || null);

    res.json({ success: true, reservation_id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: GENERIC_ERROR });
  }
});

// Submit a contact form
router.post('/contact', (req, res) => {
  try {
    const { name, email, subject, message } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Name, email, and message are required.' });
    }
    const result = db.prepare(`
      INSERT INTO contact_messages (name, email, subject, message) VALUES (?, ?, ?, ?)
    `).run(name, email, subject || null, message);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: GENERIC_ERROR });
  }
});

// Subscribe to newsletter
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
  } catch (err) {
    res.status(500).json({ error: GENERIC_ERROR });
  }
});

// Book an event (ticket purchase)
router.post('/bookings', (req, res) => {
  try {
    const { event_id, full_name, email, phone, quantity } = req.body;
    if (!event_id || !full_name || !email) {
      return res.status(400).json({ error: 'Event, name, and email required.' });
    }

    const eventId = parseInt(event_id);
    if (!Number.isInteger(eventId) || eventId < 1) {
      return res.status(400).json({ error: 'Invalid event.' });
    }

    const qty = Math.max(1, Math.min(20, parseInt(quantity) || 1));

    const event = db.prepare('SELECT * FROM events WHERE id = ? AND status = ?').get(eventId, 'active');
    if (!event) return res.status(404).json({ error: 'Event not found.' });

    // Find or create customer
    let customer = db.prepare('SELECT * FROM customers WHERE email = ?').get(email);
    if (!customer) {
      const nameParts = String(full_name).trim().split(' ');
      const first = nameParts[0];
      const last = nameParts.slice(1).join(' ') || '';
      const result = db.prepare(`
        INSERT INTO customers (first_name, last_name, email, phone) VALUES (?, ?, ?, ?)
      `).run(first, last, email, phone || null);
      customer = { id: result.lastInsertRowid, total_spent: 0 };
    }

    const total = event.ticket_price * qty;

    const result = db.prepare(`
      INSERT INTO bookings (customer_id, event_id, quantity, total_price) VALUES (?, ?, ?, ?)
    `).run(customer.id, eventId, qty, total);

    db.prepare('UPDATE customers SET total_spent = total_spent + ? WHERE id = ?').run(total, customer.id);

    res.json({ success: true, booking_id: result.lastInsertRowid, total });
  } catch (err) {
    res.status(500).json({ error: GENERIC_ERROR });
  }
});

module.exports = router;
