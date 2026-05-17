from __future__ import annotations

from typing import Annotated

from fastapi import Depends, FastAPI, Form, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .autopilot import get_autopilot_mode, set_autopilot_mode
from .db import get_session
from .schemas import AgentTaskOut, ApprovalRequest, AutopilotMode, EventDraftRequest
from .tasks import concierge_handle_inbound_sms, hype_generate_campaign, retention_scan_daily


app = FastAPI(
    title="Classic Productions Autopilot API",
    version="0.1.0",
    description="Agentic CRM and marketing automation API for Classic Productions.",
)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.get("/autopilot", response_model=AutopilotMode)
async def read_autopilot(session: AsyncSession = Depends(get_session)) -> AutopilotMode:
    return await get_autopilot_mode(session)


@app.put("/autopilot", response_model=AutopilotMode)
async def update_autopilot(mode: AutopilotMode, session: AsyncSession = Depends(get_session)) -> AutopilotMode:
    return await set_autopilot_mode(session, mode)


@app.post("/agents/retention/run")
async def run_retention_scan() -> dict:
    task = retention_scan_daily.delay()
    return {"queued": True, "celery_task_id": task.id}


@app.post("/agents/hype/campaign")
async def create_hype_campaign(request: EventDraftRequest) -> dict:
    task = hype_generate_campaign.delay(request.raw_copy, request.asset_url, request.event_id)
    return {"queued": True, "celery_task_id": task.id}


@app.post("/webhooks/twilio/inbound-sms")
async def inbound_sms(
    From: Annotated[str, Form()],
    To: Annotated[str, Form()],
    Body: Annotated[str, Form()],
    MessageSid: Annotated[str | None, Form()] = None,
) -> dict:
    task = concierge_handle_inbound_sms.delay(From, To, Body, MessageSid)
    return {"queued": True, "celery_task_id": task.id}


@app.get("/hitl/tasks", response_model=list[AgentTaskOut])
async def list_hitl_tasks(
    status: str = "pending_approval",
    session: AsyncSession = Depends(get_session),
) -> list[AgentTaskOut]:
    rows = (
        await session.execute(
            text(
                """
                SELECT
                  id::text AS id, agent_name, task_type, status::text AS status,
                  channel::text AS channel, draft_subject, draft_body,
                  confidence::float AS confidence, reason, payload, created_at
                FROM agent_task_queue
                WHERE status = CAST(:status AS task_status)
                ORDER BY created_at DESC
                LIMIT 200
                """
            ),
            {"status": status},
        )
    ).mappings().all()
    return [AgentTaskOut(**dict(row)) for row in rows]


@app.post("/hitl/tasks/{task_id}/approve")
async def approve_task(
    task_id: str,
    request: ApprovalRequest,
    session: AsyncSession = Depends(get_session),
) -> dict:
    result = await session.execute(
        text(
            """
            UPDATE agent_task_queue
            SET status = 'approved', approved_by = :approved_by, approved_at = now(), updated_at = now()
            WHERE id = CAST(:task_id AS uuid) AND status = 'pending_approval'
            RETURNING id::text
            """
        ),
        {"task_id": task_id, "approved_by": request.approved_by},
    )
    row = result.mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Pending task not found")
    await session.commit()
    return {"approved": True, "task_id": row["id"]}


@app.post("/hitl/tasks/{task_id}/reject")
async def reject_task(task_id: str, session: AsyncSession = Depends(get_session)) -> dict:
    result = await session.execute(
        text(
            """
            UPDATE agent_task_queue
            SET status = 'rejected', updated_at = now()
            WHERE id = CAST(:task_id AS uuid) AND status = 'pending_approval'
            RETURNING id::text
            """
        ),
        {"task_id": task_id},
    )
    row = result.mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Pending task not found")
    await session.commit()
    return {"rejected": True, "task_id": row["id"]}


@app.post("/internal/cron/retention-daily")
async def cron_retention_daily() -> dict:
    task = retention_scan_daily.delay()
    return {"queued": True, "celery_task_id": task.id}
