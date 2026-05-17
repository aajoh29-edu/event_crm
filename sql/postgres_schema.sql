CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE channel_type AS ENUM ('sms', 'email', 'social_dm', 'voice');
CREATE TYPE task_status AS ENUM ('pending_approval', 'approved', 'queued', 'running', 'sent', 'rejected', 'failed');
CREATE TYPE booking_status AS ENUM ('hold', 'pending_payment', 'paid', 'confirmed', 'cancelled', 'refunded', 'expired');
CREATE TYPE spend_tier AS ENUM ('general', 'premium', 'vip', 'whale');

CREATE TABLE system_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO system_settings (key, value)
VALUES ('autopilot_mode', '{"enabled": false, "min_confidence": 0.82}'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name TEXT NOT NULL,
  last_name TEXT,
  email CITEXT,
  phone_e164 TEXT,
  social_handles JSONB NOT NULL DEFAULT '{}'::jsonb,
  preferred_genres TEXT[] NOT NULL DEFAULT '{}',
  preferred_subgenres TEXT[] NOT NULL DEFAULT '{}',
  preferred_venue_types TEXT[] NOT NULL DEFAULT '{}',
  preferred_drinks TEXT[] NOT NULL DEFAULT '{}',
  spend_tier spend_tier NOT NULL DEFAULT 'general',
  average_spend_cents INTEGER NOT NULL DEFAULT 0,
  lifetime_spend_cents INTEGER NOT NULL DEFAULT 0,
  last_attended_date DATE,
  sms_opt_in BOOLEAN NOT NULL DEFAULT true,
  email_opt_in BOOLEAN NOT NULL DEFAULT true,
  social_opt_in BOOLEAN NOT NULL DEFAULT true,
  tags TEXT[] NOT NULL DEFAULT '{}',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (email),
  UNIQUE (phone_e164)
);

CREATE INDEX idx_contacts_last_attended ON contacts (last_attended_date) WHERE sms_opt_in = true;
CREATE INDEX idx_contacts_spend_tier ON contacts (spend_tier);
CREATE INDEX idx_contacts_genres_gin ON contacts USING gin (preferred_genres);
CREATE INDEX idx_contacts_subgenres_gin ON contacts USING gin (preferred_subgenres);
CREATE INDEX idx_contacts_tags_gin ON contacts USING gin (tags);

CREATE TABLE promoters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email CITEXT UNIQUE,
  phone_e164 TEXT,
  qr_token TEXT NOT NULL UNIQUE,
  commission_bps INTEGER NOT NULL DEFAULT 1000,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  venue_name TEXT,
  venue_type TEXT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  genre_tags TEXT[] NOT NULL DEFAULT '{}',
  subgenre_tags TEXT[] NOT NULL DEFAULT '{}',
  vibe_tags TEXT[] NOT NULL DEFAULT '{}',
  ticket_base_price_cents INTEGER NOT NULL DEFAULT 0,
  vip_table_base_price_cents INTEGER NOT NULL DEFAULT 0,
  capacity INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  asset_url TEXT,
  booking_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_events_starts_at ON events (starts_at);
CREATE INDEX idx_events_status_starts_at ON events (status, starts_at);
CREATE INDEX idx_events_genres_gin ON events USING gin (genre_tags);
CREATE INDEX idx_events_subgenres_gin ON events USING gin (subgenre_tags);
CREATE INDEX idx_events_vibe_tags_gin ON events USING gin (vibe_tags);

CREATE TABLE venue_tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  table_type TEXT NOT NULL,
  min_party_size INTEGER NOT NULL DEFAULT 1,
  max_party_size INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (event_id, label)
);

CREATE INDEX idx_venue_tables_event_type ON venue_tables (event_id, table_type);

CREATE TABLE bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id),
  event_id UUID NOT NULL REFERENCES events(id),
  promoter_id UUID REFERENCES promoters(id),
  venue_table_id UUID REFERENCES venue_tables(id),
  quantity INTEGER NOT NULL DEFAULT 1,
  party_size INTEGER,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  status booking_status NOT NULL DEFAULT 'hold',
  payment_provider TEXT,
  payment_link_url TEXT,
  payment_intent_id TEXT,
  hold_expires_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bookings_contact_created ON bookings (contact_id, created_at DESC);
CREATE INDEX idx_bookings_event_status ON bookings (event_id, status);
CREATE INDEX idx_bookings_promoter_event ON bookings (promoter_id, event_id);
CREATE INDEX idx_bookings_hold_expiry ON bookings (hold_expires_at) WHERE status = 'hold';

CREATE TABLE outreach_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id),
  event_id UUID REFERENCES events(id),
  booking_id UUID REFERENCES bookings(id),
  channel channel_type NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  body TEXT NOT NULL,
  provider_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_outreach_contact_channel_created ON outreach_messages (contact_id, channel, created_at DESC);
CREATE INDEX idx_outreach_event_created ON outreach_messages (event_id, created_at DESC);

CREATE TABLE agent_task_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name TEXT NOT NULL,
  task_type TEXT NOT NULL,
  status task_status NOT NULL DEFAULT 'pending_approval',
  contact_id UUID REFERENCES contacts(id),
  event_id UUID REFERENCES events(id),
  booking_id UUID REFERENCES bookings(id),
  channel channel_type,
  draft_subject TEXT,
  draft_body TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence NUMERIC(5,4) NOT NULL DEFAULT 0,
  reason TEXT,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  scheduled_for TIMESTAMPTZ,
  locked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_tasks_status_created ON agent_task_queue (status, created_at);
CREATE INDEX idx_agent_tasks_agent_status ON agent_task_queue (agent_name, status);
CREATE INDEX idx_agent_tasks_contact_created ON agent_task_queue (contact_id, created_at DESC);
CREATE INDEX idx_agent_tasks_payload_gin ON agent_task_queue USING gin (payload);

CREATE TABLE conversation_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id),
  phone_e164 TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'new',
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_inbound_at TIMESTAMPTZ,
  last_outbound_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (phone_e164)
);

CREATE INDEX idx_threads_contact ON conversation_threads (contact_id);
CREATE INDEX idx_threads_state ON conversation_threads (state);

CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_entity ON audit_log (entity_type, entity_id, created_at DESC);
