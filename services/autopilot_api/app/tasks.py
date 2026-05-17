from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from typing import Any

from celery import Celery
from sqlalchemy import text

from .autopilot import should_execute
from .config import get_settings
from .db import AsyncSessionLocal
from .llm import generate_hype_campaign, generate_win_back, parse_concierge_reply
from .providers import send_sms
from .schemas import AutopilotMode


settings = get_settings()
celery_app = Celery("classic_autopilot", broker=settings.redis_url, backend=settings.redis_url)
celery_app.conf.timezone = "America/New_York"
celery_app.conf.beat_schedule = {
    "daily-retention-scan": {
        "task": "app.tasks.retention_scan_daily",
        "schedule": 60 * 60 * 24,
    }
}


async def _mode(session) -> AutopilotMode:
    row = (
        await session.execute(text("SELECT value FROM system_settings WHERE key = 'autopilot_mode'"))
    ).mappings().first()
    value = row["value"] if row else {"enabled": False, "min_confidence": 0.82}
    if isinstance(value, str):
        value = json.loads(value)
    return AutopilotMode(**value)


async def _insert_task(
    session,
    agent_name: str,
    task_type: str,
    status: str,
    payload: dict[str, Any],
    draft_body: str,
    confidence: float,
    reason: str,
    contact_id: str | None = None,
    event_id: str | None = None,
    channel: str | None = None,
) -> str:
    row = (
        await session.execute(
            text(
                """
                INSERT INTO agent_task_queue
                  (agent_name, task_type, status, contact_id, event_id, channel, draft_body, payload, confidence, reason)
                VALUES
                  (:agent_name, :task_type, :status, CAST(:contact_id AS uuid), CAST(:event_id AS uuid),
                   CAST(:channel AS channel_type), :draft_body, CAST(:payload AS jsonb), :confidence, :reason)
                RETURNING id
                """
            ),
            {
                "agent_name": agent_name,
                "task_type": task_type,
                "status": status,
                "contact_id": contact_id,
                "event_id": event_id,
                "channel": channel,
                "draft_body": draft_body,
                "payload": json.dumps(payload),
                "confidence": confidence,
                "reason": reason,
            },
        )
    ).mappings().one()
    await session.commit()
    return str(row["id"])


@celery_app.task(name="app.tasks.retention_scan_daily")
def retention_scan_daily() -> dict:
    return asyncio.run(_retention_scan_daily())


async def _retention_scan_daily() -> dict:
    cutoff = datetime.now(UTC).date() - timedelta(days=30)
    async with AsyncSessionLocal() as session:
        rows = (
            await session.execute(
                text(
                    """
                    SELECT *
                    FROM contacts c
                    WHERE c.sms_opt_in = true
                      AND (c.last_attended_date IS NULL OR c.last_attended_date < :cutoff)
                      AND NOT EXISTS (
                        SELECT 1 FROM outreach_messages om
                        WHERE om.contact_id = c.id
                          AND om.channel = 'sms'
                          AND om.direction = 'outbound'
                          AND om.created_at > now() - interval '7 days'
                      )
                    LIMIT 250
                    """
                ),
                {"cutoff": cutoff},
            )
        ).mappings().all()

    for row in rows:
        retention_contact_one.delay(str(row["id"]))
    return {"queued": len(rows), "cutoff": str(cutoff)}


@celery_app.task(name="app.tasks.retention_contact_one")
def retention_contact_one(contact_id: str) -> dict:
    return asyncio.run(_retention_contact_one(contact_id))


async def _retention_contact_one(contact_id: str) -> dict:
    async with AsyncSessionLocal() as session:
        contact = (
            await session.execute(text("SELECT * FROM contacts WHERE id = CAST(:id AS uuid)"), {"id": contact_id})
        ).mappings().first()
        events = (
            await session.execute(
                text(
                    """
                    SELECT *
                    FROM events
                    WHERE status = 'active' AND starts_at > now()
                    ORDER BY starts_at ASC
                    LIMIT 5
                    """
                )
            )
        ).mappings().all()
        if not contact:
            return {"status": "skipped", "reason": "contact not found"}

        mode = await _mode(session)
        result = await generate_win_back(dict(contact), [dict(e) for e in events])
        status = "sent" if should_execute(mode, result.confidence) else "pending_approval"

        task_id = await _insert_task(
            session=session,
            agent_name="30-day-retention-agent",
            task_type="win_back_sms",
            status=status,
            contact_id=contact_id,
            event_id=str(events[0]["id"]) if events else None,
            channel="sms",
            payload={"contact": dict(contact), "events": [dict(e) for e in events]},
            draft_body=result.body["message"],
            confidence=result.confidence,
            reason=result.reason,
        )

        if status == "sent":
            provider = await send_sms(contact["phone_e164"], result.body["message"])
            await session.execute(
                text(
                    """
                    INSERT INTO outreach_messages (contact_id, event_id, channel, direction, body, provider_message_id, status, metadata)
                    VALUES (CAST(:contact_id AS uuid), CAST(:event_id AS uuid), 'sms', 'outbound', :body, :provider_id, 'sent', CAST(:metadata AS jsonb))
                    """
                ),
                {
                    "contact_id": contact_id,
                    "event_id": str(events[0]["id"]) if events else None,
                    "body": result.body["message"],
                    "provider_id": provider["message_id"],
                    "metadata": json.dumps({"agent_task_id": task_id}),
                },
            )
            await session.commit()
        return {"task_id": task_id, "status": status}


