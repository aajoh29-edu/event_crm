from __future__ import annotations

import uuid


async def send_sms(to_phone: str, body: str) -> dict:
    # Replace with Twilio client call in production.
    return {"provider": "twilio", "message_id": f"mock_{uuid.uuid4()}", "to": to_phone, "body": body}


async def send_email(to_email: str, subject: str, body_html: str) -> dict:
    # Replace with SendGrid or Resend client call in production.
    return {"provider": "email", "message_id": f"mock_{uuid.uuid4()}", "to": to_email, "subject": subject}


async def create_payment_link(booking_id: str, amount_cents: int) -> str:
    # Replace with Stripe Payment Links or Checkout Sessions in production.
    return f"https://pay.classic-productions.example/checkout/{booking_id}?amount={amount_cents}"
