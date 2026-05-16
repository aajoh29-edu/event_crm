const express = require('express');
const db = require('../db/connection');

const router = express.Router();

// ── Full venue profit & performance analytics ─────────────────────────────────
router.get('/', (req, res) => {
  try {
    // Revenue, ticket count, and fill-rate per venue
    const byVenue = db.prepare(`
      SELECT
        e.venue,
        COUNT(DISTINCT e.id)                               AS event_count,
        COALESCE(SUM(b.total_price), 0)                   AS total_revenue,
        COALESCE(SUM(b.quantity), 0)                       AS tickets_sold,
        MAX(e.capacity)                                    AS capacity,
        ROUND(
          COALESCE(SUM(b.quantity), 0) * 100.0
          / NULLIF(COUNT(DISTINCT e.id) * MAX(e.capacity), 0)
        , 1)                                               AS avg_fill_pct
      FROM events e
      LEFT JOIN bookings b ON b.event_id = e.id AND b.status != 'refunded'
      WHERE e.venue IS NOT NULL
      GROUP BY e.venue
      ORDER BY total_revenue DESC
    `).all();

    // Every event with its revenue — for best-per-venue table
    const allEvents = db.prepare(`
      SELECT
        e.id, e.title, e.venue, e.event_date, e.genre,
        e.ticket_price, e.capacity,
        COALESCE(SUM(b.quantity), 0)    AS tickets_sold,
        COALESCE(SUM(b.total_price), 0) AS revenue,
        ROUND(
          COALESCE(SUM(b.quantity), 0) * 100.0 / NULLIF(e.capacity, 0)
        , 1)                             AS fill_pct
      FROM events e
      LEFT JOIN bookings b ON b.event_id = e.id AND b.status != 'refunded'
      WHERE e.venue IS NOT NULL
      GROUP BY e.id
      ORDER BY revenue DESC
    `).all();

    // Revenue by genre
    const byGenre = db.prepare(`
      SELECT
        e.genre,
        COUNT(DISTINCT e.id)            AS events,
        COALESCE(SUM(b.total_price), 0) AS revenue,
        COALESCE(SUM(b.quantity), 0)    AS tickets_sold
      FROM events e
      LEFT JOIN bookings b ON b.event_id = e.id AND b.status != 'refunded'
      WHERE e.genre IS NOT NULL
      GROUP BY e.genre
      ORDER BY revenue DESC
    `).all();

    // Monthly revenue (last 12 months)
    const monthly = db.prepare(`
      SELECT
        strftime('%Y-%m', b.booking_date)  AS month,
        COALESCE(SUM(b.total_price), 0)   AS revenue,
        COUNT(b.id)                        AS bookings
      FROM bookings b
      WHERE b.status != 'refunded'
      GROUP BY month
      ORDER BY month DESC
      LIMIT 12
    `).all();

    // Promoter contribution by event
    const promoterByEvent = db.prepare(`
      SELECT
        e.title, e.venue, e.event_date,
        p.name                          AS promoter_name,
        COUNT(b.id)                     AS bookings,
        COALESCE(SUM(b.total_price), 0) AS revenue
      FROM bookings b
      JOIN events    e ON b.event_id    = e.id
      JOIN promoters p ON b.promoter_id = p.id
      GROUP BY e.id, p.id
      ORDER BY revenue DESC
      LIMIT 50
    `).all();

    res.json({ byVenue, allEvents, byGenre, monthly, promoterByEvent });
  } catch (err) {
    res.status(500).json({ error: 'An error occurred.' });
  }
});

module.exports = router;
