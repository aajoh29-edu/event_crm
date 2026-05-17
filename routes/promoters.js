const express = require('express');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const db = require('../db/connection');

const router = express.Router();
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const GENERIC_ERROR = 'An error occurred. Please try again.';

// ── List all promoters with aggregated sales stats ────────────────────────────
router.get('/', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT
        p.*,
        COUNT(DISTINCT b.id)          AS ticket_sales_count,
        COALESCE(SUM(b.total_price),0) AS ticket_revenue,
        COUNT(DISTINCT r.id)          AS table_count,
        COUNT(DISTINCT pc.customer_id) AS client_count
      FROM promoters p
      LEFT JOIN bookings      b  ON b.promoter_id  = p.id
      LEFT JOIN reservations  r  ON r.promoter_id  = p.id
      LEFT JOIN promoter_clients pc ON pc.promoter_id = p.id
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `).all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: GENERIC_ERROR });
  }
});

// ── Single promoter — full detail with sales & client list ────────────────────
router.get('/performance/events', (req, res) => {
  try {
    const rows = db.prepare(`
      WITH promoter_event AS (
        SELECT
          e.id AS event_id,
          e.title AS event_title,
          e.event_date,
          e.venue,
          e.capacity,
          p.id AS promoter_id,
          p.name AS promoter_name,
          COALESCE(SUM(b.quantity), 0) AS tickets_sold,
          COALESCE(SUM(b.total_price), 0) AS ticket_revenue,
          0 AS table_reservations,
          0 AS table_guests
        FROM events e
        JOIN bookings b ON b.event_id = e.id AND b.promoter_id IS NOT NULL
        JOIN promoters p ON p.id = b.promoter_id
        GROUP BY e.id, p.id

        UNION ALL

        SELECT
          e.id AS event_id,
          e.title AS event_title,
          e.event_date,
          e.venue,
          e.capacity,
          p.id AS promoter_id,
          p.name AS promoter_name,
          0 AS tickets_sold,
          0 AS ticket_revenue,
          COUNT(r.id) AS table_reservations,
          COALESCE(SUM(r.party_size), 0) AS table_guests
        FROM events e
        JOIN reservations r ON r.reservation_date = e.event_date AND r.promoter_id IS NOT NULL
        JOIN promoters p ON p.id = r.promoter_id
        GROUP BY e.id, p.id
      )
      SELECT
        event_id,
        event_title,
        event_date,
        venue,
        capacity,
        promoter_id,
        promoter_name,
        SUM(tickets_sold) AS tickets_sold,
        SUM(ticket_revenue) AS ticket_revenue,
        SUM(table_reservations) AS table_reservations,
        SUM(table_guests) AS table_guests,
        SUM(tickets_sold) + (SUM(table_reservations) * 4) AS performance_score
      FROM promoter_event
      GROUP BY event_id, promoter_id
      ORDER BY event_date DESC, performance_score DESC, promoter_name ASC
    `).all();

    const grouped = [];
    const byEvent = new Map();
    for (const row of rows) {
      if (!byEvent.has(row.event_id)) {
        const event = {
          id: row.event_id,
          title: row.event_title,
          event_date: row.event_date,
          venue: row.venue,
          capacity: row.capacity,
          promoters: [],
        };
        byEvent.set(row.event_id, event);
        grouped.push(event);
      }
      byEvent.get(row.event_id).promoters.push({
        id: row.promoter_id,
        name: row.promoter_name,
        tickets_sold: row.tickets_sold,
        ticket_revenue: row.ticket_revenue,
        table_reservations: row.table_reservations,
        table_guests: row.table_guests,
        performance_score: row.performance_score,
      });
    }

    res.json(grouped);
  } catch (err) {
    res.status(500).json({ error: GENERIC_ERROR });
  }
});

router.get('/:id', (req, res) => {
  try {
    const promoter = db.prepare('SELECT * FROM promoters WHERE id = ?').get(req.params.id);
    if (!promoter) return res.status(404).json({ error: 'Promoter not found.' });

    const ticketSales = db.prepare(`
      SELECT b.id, b.quantity, b.total_price, b.status, b.booking_date,
             c.first_name, c.last_name, c.email,
             e.title AS event_title, e.event_date
      FROM   bookings b
      LEFT JOIN customers c ON b.customer_id = c.id
      LEFT JOIN events    e ON b.event_id    = e.id
      WHERE  b.promoter_id = ?
      ORDER BY b.booking_date DESC
    `).all(req.params.id);

    const tableSales = db.prepare(`
      SELECT r.id, r.full_name, r.email, r.party_size, r.table_type,
             r.reservation_date, r.reservation_time, r.status
      FROM   reservations r
      WHERE  r.promoter_id = ?
      ORDER BY r.reservation_date DESC
    `).all(req.params.id);

    const clients = db.prepare(`
      SELECT c.id, c.first_name, c.last_name, c.email, c.phone,
             c.vip_status, c.total_spent,
             pc.referred_via, pc.created_at AS referred_at
      FROM   promoter_clients pc
      JOIN   customers c ON pc.customer_id = c.id
      WHERE  pc.promoter_id = ?
      ORDER BY pc.created_at DESC
    `).all(req.params.id);

    res.json({ ...promoter, ticketSales, tableSales, clients });
  } catch (err) {
    res.status(500).json({ error: GENERIC_ERROR });
  }
});

// ── Create promoter ───────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  try {
    const { name, email, phone, instagram_handle, twitter_handle, commission_rate, notes } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email are required.' });

    const qr_token = uuidv4();
    const result = db.prepare(`
      INSERT INTO promoters
        (name, email, phone, instagram_handle, twitter_handle, qr_token, commission_rate, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name, email,
      phone            || null,
      instagram_handle || null,
      twitter_handle   || null,
      qr_token,
      parseFloat(commission_rate) || 10.0,
      notes || null
    );

    res.json({ success: true, id: result.lastInsertRowid, qr_token });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(400).json({ error: 'A promoter with that email already exists.' });
    }
    res.status(500).json({ error: GENERIC_ERROR });
  }
});

