const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = new Database(path.join(__dirname, 'classic.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

console.log('Creating tables...');

db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    phone TEXT,
    social_handles TEXT,
    preferred_event_types TEXT,
    preferred_drinks TEXT,
    preferred_party_types TEXT,
    preferred_music TEXT,
    preferred_venue_types TEXT,
    email_opt_in INTEGER DEFAULT 1,
    sms_opt_in INTEGER DEFAULT 1,
    social_opt_in INTEGER DEFAULT 1,
    vip_status INTEGER DEFAULT 0,
    notes TEXT,
    total_spent REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    genre TEXT,
    description TEXT,
    event_date DATE NOT NULL,
    event_time TEXT,
    venue TEXT,
    image_url TEXT,
    ticket_price REAL DEFAULT 0,
    capacity INTEGER DEFAULT 100,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER,
    event_id INTEGER,
    quantity INTEGER DEFAULT 1,
    total_price REAL DEFAULT 0,
    status TEXT DEFAULT 'confirmed',
    booking_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(id),
    FOREIGN KEY (event_id) REFERENCES events(id)
  );

  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    party_size INTEGER DEFAULT 2,
    reservation_date DATE NOT NULL,
    reservation_time TEXT,
    table_type TEXT DEFAULT 'standard',
    special_requests TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(id)
  );

  CREATE TABLE IF NOT EXISTS contact_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    subject TEXT,
    message TEXT NOT NULL,
    status TEXT DEFAULT 'unread',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS newsletter_subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    subscribed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS preference_game_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER,
    promoter_id INTEGER,
    full_name TEXT,
    email TEXT,
    phone TEXT,
    social_handles TEXT,
    preferred_drinks TEXT,
    preferred_party_types TEXT,
    preferred_music TEXT,
    preferred_venue_types TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(id),
    FOREIGN KEY (promoter_id) REFERENCES promoters(id)
  );

  CREATE TABLE IF NOT EXISTS blast_campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    audience TEXT DEFAULT 'all',
    channels TEXT NOT NULL,
    message_subject TEXT,
    message_body TEXT NOT NULL,
    event_id INTEGER,
    triggered_by TEXT DEFAULT 'admin',
    status TEXT DEFAULT 'queued',
    attempted_count INTEGER DEFAULT 0,
    sent_count INTEGER DEFAULT 0,
    queued_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES events(id)
  );

  CREATE TABLE IF NOT EXISTS blast_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    customer_id INTEGER,
    channel TEXT NOT NULL,
    status TEXT DEFAULT 'queued',
    destination TEXT,
    message_preview TEXT,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (campaign_id) REFERENCES blast_campaigns(id),
    FOREIGN KEY (customer_id) REFERENCES customers(id)
  );
`);

console.log('Tables created.');

// Seed admin user
const adminUsername = process.env.ADMIN_USERNAME || 'admin';
const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
const existingAdmin = db.prepare('SELECT id FROM admins WHERE username = ?').get(adminUsername);

if (!existingAdmin) {
  const hash = bcrypt.hashSync(adminPassword, 10);
  db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(adminUsername, hash);
  console.log(`Admin created: ${adminUsername}`);
} else {
  console.log('Admin already exists.');
}

// Seed events — D.C. & Baltimore nightlife lineup
const eventCount = db.prepare('SELECT COUNT(*) as c FROM events').get().c;
if (eventCount === 0) {
  const insertEvent = db.prepare(`
    INSERT INTO events (title, genre, description, event_date, event_time, venue, image_url, ticket_price, capacity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // R&B On the Water — harbor/waterfront at night, city lights on water
  insertEvent.run(
    'R&B On the Water',
    'R&B',
    'Sip, vibe, and feel the waterfront breeze as the DMV\'s finest R&B DJs set the mood at The Wharf. Semi-formal attire.',
    '2026-06-21', '19:00', 'The Wharf, Washington D.C.',
    '/rnb-on-the-water-card.svg',
    65.00, 200
  );

  // Industry Night / Classic Productions — lounge scene
  insertEvent.run(
    'Industry Night / Classic Productions',
    'R&B / Hip-Hop',
    'An exclusive industry mixer where music, fashion, and culture collide. Baltimore\'s most connected night. VIP tables available.',
    '2026-07-11', '21:00', 'Pendry Baltimore, Harbor East',
    '/industry-night-card.svg',
    100.00, 150
  );

  // Afro-Beats Happy Hour — diverse women dancing outdoors under string lights
  insertEvent.run(
    'Afro-Beats Happy Hour',
    'Afro-Beats',
    'Afro-Beats, good vibes, and the best after-work reset in the DMV. D.C. and Baltimore unite on the dance floor.',
    '2026-07-25', '17:00', 'Yards Park, Capitol Riverfront, D.C.',
    '/afro-beats-card.svg',
    35.00, 300
  );

  // Rooftop Day Party — diverse mixed group toasting on rooftop with city skyline
  insertEvent.run(
    'Rooftop Day Party',
    'Hip-Hop / R&B',
    'Hit the rooftop as the sun sets over the District. Day drinking, live DJ sets, and panoramic D.C. skyline views.',
    '2026-08-02', '15:00', '14th & U Street NW, Washington D.C.',
    '/rooftop-day-party-card.svg',
    55.00, 250
  );

  console.log('Seeded 4 events.');
}

// Seed sample customers for demo
const custCount = db.prepare('SELECT COUNT(*) as c FROM customers').get().c;
if (custCount === 0) {
  const ins = db.prepare(`INSERT INTO customers (first_name, last_name, email, phone, vip_status, total_spent) VALUES (?, ?, ?, ?, ?, ?)`);
  ins.run('Marcus', 'Johnson', 'marcus.j@example.com', '555-0101', 1, 450.00);
  ins.run('Aaliyah', 'Williams', 'aaliyah.w@example.com', '555-0102', 1, 875.00);
  ins.run('David', 'Chen', 'david.c@example.com', '555-0103', 0, 150.00);
  ins.run('Sofia', 'Martinez', 'sofia.m@example.com', '555-0104', 0, 95.00);
  console.log('Seeded 4 sample customers.');
}

console.log('\n✓ Database initialized at db/classic.db');
db.close();
