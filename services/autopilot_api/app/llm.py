from __future__ import annotations

from dataclasses import dataclass
from typing import Any


WIN_BACK_SYSTEM_PROMPT = """
You are the Classic Productions Win-Back Worker. Write concise, premium nightlife SMS copy for prior guests.
Voice: warm, elevated, urban, never desperate, never spammy.
Goal: invite the contact back with a relevant event, VIP table, or pass allocation.
Rules:
- 280 characters maximum.
- Mention exactly one relevant upcoming event.
- Reference one known preference if available.
- No false scarcity. Only say VIP/table availability if provided in payload.
- Return strict JSON: {"message":"...", "confidence":0.0, "reason":"..."}.
""".strip()

HYPE_SYSTEM_PROMPT = """
You are the Classic Productions Hype and Distribution Agent.
Extract event entities and create segmented marketing copy.
Voice: luxury nightlife, concise, polished, conversion oriented.
Return strict JSON with entities, segments, sms_variants, and email_variants.
Do not invent artists, venue, or date. Use {{booking_url}} for CTA links.
""".strip()

CONCIERGE_SYSTEM_PROMPT = """
You are the Classic Productions Virtual Concierge.
You handle SMS replies for event tickets and VIP tables.
You must use database/tool results for availability and pricing. Never invent table availability or price.
If intent is unclear, ask one short clarification question.
Return strict JSON with intent, reply, actions, and confidence.
""".strip()


@dataclass
class LlmResult:
    body: dict[str, Any]
    confidence: float
    reason: str


async def generate_win_back(contact: dict[str, Any], events: list[dict[str, Any]]) -> LlmResult:
    event = events[0] if events else {"title": "our next Classic Productions event", "venue_name": ""}
    first = contact.get("first_name") or "there"
    genre = (contact.get("preferred_genres") or ["R&B"])[0]
    message = (
        f"{first}, we saved you a lane for {event.get('title')}."
        f" Since you vibe with {genre}, this one fits. Reply VIP for table options."
    )
    return LlmResult(
        body={"message": message[:280]},
        confidence=0.86 if events else 0.62,
        reason="Matched dormant contact to nearest upcoming event and known genre preference.",
    )


async def generate_hype_campaign(raw_copy: str, asset_url: str | None) -> LlmResult:
    title = raw_copy.splitlines()[0][:80] if raw_copy else "Classic Productions Event"
    body = f"{title}. Classic Nights. Modern Beats. Lock in now: {{booking_url}}"
    return LlmResult(
        body={
            "entities": {"title": title, "genres": [], "vibe_tags": [], "asset_url": asset_url},
            "segments": [{"name": "High intent nightlife", "criteria": {"sms_opt_in": True}, "reason": "Broad launch segment"}],
            "sms_variants": [{"segment": "High intent nightlife", "body": body[:280], "confidence": 0.78}],
            "email_variants": [
                {
                    "segment": "High intent nightlife",
                    "subject": title,
                    "preview": "A new Classic Productions night is live.",
                    "body_html": f"<p>{body}</p>",
                    "confidence": 0.78,
                }
            ],
        },
        confidence=0.78,
        reason="Generated initial campaign draft from raw event copy.",
    )


async def parse_concierge_reply(body: str, availability: list[dict[str, Any]]) -> LlmResult:
    lowered = body.lower()
    ready = any(token in lowered for token in ["book", "pay", "table", "vip"])
    if ready and availability:
        table = availability[0]
        reply = (
            f"I can hold {table['label']} for your group. "
            f"Total is ${table['price_cents'] / 100:.0f}. Reply PAY and I will send the secure link."
        )
        intent = "book_table"
        confidence = 0.88
    else:
        reply = "I can help with tickets or VIP tables. What event and party size are you looking for?"
        intent = "general"
        confidence = 0.66
    return LlmResult(
        body={"intent": intent, "reply": reply, "actions": []},
        confidence=confidence,
        reason="Parsed inbound booking intent from SMS body.",
    )
