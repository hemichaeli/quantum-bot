/**
 * Twilio Voice Routes — direct integration (no VAPI)
 *
 *   POST /api/twilio/voice/inbound          — TwiML for incoming-to-stream
 *   POST /api/twilio/voice/outbound         — initiate outbound call
 *   POST /api/twilio/voice/status           — Twilio call status callback (logs)
 *   POST /api/twilio/voice/internal/book-slot
 *   POST /api/twilio/voice/internal/send-summary
 *
 * Outbound flow:
 *   POST /outbound { phone, lead_name, city, listing_url, seller_phone }
 *   → Twilio.calls.create with Url= our /inbound endpoint (which returns <Stream>)
 *   → Twilio opens WS to /api/twilio/voice/stream
 *   → voiceBridge handles audio + tools
 */

const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const { logger } = require('../services/logger');

const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN  || '';
const TWILIO_FROM  = process.env.TWILIO_FROM_NUMBER || '';
const PUBLIC_HOST  = process.env.PUBLIC_HOST || process.env.RAILWAY_PUBLIC_DOMAIN || 'quantum-bot-production-feb5.up.railway.app';

let twilioClient = null;
function getTwilio() {
  if (!twilioClient && TWILIO_SID && TWILIO_TOKEN) {
    twilioClient = require('twilio')(TWILIO_SID, TWILIO_TOKEN);
  }
  return twilioClient;
}

// ─── Inbound (TwiML returned when Twilio call connects) ─────────────────────────
router.post('/inbound', express.urlencoded({ extended: true }), (req, res) => {
  const callSid = req.body.CallSid || req.query.call_id || '';
  const params = req.query; // we pass context via URL query when creating the call

  const streamUrl = `wss://${PUBLIC_HOST}/api/twilio/voice/stream`;
  const queryString = Object.entries(params || {})
    .filter(([_, v]) => v != null && v !== '')
    .map(([k, v]) => `<Parameter name="${k}" value="${escapeXml(String(v))}"/>`)
    .join('');

  // Connect verb keeps the call open for the full bridge duration
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="call_id" value="${escapeXml(callSid)}"/>
      ${queryString}
    </Stream>
  </Connect>
</Response>`;
  res.type('text/xml').send(twiml);
});

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

// ─── Outbound origination ───────────────────────────────────────────────────────
router.post('/outbound', async (req, res) => {
  const client = getTwilio();
  if (!client) return res.status(503).json({ success: false, error: 'TWILIO_ACCOUNT_SID/AUTH_TOKEN not configured' });

  const { phone, lead_name = '', city = '', listing_url = '', from } = req.body || {};
  if (!phone) return res.status(400).json({ success: false, error: 'phone required' });

  const fromNumber = from || TWILIO_FROM;
  if (!fromNumber) return res.status(503).json({ success: false, error: 'TWILIO_FROM_NUMBER not set and no from in body' });

  // Normalize destination to E.164
  const digits = String(phone).replace(/\D/g, '');
  const to = digits.startsWith('972') ? `+${digits}` : digits.startsWith('0') ? `+972${digits.slice(1)}` : `+${digits}`;

  // Build inbound TwiML URL with context as query
  const ctx = new URLSearchParams({
    lead_name: lead_name || '',
    city: city || '',
    listing_url: listing_url || '',
    seller_phone: to
  });
  const url = `https://${PUBLIC_HOST}/api/twilio/voice/inbound?${ctx.toString()}`;
  const statusCallback = `https://${PUBLIC_HOST}/api/twilio/voice/status`;

  try {
    const call = await client.calls.create({
      from: fromNumber,
      to,
      url,
      statusCallback,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
      machineDetection: 'DetectMessageEnd'
    });
    logger.info('[twilioVoice] outbound created', { sid: call.sid, to, lead_name });
    res.json({ success: true, call_sid: call.sid, status: call.status, to, from: fromNumber });
  } catch (err) {
    logger.error('[twilioVoice] outbound failed', { msg: err.message, code: err.code, more: err.moreInfo });
    res.status(500).json({ success: false, error: err.message, code: err.code });
  }
});

// ─── Twilio status webhook (just log) ───────────────────────────────────────────
router.post('/status', express.urlencoded({ extended: true }), (req, res) => {
  const { CallSid, CallStatus, From, To, Duration, AnsweredBy } = req.body || {};
  logger.info('[twilioVoice] status', { CallSid, CallStatus, From, To, Duration, AnsweredBy });
  res.sendStatus(204);
});

// ─── Internal tool endpoints (called by voiceBridge) ───────────────────────────
// book-slot: persists to DB + writes Google Calendar event
router.post('/internal/book-slot', async (req, res) => {
  try {
    const { slot_start, seller_name, seller_phone, property_summary, our_call_id, listing_url } = req.body || {};
    if (!slot_start) return res.status(400).json({ error: 'slot_start required' });

    const pool = require('../db/pool');
    await pool.query(
      `INSERT INTO appointments (call_id, scheduled_at, seller_name, seller_phone, property_summary, listing_url, source, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'twilio_voice', NOW())
       ON CONFLICT DO NOTHING`,
      [our_call_id || null, slot_start, seller_name || null, seller_phone || null, property_summary || null, listing_url || null]
    ).catch(err => logger.warn('[twilioVoice] book-slot db insert skipped', { msg: err.message }));

    // Best-effort Google Calendar event creation (reuse existing helper)
    try {
      const vapiRoutes = require('./vapiRoutes');
      if (typeof vapiRoutes.createCalendarEvent === 'function') {
        await vapiRoutes.createCalendarEvent({
          startISO: slot_start,
          durationMinutes: 15,
          summary: `שיחת QUANTUM עם ${seller_name || 'מוכר'}`,
          description: [property_summary || '', listing_url ? `\nמודעה: ${listing_url}` : ''].join(''),
          attendees: seller_phone ? [{ phone: seller_phone }] : []
        });
      }
    } catch (calErr) {
      logger.warn('[twilioVoice] calendar create skipped', { msg: calErr.message });
    }

    res.json({ success: true, slot_start, message: 'הפגישה נקבעה ביומן' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// send-summary: WhatsApp/SMS to seller via existing InforU service
router.post('/internal/send-summary', async (req, res) => {
  try {
    const { summary, meeting_at, seller_phone, our_call_id, listing_url } = req.body || {};
    if (!seller_phone) return res.status(400).json({ error: 'seller_phone required' });
    const inforu = require('../services/inforuService');

    const meetingLine = meeting_at ? `\nמועד הפגישה: ${formatHebrewDate(meeting_at)}` : '';
    const linkLine    = listing_url ? `\nמודעה: ${listing_url}` : '';
    const body = `סיכום שיחה - QUANTUM:\n${(summary || '').slice(0, 600)}${meetingLine}${linkLine}\n\nתודה, רן מ-QUANTUM.`;

    const result = await inforu.sendSms(seller_phone, body, { senderName: 'QUANTUM' });
    res.json({ success: !!result?.success, channel: 'sms', detail: result?.description });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function formatHebrewDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Jerusalem' });
  } catch { return iso; }
}

module.exports = router;
