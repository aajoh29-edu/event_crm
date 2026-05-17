# Classic Productions Autopilot CRM Blueprint

Theme: Classic Nights. Modern Beats.

This blueprint describes a production target architecture for a high-end nightlife, venue management, and event marketing CRM that can run autonomously while preserving human approval controls when Autopilot Mode is off.

## 1. Architecture

### Services

- `web-admin`: Existing admin CRM dashboard or future React/Next.js dashboard.
- `public-web`: Public event, booking, QR, and preference-game website.
- `api-gateway`: FastAPI service for contacts, events, bookings, agent tasks, inbound webhooks, and Stripe/Twilio callbacks.
- `agent-worker`: Celery worker process that executes retention, hype/distribution, and concierge workflows.
- `scheduler`: Celery Beat or Cloud Scheduler trigger for daily retention checks and periodic follow-ups.
- `postgres`: System of record for contacts, events, bookings, payments, preferences, and agent tasks.
- `redis`: Queue broker and short-term state store for Celery task routing and rate limiting.
- `llm-provider`: OpenAI/Anthropic compatible model endpoint.
- `messaging`: Twilio for SMS, SendGrid/Resend for email.
- `payments`: Stripe checkout/payment links.

### Deployment Pattern

- Run `api-gateway` on Google Cloud Run.
- Run `agent-worker` as a Cloud Run worker service or Cloud Run Jobs for scheduled batches.
- Use Cloud SQL for PostgreSQL.
- Use Memorystore Redis or Upstash Redis for queue/broker.
- Use Cloud Scheduler to trigger `/internal/cron/retention-daily`, or use Celery Beat as a separate service.
- Store secrets in Google Secret Manager.
- Emit structured logs to Cloud Logging with `agent_run_id`, `contact_id`, and `event_id`.

### Async Task Layer

Dashboard actions should enqueue tasks and return immediately. Heavy loops run in Celery:

- `retention.scan_daily`
- `retention.contact_one`
- `hype.generate_campaign`
- `hype.dispatch_campaign`
- `concierge.handle_inbound_sms`
- `payments.reconcile`

Every task writes an `agent_task_queue` row. If `autopilot_mode.enabled = true`, high-confidence actions are sent automatically. If false, the task saves a draft with `status = pending_approval`.

### Autopilot Mode

The global flag lives in `system_settings`:

- `key = 'autopilot_mode'`
- `value = '{"enabled": true, "min_confidence": 0.82}'`

Behavior:

- ON: Agents can send outreach, create Stripe links, reserve holds, and follow up if confidence passes threshold.
- OFF: Agents generate drafts and pricing recommendations, then stage them in the HITL queue.
- Any low-confidence or policy-sensitive decision is staged even when Autopilot is ON.

## 2. Agents

### A. 30-Day Retention Agent: Win-Back Worker

Trigger:

- Daily cron at 9:00 AM local market time.
- Query contacts where `last_attended_date < now() - interval '30 days'`, opted into SMS, and no retention message in the last 7 days.

Inputs:

```json
{
  "contact": {
    "id": "uuid",
    "first_name": "Aaliyah",
    "spend_tier": "vip",
    "preferred_genres": ["90s R&B", "Afro Beats"],
    "preferred_venue_types": ["waterfront", "rooftop"],
    "last_attended_date": "2026-03-21"
  },
  "upcoming_events": [
    {
      "id": "uuid",
      "title": "R&B On the Water",
      "date": "2026-06-21",
      "venue": "The Wharf",
      "genre_tags": ["R&B", "waterfront"],
      "vip_table_base_price_cents": 65000
    }
  ]
}
```

System prompt:

```text
You are the Classic Productions Win-Back Worker. Write concise, premium nightlife SMS copy for prior guests.
Voice: warm, elevated, urban, never desperate, never spammy.
Goal: invite the contact back with a relevant event, VIP table, or pass allocation.
Rules:
- 280 characters maximum.
- Mention exactly one relevant upcoming event.
- Reference one known preference if available.
- No false scarcity. Only say VIP/table availability if provided in payload.
- Return strict JSON: {"message":"...", "confidence":0.0, "reason":"..."}.
```

