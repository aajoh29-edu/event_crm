from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "local_autopilot.db"


def now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    with connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS system_settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS contacts (
              id TEXT PRIMARY KEY,
              first_name TEXT NOT NULL,
              last_name TEXT,
              email TEXT UNIQUE,
              phone_e164 TEXT UNIQUE,
              preferred_genres TEXT NOT NULL DEFAULT '[]',
              preferred_venue_types TEXT NOT NULL DEFAULT '[]',
              spend_tier TEXT NOT NULL DEFAULT 'general',
              average_spend_cents INTEGER NOT NULL DEFAULT 0,
              lifetime_spend_cents INTEGER NOT NULL DEFAULT 0,
              last_attended_date TEXT,
              sms_opt_in INTEGER NOT NULL DEFAULT 1,
              email_opt_in INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS events (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              venue_name TEXT,
              venue_type TEXT,
              starts_at TEXT NOT NULL,
              genre_tags TEXT NOT NULL DEFAULT '[]',
              ticket_base_price_cents INTEGER NOT NULL DEFAULT 0,
              vip_table_base_price_cents INTEGER NOT NULL DEFAULT 0,
              status TEXT NOT NULL DEFAULT 'active',
              booking_url TEXT,
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS venue_tables (
              id TEXT PRIMARY KEY,
              event_id TEXT NOT NULL,
              label TEXT NOT NULL,
              table_type TEXT NOT NULL,
              max_party_size INTEGER NOT NULL,
              price_cents INTEGER NOT NULL,
              active INTEGER NOT NULL DEFAULT 1,
              FOREIGN KEY (event_id) REFERENCES events(id)
            );

            CREATE TABLE IF NOT EXISTS bookings (
              id TEXT PRIMARY KEY,
              contact_id TEXT,
              event_id TEXT NOT NULL,
              venue_table_id TEXT,
              party_size INTEGER,
              amount_cents INTEGER NOT NULL DEFAULT 0,
              status TEXT NOT NULL DEFAULT 'hold',
              payment_link_url TEXT,
              hold_expires_at TEXT,
              created_at TEXT NOT NULL,
              FOREIGN KEY (contact_id) REFERENCES contacts(id),
              FOREIGN KEY (event_id) REFERENCES events(id),
              FOREIGN KEY (venue_table_id) REFERENCES venue_tables(id)
            );

            CREATE TABLE IF NOT EXISTS outreach_messages (
              id TEXT PRIMARY KEY,
              contact_id TEXT,
              event_id TEXT,
              channel TEXT NOT NULL,
              direction TEXT NOT NULL,
              body TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'queued',
              metadata TEXT NOT NULL DEFAULT '{}',
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS agent_task_queue (
              id TEXT PRIMARY KEY,
              agent_name TEXT NOT NULL,
              task_type TEXT NOT NULL,
              status TEXT NOT NULL,
              contact_id TEXT,
              event_id TEXT,
              booking_id TEXT,
              channel TEXT,
              draft_subject TEXT,
              draft_body TEXT,
              payload TEXT NOT NULL DEFAULT '{}',
              result TEXT NOT NULL DEFAULT '{}',
              confidence REAL NOT NULL DEFAULT 0,
              reason TEXT,
              approved_by TEXT,
              approved_at TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            """
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO system_settings (key, value, updated_at)
            VALUES ('autopilot_mode', ?, ?)
            """,
            (json.dumps({"enabled": False, "min_confidence": 0.82}), now_iso()),
        )
        seed_demo_data(conn)


def seed_demo_data(conn: sqlite3.Connection) -> None:
    count = conn.execute("SELECT COUNT(*) AS c FROM contacts").fetchone()["c"]
    if count:
        return
    contact_id = str(uuid.uuid4())
    event_id = str(uuid.uuid4())
    table_id = str(uuid.uuid4())
    conn.execute(
        """
        INSERT INTO contacts
          (id, first_name, last_name, email, phone_e164, preferred_genres, preferred_venue_types,
           spend_tier, average_spend_cents, lifetime_spend_cents, last_attended_date,
           sms_opt_in, email_opt_in, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
        """,
        (
            contact_id,
            "Aaliyah",
            "Williams",
            "aaliyah@example.com",
            "+15550102",
            json.dumps(["90s R&B", "Afro Beats"]),
            json.dumps(["waterfront", "rooftop"]),
            "vip",
            22000,
            87500,
            (datetime.now(UTC).date() - timedelta(days=45)).isoformat(),
            now_iso(),
            now_iso(),
        ),
    )
    conn.execute(
        """
        INSERT INTO events
          (id, title, venue_name, venue_type, starts_at, genre_tags,
           ticket_base_price_cents, vip_table_base_price_cents, status, booking_url, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
        """,
        (
            event_id,
            "R&B On the Water",
            "The Wharf",
            "waterfront",
            (datetime.now(UTC) + timedelta(days=21)).replace(microsecond=0).isoformat(),
            json.dumps(["R&B", "waterfront"]),
            6500,
            65000,
            "http://localhost:3000/book",
            now_iso(),
        ),
    )
    conn.execute(
        """
        INSERT INTO venue_tables
          (id, event_id, label, table_type, max_party_size, price_cents, active)
        VALUES (?, ?, 'VIP Table A', 'vip', 8, 65000, 1)
        """,
        (table_id, event_id),
    )


def get_autopilot() -> dict[str, Any]:
    with connect() as conn:
        row = conn.execute("SELECT value FROM system_settings WHERE key = 'autopilot_mode'").fetchone()
        return json.loads(row["value"]) if row else {"enabled": False, "min_confidence": 0.82}


def set_autopilot(value: dict[str, Any]) -> dict[str, Any]:
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO system_settings (key, value, updated_at)
            VALUES ('autopilot_mode', ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            """,
            (json.dumps(value), now_iso()),
        )
    return value


def row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    for key in ("payload", "result", "metadata"):
        if key in data and isinstance(data[key], str):
            data[key] = json.loads(data[key] or "{}")
    return data


def insert_task(
    agent_name: str,
    task_type: str,
    status: str,
    payload: dict[str, Any],
    draft_body: str,
    confidence: float,
    reason: str,
    contact_id: str | None = None,
    event_id: str | None = None,
    booking_id: str | None = None,
    channel: str | None = None,
    draft_subject: str | None = None,
) -> dict[str, Any]:
    task_id = str(uuid.uuid4())
    timestamp = now_iso()
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO agent_task_queue
              (id, agent_name, task_type, status, contact_id, event_id, booking_id, channel,
               draft_subject, draft_body, payload, result, confidence, reason, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)
            """,
            (
                task_id,
                agent_name,
                task_type,
                status,
                contact_id,
                event_id,
                booking_id,
                channel,
                draft_subject,
                draft_body,
                json.dumps(payload),
                confidence,
                reason,
                timestamp,
                timestamp,
            ),
        )
        row = conn.execute("SELECT * FROM agent_task_queue WHERE id = ?", (task_id,)).fetchone()
        return row_to_dict(row)
