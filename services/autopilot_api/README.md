# Classic Productions Autopilot API

FastAPI and Celery starter service for the production Autopilot CRM architecture.

## Local Run Without Docker

For your current setup, use the no-Docker SQLite runner:

```powershell
cd C:\Users\aaron\event_crm\services\autopilot_api
.\setup_local.ps1
.\run_local.ps1
```

Open:

```text
http://127.0.0.1:8080/docs
```

See [LOCAL_NO_DOCKER.md](./LOCAL_NO_DOCKER.md) for the full local workflow.

## Docker Run

```bash
cd services/autopilot_api
docker compose up --build
```

API:

```text
http://localhost:8080
```

Useful endpoints:

- `GET /health`
- `GET /autopilot`
- `PUT /autopilot`
- `POST /agents/retention/run`
- `POST /agents/hype/campaign`
- `POST /webhooks/twilio/inbound-sms`
- `GET /hitl/tasks`
- `POST /hitl/tasks/{task_id}/approve`
- `POST /hitl/tasks/{task_id}/reject`

## Google Cloud Run

Build and deploy the API container:

```bash
gcloud builds submit ../.. --tag gcr.io/PROJECT_ID/classic-autopilot-api \
  --file services/autopilot_api/Dockerfile

gcloud run deploy classic-autopilot-api \
  --image gcr.io/PROJECT_ID/classic-autopilot-api \
  --region us-east1 \
  --allow-unauthenticated \
  --set-env-vars APP_ENV=production
```

Deploy workers as separate Cloud Run services or Cloud Run Jobs using:

```bash
celery -A app.tasks.celery_app worker --loglevel=INFO
```

Run scheduled retention with Cloud Scheduler calling:

```text
POST /internal/cron/retention-daily
```

## Secrets

Store these in Secret Manager:

- `DATABASE_URL`
- `SYNC_DATABASE_URL`
- `REDIS_URL`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_PHONE_NUMBER`
- `STRIPE_SECRET_KEY`
- `LLM_API_KEY`