// ── Update promoter ───────────────────────────────────────────────────────────
router.put('/:id', (req, res) => {
  try {
    const { name, email, phone, instagram_handle, twitter_handle, commission_rate, active, notes } = req.body;
    db.prepare(`
      UPDATE promoters
      SET name=?, email=?, phone=?, instagram_handle=?, twitter_handle=?,
          commission_rate=?, active=?, notes=?
      WHERE id=?
    `).run(
      name, email,
      phone            || null,
      instagram_handle || null,
      twitter_handle   || null,
      parseFloat(commission_rate) || 10.0,
      active ? 1 : 0,
      notes || null,
      req.params.id
    );
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: GENERIC_ERROR });
  }
});

// ── Delete promoter ───────────────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM promoters WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Generate QR code image ────────────────────────────────────────────────────
router.get('/:id/qr', async (req, res) => {
  try {
    const p = db.prepare('SELECT id, name, qr_token, active FROM promoters WHERE id = ?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Promoter not found.' });

    const bookingUrl = `${APP_URL}/book?ref=${p.qr_token}`;
    const qrDataUrl  = await QRCode.toDataURL(bookingUrl, {
      width:  300,
      margin: 2,
      color:  { dark: '#121212', light: '#f4f1ea' },
    });

    res.json({ qr_data_url: qrDataUrl, booking_url: bookingUrl, promoter_name: p.name });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code.' });
  }
});

// ── Rotate QR token (invalidates old links) ───────────────────────────────────
router.post('/:id/rotate-qr', (req, res) => {
  try {
    const new_token = uuidv4();
    db.prepare('UPDATE promoters SET qr_token = ? WHERE id = ?').run(new_token, req.params.id);
    res.json({ success: true, qr_token: new_token });
  } catch (err) {
    res.status(500).json({ error: GENERIC_ERROR });
  }
});

module.exports = router;