Decision logic:

1. Fetch dormant contacts.
2. Rank upcoming events by genre, venue type, average spend fit, and recency.
3. Generate SMS.
4. Validate opt-in, quiet hours, cooldown, and confidence.
5. If Autopilot ON and confidence >= threshold, send via Twilio and log.
6. Otherwise create `agent_task_queue` pending approval row.

### B. Hype & Distribution Agent: Multi-Channel Promoter

Trigger:

- Admin uploads event asset or raw copy.
- Event record enters `draft_campaign` state.

Inputs:

```json
{
  "raw_copy": "Friday yacht party, Afro Beats and R&B, hosted by DJ Nova, 8 PM",
  "asset_url": "gs://classic-assets/event.jpg",
  "event_id": "uuid"
}
```

System prompt:

```text
You are the Classic Productions Hype and Distribution Agent.
Extract event entities and create segmented marketing copy.
Voice: luxury nightlife, concise, polished, conversion oriented.
Return strict JSON with:
{
  "entities": {"title":"","date":"","venue":"","genres":[],"artists":[],"vibe_tags":[]},
  "segments": [{"name":"","criteria":{},"reason":""}],
  "sms_variants": [{"segment":"","body":"","confidence":0.0}],
  "email_variants": [{"segment":"","subject":"","preview":"","body_html":"","confidence":0.0}]
}
Rules:
- SMS must be under 280 chars.
- Do not invent artists, venue, or date.
- Include CTA placeholders only: {{booking_url}}.
```

Decision logic:

1. Extract structured event metadata.
2. Persist `events.genre_tags`, `events.vibe_tags`, and campaign copy drafts.
3. Segment contacts by historical bookings, preference game data, spend tier, and channel opt-ins.
4. Queue or send per Autopilot Mode.

### C. Two-Way Inbound Booking Agent: Virtual Concierge

Trigger:

- Twilio inbound SMS webhook.

State:

- Store thread state in `conversation_threads`.
- State machine stages: `intent_detected`, `event_selected`, `quote_sent`, `payment_link_sent`, `confirmed`, `handoff`.

System prompt:

```text
You are the Classic Productions Virtual Concierge.
You handle SMS replies for event tickets and VIP tables.
You are accurate, polished, and brief.
You must use database/tool results for availability and pricing. Never invent table availability or price.
If intent is unclear, ask one short clarification question.
If user is ready to pay, create a secure Stripe Payment Link through the payment tool.
Return strict JSON:
{
  "intent":"book_table|buy_tickets|ask_price|modify_booking|general|handoff",
  "reply":"...",
  "actions":[{"type":"","payload":{}}],
  "confidence":0.0
}
```

Tool payloads:

```json
{
  "lookup_availability": {"event_id":"uuid","party_size":6,"table_type":"vip"},
  "quote_booking": {"event_id":"uuid","party_size":6,"table_type":"vip"},
  "create_stripe_payment_link": {"booking_id":"uuid","amount_cents":120000}
}
```

Decision logic:

1. Validate Twilio signature.
2. Resolve contact by phone.
3. Load recent conversation and available events.
4. Parse intent.
5. Query availability.
6. If user is ready and availability exists, create booking hold and Stripe Payment Link.
7. Send reply automatically if Autopilot ON and confidence passes threshold. Otherwise stage draft.

## 3. HITL Dashboard Contract

`agent_task_queue` powers the approval queue:

- `pending_approval`: show draft, confidence, reason, payload, and approve/send buttons.
- `approved`: worker can execute.
- `sent`: completed action.
- `rejected`: dismissed by admin.
- `failed`: action failed and needs review.

## 4. Production Notes

- Use table/section inventory with short holds to avoid overselling VIP sections.
- Add SMS quiet-hour enforcement per market.
- Add opt-out handling: STOP, UNSUBSCRIBE, REMOVE.
- Add rate limits by channel, contact, and campaign.
- Add audit logs for every automated action.
- Use idempotency keys for Stripe and Twilio calls.
- Separate personally identifiable information access by service account role.
