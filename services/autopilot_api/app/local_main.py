from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

from fastapi import FastAPI, Form, HTTPException
from pydantic import BaseModel, Field

from .local_store import connect, get_autopilot, init_db, insert_task, row_to_dict, set_autopilot
from .llm import generate_hype_campaign, generate_win_back, parse_concierge_reply


app = FastAPI(
    title="Classic Productions Local Autopilot API",
    version="0.1.0-local",
    description="No-Docker local development API using SQLite and inline agent execution.",
)


class AutopilotMode(BaseModel):
    enabled: bool = False
    min_confidence: float = Field(default=0.82, ge=0, le=1)


class EventDraftRequest(BaseModel):
    raw_copy: str = Field(min_length=3, max_length=5000)
    asset_url: str | None = None
    event_id: str | None = None


class ApprovalRequest(BaseModel):
    approved_by: str


@app.on_event("startup")
def startup() -> None:
    init_db()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "mode": "local-sqlite"}


@app.get("/autopilot")
def read_autopilot() -> dict[str, Any]:
    return get_autopilot()


@app.put("/autopilot")
def update_autopilot(mode: AutopilotMode) -> dict[str, Any]:
    return set_autopilot(mode.model_dump())


@app.get("/local/demo-data")
def demo_data() -> dict[str, Any]:
    with connect() as conn:
        contacts = [row_to_dict(row) for row in conn.execute("SELECT * FROM contacts ORDER BY created_at DESC").fetchall()]
        events = [row_to_dict(row) for row in conn.execute("SELECT * FROM events ORDER BY starts_at ASC").fetchall()]
        tables = [row_to_dict(row) for row in conn.execute("SELECT * FROM venue_tables ORDER BY label ASC").fetchall()]
    return {"contacts": contacts, "events": events, "venue_tables": tables}


@app.post("/agents/retention/run")
async def run_retention_scan() -> dict[str, Any]:
    mode = get_autopilot()
    cutoff = (datetime.now(UTC).date() - timedelta(days=30)).isoformat()
    tasks = []
    with connect() as conn:
        contacts = [
            row_to_dict(row)
            for row in conn.execute(
                """
                SELECT *
                FROM contacts
                WHERE sms_opt_in = 1
                  AND (last_attended_date IS NULL OR last_attended_date < ?)
                LIMIT 100
                """,
                (cutoff,),
            ).fetchall()
        ]
        events = [
            row_to_dict(row)
            for row in conn.execute(
                """
                SELECT *
                FROM events
                WHERE status = 'active' AND starts_at > ?
                ORDER BY starts_at ASC
                LIMIT 5
                """,
                (datetime.now(UTC).isoformat(),),
            ).fetchall()
        ]

    for contact in contacts:
        contact["preferred_genres"] = json.loads(contact.get("preferred_genres") or "[]")
        result = await generate_win_back(contact, events)
        status = "sent" if mode["enabled"] and result.confidence >= mode["min_confidence"] else "pending_approval"
        task = insert_task(
            agent_name="30-day-retention-agent",
            task_type="win_back_sms",
            status=status,
            contact_id=contact["id"],
            event_id=events[0]["id"] if events else None,
            channel="sms",
            payload={"contact": contact, "events": events},
            draft_body=result.body["message"],
            confidence=result.confidence,
            reason=result.reason,
        )
        tasks.append(task)
    return {"processed": len(tasks), "tasks": tasks}


@app.post("/agents/hype/campaign")
async def create_hype_campaign(request: EventDraftRequest) -> dict[str, Any]:
    mode = get_autopilot()
    result = await generate_hype_campaign(request.raw_copy, request.asset_url)
    status = "queued" if mode["enabled"] and result.confidence >= mode["min_confidence"] else "pending_approval"
    task = insert_task(
        agent_name="hype-distribution-agent",
        task_type="campaign_generation",
        status=status,
        event_id=request.event_id,
        payload={"raw_copy": request.raw_copy, "asset_url": request.asset_url, "llm": result.body},
        draft_subject=result.body["email_variants"][0]["subject"],
        draft_body=json.dumps(result.body, indent=2),
        confidence=result.confidence,
        reason=result.reason,
    )
    return {"task": task}


