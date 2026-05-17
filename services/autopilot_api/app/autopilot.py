import json
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .schemas import AutopilotMode


async def get_autopilot_mode(session: AsyncSession) -> AutopilotMode:
    result = await session.execute(
        text("SELECT value FROM system_settings WHERE key = 'autopilot_mode'")
    )
    row = result.mappings().first()
    if not row:
        return AutopilotMode(enabled=False)
    value: Any = row["value"]
    if isinstance(value, str):
        value = json.loads(value)
    return AutopilotMode(**value)


async def set_autopilot_mode(session: AsyncSession, mode: AutopilotMode) -> AutopilotMode:
    await session.execute(
        text(
            """
            INSERT INTO system_settings (key, value, updated_at)
            VALUES ('autopilot_mode', CAST(:value AS jsonb), now())
            ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, updated_at = now()
            """
        ),
        {"value": mode.model_dump_json()},
    )
    await session.commit()
    return mode


def should_execute(mode: AutopilotMode, confidence: float) -> bool:
    return mode.enabled and confidence >= mode.min_confidence
