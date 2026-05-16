/**
 * Re-engagement AI Agent
 *
 * Finds customers whose last confirmed booking was >30 days ago (or who have
 * never booked), then sends personalised outreach via email, SMS, and queues
 * a social-media DM.  Claude generates the message copy; all channels
 * fall back to sensible defaults when credentials are absent.
 *
 * Security notes:
 *  - No raw error details are exposed to callers.
 *  - A per-customer 7-day cooldown prevents flooding.
 *  - All DB writes use parameterised statements.
 */

'use strict';

const db = require('../db/connection');

// ── Optional: Claude AI (graceful degradation if key absent) ──────────────────
let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch (_) {}

function buildAnthropicClient() {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// ── Optional: Twilio SMS ──────────────────────────────────────────────────────
let twilio = null;
try { twilio = require('twilio'); } catch (_) {}

function buildTwilioClient() {
  if (!twilio || !process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return null;
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// ── Optional: Nodemailer ──────────────────────────────────────────────────────
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (_) {}

function buildMailTransport() {
  if (!nodemailer || !process.env.SMTP_HOST || !process.env.SMTP_USER) return null;
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_PORT === '465',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

// ── Message generation ────────────────────────────────────────────────────────
function defaultMessages(customer, upcomingEvents) {
  const topEvents = upcomingEvents.slice(0, 3)
    .map(e => `• ${e.title} at ${e.venue} — ${e.event_date} ($${Number(e.ticket_price).toFixed(2)})`)
    .join('\n');

  return {
    email: {
      subject: `${customer.first_name}, Classic Productions misses you 🎵`,
      body:
        `Hey ${customer.first_name},\n\n` +
        `It's been a minute! We have some incredible events coming up in D.C. and Baltimore ` +
        `that we think you'll love.\n\n${topEvents}\n\n` +
        `Book your spot at classicproductions.com — VIP tables still available.\n\n` +
        `See you on the floor,\nClassic Productions`,
    },
    sms:
      `Classic Productions: ${customer.first_name}, we miss you! ` +
      `${upcomingEvents[0]?.title || 'New events'} + more live in DC & Baltimore. ` +
      `Grab your spot: classicproductions.com`,
    social_dm:
      `Hey ${customer.first_name}! It's been a while — we've got some serious events ` +
      `dropping in DC & Baltimore. ${upcomingEvents[0]?.title || 'Check our latest lineup'} ` +
      `is one you don't want to sleep on. Come through!`,
  };
}

async function generateMessages(customer, daysSince, attended, upcomingEvents) {
  const client = buildAnthropicClient();
  if (!client || !upcomingEvents.length) return defaultMessages(customer, upcomingEvents);

  const eventsText = upcomingEvents.slice(0, 4)
    .map(e => `• ${e.title} | ${e.venue} | ${e.event_date} | $${Number(e.ticket_price).toFixed(2)} | ${e.genre || ''}`)
    .join('\n');

  const attendedText = attended.length
    ? attended.map(e => e.title).join(', ')
    : 'No prior attendance recorded';

  const prompt = `
Customer profile:
  Name: ${customer.first_name} ${customer.last_name}
  VIP: ${customer.vip_status ? 'Yes' : 'No'}
  Days since last event: ${daysSince ?? 'Never attended'}
  Events attended previously: ${attendedText}
  Total spent: $${Number(customer.total_spent).toFixed(2)}

Upcoming Classic Productions events (Washington D.C. & Baltimore, Hip-Hop & R&B):
${eventsText}

Write personalised re-engagement outreach. Brand voice: upscale urban nightlife, warm but cool.
Reference their history where possible.

Respond with ONLY valid JSON — no markdown, no extra text:
{
  "email_subject": "string (max 80 chars)",
  "email_body":    "string (max 200 words, no emojis)",
  "sms":           "string (max 155 chars, no emojis)",
  "social_dm":     "string (max 100 words, casual, may use 1-2 emojis)"
}`.trim();

  try {
    const msg = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 700,
      system:     'You are a marketing copywriter for Classic Productions, a premier Hip-Hop & R&B event brand in Washington D.C. and Baltimore. Respond ONLY with the requested JSON object.',
      messages:   [{ role: 'user', content: prompt }],
    });

    const parsed = JSON.parse(msg.content[0].text.trim());
    return {
      email: { subject: parsed.email_subject, body: parsed.email_body },
      sms:   parsed.sms,
      social_dm: parsed.social_dm,
    };
  } catch (_) {
    return defaultMessages(customer, upcomingEvents);
  }
}

// ── Main agent entry point ────────────────────────────────────────────────────
async function runReengagementAgent(triggeredBy = 'cron') {
  const log = {
    triggered_by:    triggeredBy,
    customers_found: 0,
    outreach_sent:   0,
    skipped:         0,
    errors:          [],
  };

  // Find dormant customers (last confirmed booking > 30 days or none ever)
  const dormant = db.prepare(`
    SELECT
      c.*,
      MAX(b.booking_date) AS last_booking_date,
      CAST(julianday('now') - julianday(MAX(b.booking_date)) AS INTEGER)
                          AS days_since
    FROM customers c
    LEFT JOIN bookings b ON b.customer_id = c.id AND b.status = 'confirmed'
    GROUP BY c.id
    HAVING last_booking_date IS NULL OR days_since > 30
    ORDER BY days_since DESC
  `).all();

  log.customers_found = dormant.length;

  const upcoming = db.prepare(`
    SELECT * FROM events
    WHERE status = 'active' AND event_date >= date('now')
    ORDER BY event_date ASC
    LIMIT 4
  `).all();

  if (!upcoming.length) {
    const r = db.prepare(`
      INSERT INTO agent_runs (triggered_by, customers_found, outreach_sent, status, notes)
      VALUES (?, ?, 0, 'skipped', 'No upcoming events to promote')
    `).run(triggeredBy, dormant.length);
    return { ...log, run_id: r.lastInsertRowid, status: 'skipped' };
  }

  const mail   = buildMailTransport();
  const smsApi = buildTwilioClient();

  for (const customer of dormant) {
    // 7-day cooldown per customer
    const recent = db.prepare(`
      SELECT id FROM agent_outreach
      WHERE customer_id = ? AND sent_at >= datetime('now', '-7 days')
      LIMIT 1
    `).get(customer.id);

    if (recent) { log.skipped++; continue; }

    const attended = db.prepare(`
      SELECT DISTINCT e.title
      FROM bookings b JOIN events e ON b.event_id = e.id
      WHERE b.customer_id = ? AND b.status = 'confirmed'
      ORDER BY b.booking_date DESC LIMIT 5
    `).all(customer.id);

    const msgs = await generateMessages(customer, customer.days_since, attended, upcoming);

    // Email
    if (customer.email) {
      if (mail) {
        try {
          await mail.sendMail({
            from:    process.env.EMAIL_FROM || process.env.SMTP_USER,
            to:      customer.email,
            subject: msgs.email.subject,
            text:    msgs.email.body,
          });
          db.prepare(`INSERT INTO agent_outreach (customer_id, channel, status, message_preview)
            VALUES (?, 'email', 'sent', ?)`)
            .run(customer.id, msgs.email.subject.slice(0, 200));
          log.outreach_sent++;
        } catch (err) {
          db.prepare(`INSERT INTO agent_outreach (customer_id, channel, status, error_message)
            VALUES (?, 'email', 'failed', ?)`)
            .run(customer.id, String(err.message).slice(0, 200));
          log.errors.push(`email:${customer.email}`);
        }
      } else {
        // No SMTP configured — log as queued so admin can review
        db.prepare(`INSERT INTO agent_outreach (customer_id, channel, status, message_preview)
          VALUES (?, 'email', 'queued', ?)`)
          .run(customer.id, msgs.email.subject.slice(0, 200));
      }
    }

    // SMS
    if (customer.phone) {
      if (smsApi) {
        try {
          await smsApi.messages.create({
            body: msgs.sms,
            from: process.env.TWILIO_PHONE_NUMBER,
            to:   customer.phone,
          });
          db.prepare(`INSERT INTO agent_outreach (customer_id, channel, status, message_preview)
            VALUES (?, 'sms', 'sent', ?)`)
            .run(customer.id, msgs.sms.slice(0, 155));
          log.outreach_sent++;
        } catch (err) {
          db.prepare(`INSERT INTO agent_outreach (customer_id, channel, status, error_message)
            VALUES (?, 'sms', 'failed', ?)`)
            .run(customer.id, String(err.message).slice(0, 200));
        }
      } else {
        db.prepare(`INSERT INTO agent_outreach (customer_id, channel, status, message_preview)
          VALUES (?, 'sms', 'queued', ?)`)
          .run(customer.id, msgs.sms.slice(0, 155));
      }
    }

    // Social DM — always queued (requires platform API credentials per network)
    db.prepare(`INSERT INTO agent_outreach (customer_id, channel, status, message_preview)
      VALUES (?, 'social_dm', 'queued', ?)`)
      .run(customer.id, msgs.social_dm.slice(0, 200));
  }

  const run = db.prepare(`
    INSERT INTO agent_runs (triggered_by, customers_found, outreach_sent, status)
    VALUES (?, ?, ?, 'completed')
  `).run(triggeredBy, log.customers_found, log.outreach_sent);

  return { ...log, run_id: run.lastInsertRowid, status: 'completed' };
}

module.exports = { runReengagementAgent };
