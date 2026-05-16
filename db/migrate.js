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
  `);

  // Add promoter_id to bookings (safe — silently ignored if already present)
  for (const sql of [
    'ALTER TABLE bookings     ADD COLUMN promoter_id INTEGER',
    'ALTER TABLE reservations ADD COLUMN promoter_id INTEGER',
  ]) {
    try { db.exec(sql); } catch (e) {
      if (!e.message.includes('duplicate column')) throw e;
    }
  }

  console.log('✓ Migration complete.');
}

migrate();
module.exports = { migrate };
