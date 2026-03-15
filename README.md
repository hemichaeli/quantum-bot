# QUANTUM Bot

**Auto-outreach WhatsApp bot for new Pinuy-Binuy listings + VAPI follow-up calls**

## What it does

1. **Auto first contact** — When a new listing is found in the analyzer DB (Yad2/Facebook/Kones), sends an automatic WhatsApp message from QUANTUM's business line via INFORU
2. **Follow-up reminders** — If no reply after 24h, sends configurable follow-up messages
3. **VAPI outbound call** — If still no reply after N reminders, triggers an AI voice call via VAPI
4. **Incoming message handling** — Polls INFORU every 30s for replies, routes to conversation AI (Claude)

## Architecture

```
pinuy-binuy-analyzer DB (read)
        ↓
QUANTUM Bot (this repo)
        ↓
INFORU CAPI → WhatsApp (QUANTUM business line: 037572229)
        ↓ (no reply after N hours)
VAPI AI Voice Call
```

## Environment Variables

See `.env.example` for all required variables.

## Deploy on Railway

1. Connect this repo to Railway
2. Set all env vars from `.env.example`
3. Railway will auto-deploy on every push to `main`

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Service health check |
| POST | `/api/outreach/send` | Send first contact to a listing |
| POST | `/api/outreach/batch` | Batch first contact for multiple listings |
| POST | `/api/vapi/outbound` | Trigger VAPI call |
| GET | `/api/leads` | List leads with their contact status |
| POST | `/api/campaigns` | Create a new outreach campaign |