@celery_app.task(name="app.tasks.hype_generate_campaign")
def hype_generate_campaign(raw_copy: str, asset_url: str | None = None, event_id: str | None = None) -> dict:
    return asyncio.run(_hype_generate_campaign(raw_copy, asset_url, event_id))


async def _hype_generate_campaign(raw_copy: str, asset_url: str | None, event_id: str | None) -> dict:
    async with AsyncSessionLocal() as session:
        mode = await _mode(session)
        result = await generate_hype_campaign(raw_copy, asset_url)
        status = "queued" if should_execute(mode, result.confidence) else "pending_approval"
        task_id = await _insert_task(
            session=session,
            agent_name="hype-distribution-agent",
            task_type="campaign_generation",
            status=status,
            event_id=event_id,
            payload={"raw_copy": raw_copy, "asset_url": asset_url, "llm": result.body},
            draft_body=json.dumps(result.body),
            confidence=result.confidence,
            reason=result.reason,
        )
        return {"task_id": task_id, "status": status}


@celery_app.task(name="app.tasks.concierge_handle_inbound_sms")
def concierge_handle_inbound_sms(from_phone: str, to_phone: str, body: str, message_sid: str | None = None) -> dict:
    return asyncio.run(_concierge_handle_inbound_sms(from_phone, to_phone, body, message_sid))


async def _concierge_handle_inbound_sms(from_phone: str, to_phone: str, body: str, message_sid: str | None) -> dict:
    async with AsyncSessionLocal() as session:
        contact = (
            await session.execute(text("SELECT * FROM contacts WHERE phone_e164 = :phone"), {"phone": from_phone})
        ).mappings().first()
        availability = (
            await session.execute(
                text(
                    """
                    SELECT vt.*
                    FROM venue_tables vt
                    JOIN events e ON e.id = vt.event_id
                    WHERE vt.active = true
                      AND e.starts_at > now()
                      AND NOT EXISTS (
                        SELECT 1 FROM bookings b
                        WHERE b.venue_table_id = vt.id
                          AND b.status IN ('hold','pending_payment','paid','confirmed')
                      )
                    ORDER BY e.starts_at ASC, vt.price_cents DESC
                    LIMIT 3
                    """
                )
            )
        ).mappings().all()

        result = await parse_concierge_reply(body, [dict(row) for row in availability])
        mode = await _mode(session)
        status = "sent" if should_execute(mode, result.confidence) else "pending_approval"
        task_id = await _insert_task(
            session=session,
            agent_name="virtual-concierge-agent",
            task_type="inbound_sms_reply",
            status=status,
            contact_id=str(contact["id"]) if contact else None,
            channel="sms",
            payload={"from": from_phone, "to": to_phone, "body": body, "message_sid": message_sid},
            draft_body=result.body["reply"],
            confidence=result.confidence,
            reason=result.reason,
        )

        if status == "sent":
            provider = await send_sms(from_phone, result.body["reply"])
            await session.execute(
                text(
                    """
                    INSERT INTO outreach_messages (contact_id, channel, direction, body, provider_message_id, status, metadata)
                    VALUES (CAST(:contact_id AS uuid), 'sms', 'outbound', :body, :provider_id, 'sent', CAST(:metadata AS jsonb))
                    """
                ),
                {
                    "contact_id": str(contact["id"]) if contact else None,
                    "body": result.body["reply"],
                    "provider_id": provider["message_id"],
                    "metadata": json.dumps({"agent_task_id": task_id}),
                },
            )
            await session.commit()
        return {"task_id": task_id, "status": status}