@app.post("/webhooks/twilio/inbound-sms")
async def inbound_sms(
    From: Annotated[str, Form()],
    To: Annotated[str, Form()],
    Body: Annotated[str, Form()],
    MessageSid: Annotated[str | None, Form()] = None,
) -> dict[str, Any]:
    mode = get_autopilot()
    with connect() as conn:
        contact = conn.execute("SELECT * FROM contacts WHERE phone_e164 = ?", (From,)).fetchone()
        availability = [
            row_to_dict(row)
            for row in conn.execute(
                """
                SELECT vt.*
                FROM venue_tables vt
                JOIN events e ON e.id = vt.event_id
                WHERE vt.active = 1
                  AND e.starts_at > ?
                  AND NOT EXISTS (
                    SELECT 1 FROM bookings b
                    WHERE b.venue_table_id = vt.id
                      AND b.status IN ('hold', 'pending_payment', 'paid', 'confirmed')
                  )
                ORDER BY e.starts_at ASC, vt.price_cents DESC
                LIMIT 3
                """,
                (datetime.now(UTC).isoformat(),),
            ).fetchall()
        ]

    result = await parse_concierge_reply(Body, availability)
    status = "sent" if mode["enabled"] and result.confidence >= mode["min_confidence"] else "pending_approval"
    task = insert_task(
        agent_name="virtual-concierge-agent",
        task_type="inbound_sms_reply",
        status=status,
        contact_id=contact["id"] if contact else None,
        channel="sms",
        payload={"from": From, "to": To, "body": Body, "message_sid": MessageSid, "availability": availability},
        draft_body=result.body["reply"],
        confidence=result.confidence,
        reason=result.reason,
    )
    return {"task": task}


@app.get("/hitl/tasks")
def list_hitl_tasks(status: str = "pending_approval") -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT *
            FROM agent_task_queue
            WHERE status = ?
            ORDER BY created_at DESC
            LIMIT 200
            """,
            (status,),
        ).fetchall()
        return [row_to_dict(row) for row in rows]


@app.post("/hitl/tasks/{task_id}/approve")
def approve_task(task_id: str, request: ApprovalRequest) -> dict[str, Any]:
    timestamp = datetime.now(UTC).replace(microsecond=0).isoformat()
    with connect() as conn:
        row = conn.execute(
            """
            UPDATE agent_task_queue
            SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ?
            WHERE id = ? AND status = 'pending_approval'
            RETURNING *
            """,
            (request.approved_by, timestamp, timestamp, task_id),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Pending task not found")
    return row_to_dict(row)


@app.post("/hitl/tasks/{task_id}/reject")
def reject_task(task_id: str) -> dict[str, Any]:
    timestamp = datetime.now(UTC).replace(microsecond=0).isoformat()
    with connect() as conn:
        row = conn.execute(
            """
            UPDATE agent_task_queue
            SET status = 'rejected', updated_at = ?
            WHERE id = ? AND status = 'pending_approval'
            RETURNING *
            """,
            (timestamp, task_id),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Pending task not found")
    return row_to_dict(row)


@app.post("/local/bookings/mock-payment-link")
def create_mock_payment_link(contact_id: str, event_id: str, venue_table_id: str, party_size: int = 2) -> dict[str, Any]:
    booking_id = str(uuid.uuid4())
    with connect() as conn:
        table = conn.execute("SELECT * FROM venue_tables WHERE id = ?", (venue_table_id,)).fetchone()
        if not table:
            raise HTTPException(status_code=404, detail="Table not found")
        payment_link = f"http://localhost:8080/local/pay/{booking_id}"
        conn.execute(
            """
            INSERT INTO bookings
              (id, contact_id, event_id, venue_table_id, party_size, amount_cents, status,
               payment_link_url, hold_expires_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'pending_payment', ?, ?, ?)
            """,
            (
                booking_id,
                contact_id,
                event_id,
                venue_table_id,
                party_size,
                table["price_cents"],
                payment_link,
                (datetime.now(UTC) + timedelta(minutes=15)).replace(microsecond=0).isoformat(),
                datetime.now(UTC).replace(microsecond=0).isoformat(),
            ),
        )
    return {"booking_id": booking_id, "payment_link_url": payment_link}
