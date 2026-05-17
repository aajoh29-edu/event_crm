const db = require('./connection');

function migrate() {
  // ── Promoters ────────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS promoters (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT    NOT NULL,
      email            TEXT    UNIQUE NOT NULL,
      phone            TEXT,
      instagram_handle TEXT,
      twitter_handle   TEXT,
      qr_token         TEXT    UNIQUE NOT NULL,
      commission_rate  REAL    DEFAULT 10.0,
      active           INTEGER DEFAULT 1,
      notes            TEXT,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Ties a customer to the promoter who referred them
    CREATE TABLE IF NOT EXISTS promoter_clients (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      promoter_id  INTEGER NOT NULL,
      customer_id  INTEGER NOT NULL,
      referred_via TEXT    DEFAULT 'qr_code',
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (promoter_id) REFERENCES promoters(id),
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      UNIQUE(promoter_id, customer_id)
    );

    -- AI agent outreach log
    CREATE TABLE IF NOT EXISTS agent_outreach (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id      INTEGER NOT NULL,
      channel          TEXT    NOT NULL,  -- email | sms | social_dm
      status           TEXT    DEFAULT 'sent',  -- sent | failed | queued
      message_preview  TEXT,
      error_message    TEXT,
      sent_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    -- One row per agent execution
    CREATE TABLE IF NOT EXISTS agent_runs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      triggered_by     TEXT    DEFAULT 'cron',
      customers_found  INTEGER DEFAULT 0,
      outreach_sent    INTEGER DEFAULT 0,
      status           TEXT    DEFAULT 'completed',
      notes            TEXT,
      run_at           DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS preference_game_submissions (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id          INTEGER,
      promoter_id          INTEGER,
      full_name            TEXT,
      email                TEXT,
      phone                TEXT,
      social_handles       TEXT,
      preferred_drinks     TEXT,
      preferred_party_types TEXT,
      preferred_music      TEXT,
      preferred_venue_types TEXT,
      created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (promoter_id) REFERENCES promoters(id)
    );

    CREATE TABLE IF NOT EXISTS blast_campaigns (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      title           TEXT NOT NULL,
      audience        TEXT DEFAULT 'all',
      channels        TEXT NOT NULL,
      message_subject TEXT,
      message_body    TEXT NOT NULL,
      event_id        INTEGER,
      triggered_by    TEXT DEFAULT 'admin',
      status          TEXT DEFAULT 'queued',
      attempted_count INTEGER DEFAULT 0,
      sent_count      INTEGER DEFAULT 0,
      queued_count    INTEGER DEFAULT 0,
      failed_count    INTEGER DEFAULT 0,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (event_id) REFERENCES events(id)
    );

    CREATE TABLE IF NOT EXISTS blast_messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id     INTEGER NOT NULL,
      customer_id     INTEGER,
      channel         TEXT NOT NULL,
      status          TEXT DEFAULT 'queued',
      destination     TEXT,
      message_preview TEXT,
      error_message   TEXT,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (campaign_id) REFERENCES blast_campaigns(id),
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );
  `);

  // Add promoter_id to bookings (safe — silently ignored if already present)
  for (const sql of [
    'ALTER TABLE bookings     ADD COLUMN promoter_id INTEGER',
    'ALTER TABLE reservations ADD COLUMN promoter_id INTEGER',
    'ALTER TABLE customers ADD COLUMN social_handles TEXT',
    'ALTER TABLE customers ADD COLUMN preferred_event_types TEXT',
    'ALTER TABLE customers ADD COLUMN preferred_drinks TEXT',
    'ALTER TABLE customers ADD COLUMN preferred_party_types TEXT',
    'ALTER TABLE customers ADD COLUMN preferred_music TEXT',
    'ALTER TABLE customers ADD COLUMN preferred_venue_types TEXT',
    'ALTER TABLE customers ADD COLUMN email_opt_in INTEGER DEFAULT 1',
    'ALTER TABLE customers ADD COLUMN sms_opt_in INTEGER DEFAULT 1',
    'ALTER TABLE customers ADD COLUMN social_opt_in INTEGER DEFAULT 1',
    'ALTER TABLE contact_messages ADD COLUMN phone TEXT',
    'ALTER TABLE contact_messages ADD COLUMN social_handles TEXT',
  ]) {
    try { db.exec(sql); } catch (e) {
      if (!e.message.includes('duplicate column')) throw e;
    }
  }

  console.log('✓ Migration complete.');
}

migrate();
module.exports = { migrate };
