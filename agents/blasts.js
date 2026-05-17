'use strict';

const db = require('../db/connection');

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (_) {}

let twilio = null;
try { twilio = require('twilio'); } catch (_) {}

function buildMailTransport() {
  if (!nodemailer || !process.env.SMTP_HOST || !process.env.SMTP_USER) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: process.env.SMTP_PORT === '465',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

function buildTwilioClient() {
  if (!twilio || !process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return null;
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

function cleanChannels(channels) {
  const allowed = new Set(['email', 'sms', 'social_dm']);
  const input = Array.isArray(channels) && channels.length ? channels : ['email', 'sms', 'social_dm'];
  return [...new Set(input.filter(channel => allowed.has(channel)))];
}

function buildEventCopy(event) {
  const dateLine = [event.event_date, event.event_time].filter(Boolean).join(' ');
  const venueLine = event.venue ? ` at ${event.venue}` : '';
  const priceLine = Number(event.ticket_price) > 0 ? `$${Number(event.ticket_price).toFixed(2)}` : 'Tickets available now';
  const link = process.env.APP_URL || 'http://localhost:3000';

  return {
    subject: `New event: ${event.title}`,
    body:
      `Classic Productions just added ${event.title}${venueLine}.\n\n` +
      `${dateLine}\n${event.genre || 'Nightlife'}\n${event.description || ''}\n\n` +
      `${priceLine}. Book now: ${link}`,
    sms:
      `Classic Productions: New event added - ${event.title}${venueLine}. ` +
      `${dateLine}. Book now: ${link}`,
    social_dm:
      `New Classic Productions event just dropped: ${event.title}${venueLine}. ` +
      `${dateLine}. Tap in at ${link}`,
  };
}

function createCampaign({ title, audience, channels, message, eventId, triggeredBy }) {
  const result = db.prepare(`
    INSERT INTO blast_campaigns
      (title, audience, channels, message_subject, message_body, event_id, triggered_by, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'running')
  `).run(
    title,
    audience || 'all',
    JSON.stringify(channels),
    message.subject || null,
    message.body,
    eventId || null,
    triggeredBy || 'admin'
  );
  return result.lastInsertRowid;
}

async function deliverBlast({ campaignId, channels, message, audience = 'all' }) {
  const mail = buildMailTransport();
  const smsApi = buildTwilioClient();
  const customers = db.prepare(`
    SELECT * FROM customers
    WHERE email_opt_in = 1 OR sms_opt_in = 1 OR social_opt_in = 1
    ORDER BY created_at DESC
  `).all();

  let attempted = 0;
  let sent = 0;
  let queued = 0;
  let failed = 0;

  for (const customer of customers) {
    for (const channel of channels) {
      if (channel === 'email' && (!customer.email || !customer.email_opt_in)) continue;
      if (channel === 'sms' && (!customer.phone || !customer.sms_opt_in)) continue;
      if (channel === 'social_dm' && (!customer.social_handles || !customer.social_opt_in)) continue;

      attempted++;
      let status = 'queued';
      let error = null;
      let preview = channel === 'email' ? message.subject : (message[channel] || message.body);

      try {
        if (channel === 'email' && mail) {
          await mail.sendMail({
            from: process.env.EMAIL_FROM || process.env.SMTP_USER,
            to: customer.email,
            subject: message.subject,
            text: message.body,
          });
          status = 'sent';
        } else if (channel === 'sms' && smsApi && process.env.TWILIO_PHONE_NUMBER) {
          await smsApi.messages.create({
            body: (message.sms || message.body).slice(0, 1550),
            from: process.env.TWILIO_PHONE_NUMBER,
            to: customer.phone,
          });
          status = 'sent';
        }
      } catch (err) {
        status = 'failed';
        error = String(err.message).slice(0, 300);
      }

      if (status === 'sent') sent++;
      if (status === 'queued') queued++;
      if (status === 'failed') failed++;

      db.prepare(`
        INSERT INTO blast_messages
          (campaign_id, customer_id, channel, status, destination, message_preview, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        campaignId,
        customer.id,
        channel,
        status,
        channel === 'email' ? customer.email : channel === 'sms' ? customer.phone : customer.social_handles,
        String(preview || '').slice(0, 250),
        error
      );

      db.prepare(`
        INSERT INTO agent_outreach (customer_id, channel, status, message_preview, error_message)
        VALUES (?, ?, ?, ?, ?)
      `).run(customer.id, channel, status, String(preview || '').slice(0, 200), error);
    }
  }

  db.prepare(`
    UPDATE blast_campaigns
    SET audience = ?, status = 'completed', attempted_count = ?, sent_count = ?, queued_count = ?, failed_count = ?
    WHERE id = ?
  `).run(audience, attempted, sent, queued, failed, campaignId);

  return { campaign_id: campaignId, attempted, sent, queued, failed };
}

async function runManualBlast({ title, subject, body, channels, triggeredBy }) {
  const clean = cleanChannels(channels);
  const message = { subject: subject || title || 'Classic Productions update', body, sms: body, social_dm: body };
  const campaignId = createCampaign({
    title: title || message.subject,
    channels: clean,
    message,
    triggeredBy: triggeredBy || 'admin',
  });
  return deliverBlast({ campaignId, channels: clean, message });
}

async function runEventBlast(eventId, triggeredBy = 'event_created') {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event || event.status !== 'active') {
    return { skipped: true, reason: 'Event is not active.' };
  }

  const message = buildEventCopy(event);
  const channels = cleanChannels(['email', 'sms', 'social_dm']);
  const campaignId = createCampaign({
    title: `New event: ${event.title}`,
    channels,
    message,
    eventId,
    triggeredBy,
  });
  return deliverBlast({ campaignId, channels, message });
}

module.exports = { runManualBlast, runEventBlast };
