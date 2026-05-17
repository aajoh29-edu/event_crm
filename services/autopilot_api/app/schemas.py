from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class AutopilotMode(BaseModel):
    enabled: bool
    min_confidence: float = Field(default=0.82, ge=0, le=1)


class EventDraftRequest(BaseModel):
    raw_copy: str = Field(min_length=3, max_length=5000)
    asset_url: str | None = None
    event_id: str | None = None


class AgentTaskOut(BaseModel):
    id: str
    agent_name: str
    task_type: str
    status: str
    channel: str | None = None
    draft_subject: str | None = None
    draft_body: str | None = None
    confidence: float
    reason: str | None = None
    payload: dict[str, Any]
    created_at: datetime


class InboundSms(BaseModel):
    From: str
    To: str
    Body: str
    MessageSid: str | None = None


class ApprovalRequest(BaseModel):
    approved_by: str
