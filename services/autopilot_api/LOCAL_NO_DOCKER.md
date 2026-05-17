# Run Locally Without Docker

This mode uses:

- FastAPI
- A local SQLite database file: `local_autopilot.db`
- Inline agent execution, no Redis or Celery worker required

It is intended for development and demos on your computer.

## 1. Setup

From PowerShell:

```powershell
cd C:\Users\aaron\event_crm\services\autopilot_api
.\setup_local.ps1
```

If PowerShell blocks scripts, run:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\setup_local.ps1
```

## 2. Start The API

```powershell
.\run_local.ps1
```

Open:

```text
http://127.0.0.1:8080/docs
```

## 3. Useful Local Endpoints

Health:

```text
GET http://127.0.0.1:8080/health
```

View demo contacts/events:

```text
GET http://127.0.0.1:8080/local/demo-data
```

Run the 30-day retention agent:

```text
POST http://127.0.0.1:8080/agents/retention/run
```

Generate a hype campaign:

```text
POST http://127.0.0.1:8080/agents/hype/campaign
```

Example JSON body:

```json
{
  "raw_copy": "Friday rooftop R&B night at The Wharf with VIP tables available",
  "asset_url": null
}
```

View pending approval tasks:

```text
GET http://127.0.0.1:8080/hitl/tasks
```

Turn Autopilot ON:

```text
PUT http://127.0.0.1:8080/autopilot
```

JSON body:

```json
{
  "enabled": true,
  "min_confidence": 0.82
}
```

## Local vs Production

Local mode is intentionally simple:

- SQLite instead of PostgreSQL
- Inline work instead of Celery and Redis
- Mock payment links instead of Stripe
- Draft SMS/email copy instead of real Twilio/SendGrid calls

Production mode remains available through `app.main:app`, PostgreSQL, Redis, and Celery.
