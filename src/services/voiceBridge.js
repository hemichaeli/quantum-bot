/**
 * Voice Bridge — Twilio Media Streams ↔ OpenAI Realtime
 *
 * One instance per call. Lifecycle:
 *   1. Twilio opens a WebSocket and sends "start" event with call metadata.
 *   2. We open a parallel WebSocket to wss://api.openai.com/v1/realtime.
 *   3. session.update sent to OpenAI with system prompt, voice, tools.
 *   4. Bidirectional audio: μ-law 8kHz both directions (no resampling needed).
 *   5. Function calls from OpenAI → handleFunctionCall → existing tool endpoints.
 *   6. On call end → final summary push if not yet sent.
 *
 * Reference: https://platform.openai.com/docs/guides/realtime-conversations
 *            https://www.twilio.com/docs/voice/twiml/stream
 */

const WebSocket = require('ws');
const axios = require('axios');
const { logger } = require('./logger');
const { RAN_MODEL, buildSessionConfig } = require('./ranAgentConfig');

const OPENAI_REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(RAN_MODEL)}`;

/**
 * Handle a single Twilio Media Stream connection.
 * Called from upgrade handler in index.js when a WS hits /api/twilio/voice/stream.
 *
 * @param {WebSocket} twilioWs - the Twilio side of the bridge
 * @param {object} ctx - call context parsed from URL query: { call_id, lead_name, city, listing_url, seller_phone }
 */
function handleConnection(twilioWs, ctx = {}) {
  const callId = ctx.call_id || `local-${Date.now()}`;
  const sellerPhone = ctx.seller_phone || '';
  logger.info(`[voiceBridge] new connection`, { callId, lead: ctx.lead_name, city: ctx.city });

  let streamSid = null;
  let openaiWs = null;
  let openaiReady = false;
  const queuedToOpenAI = [];
  let transcript = []; // [{ role, text }]
  let summarySent = false;

  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (!openaiApiKey) {
    logger.error('[voiceBridge] OPENAI_API_KEY missing - closing');
    try { twilioWs.close(1011, 'OPENAI_API_KEY not configured'); } catch {}
    return;
  }

  // ───────────────────── OpenAI side ─────────────────────
  openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });

  openaiWs.on('open', () => {
    logger.info(`[voiceBridge:${callId}] OpenAI WS opened`);
    const session = buildSessionConfig({
      leadName: ctx.lead_name,
      city: ctx.city,
      listingUrl: ctx.listing_url
    });
    openaiWs.send(JSON.stringify(session));
    openaiReady = true;
    // flush any audio frames that arrived before openai opened
    while (queuedToOpenAI.length) openaiWs.send(queuedToOpenAI.shift());
    // kick off the assistant's first message immediately
    openaiWs.send(JSON.stringify({ type: 'response.create' }));
  });

  openaiWs.on('message', async (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch { return; }

    switch (evt.type) {
      case 'response.audio.delta':
        // OpenAI sends base64 μ-law 8kHz. Forward to Twilio as media frame.
        if (streamSid && evt.delta) {
          twilioWs.send(JSON.stringify({
            event: 'media',
            streamSid,
            media: { payload: evt.delta }
          }));
        }
        break;

      case 'response.audio_transcript.delta':
        // assistant transcript chunks - accumulate
        // (handled at .done for cleaner record)
        break;

      case 'response.audio_transcript.done':
        if (evt.transcript) transcript.push({ role: 'assistant', text: evt.transcript });
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (evt.transcript) transcript.push({ role: 'user', text: evt.transcript });
        break;

      case 'response.function_call_arguments.done':
        await handleFunctionCall(openaiWs, evt, { callId, sellerPhone, ctx, transcript, markSummarySent: () => { summarySent = true; } });
        break;

      case 'error':
        logger.error(`[voiceBridge:${callId}] OpenAI error`, evt.error || evt);
        break;

      case 'input_audio_buffer.speech_started':
        // Caller started speaking - cancel any ongoing assistant response (interruption)
        try {
          twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
          openaiWs.send(JSON.stringify({ type: 'response.cancel' }));
        } catch {}
        break;
    }
  });

  openaiWs.on('close', (code, reason) => {
    logger.info(`[voiceBridge:${callId}] OpenAI WS closed`, { code, reason: reason?.toString() });
    try { twilioWs.close(); } catch {}
  });

  openaiWs.on('error', (err) => {
    logger.error(`[voiceBridge:${callId}] OpenAI WS error`, { msg: err.message });
  });

  // ───────────────────── Twilio side ─────────────────────
  twilioWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.event) {
      case 'connected':
        // first frame Twilio sends — protocol handshake
        break;

      case 'start':
        streamSid = msg.start?.streamSid;
        logger.info(`[voiceBridge:${callId}] Twilio stream started`, { streamSid });
        break;

      case 'media': {
        // base64 μ-law 8kHz - forward to OpenAI as input_audio_buffer.append
        const payload = msg.media?.payload;
        if (!payload) break;
        const frame = JSON.stringify({ type: 'input_audio_buffer.append', audio: payload });
        if (openaiReady) openaiWs.send(frame);
        else queuedToOpenAI.push(frame);
        break;
      }

      case 'stop':
        logger.info(`[voiceBridge:${callId}] Twilio stream stop`);
        try { openaiWs?.close(); } catch {}
        // persist transcript / fire post-call summary if not yet
        if (!summarySent && sellerPhone) {
          firePostCallSummary({ callId, sellerPhone, transcript, ctx }).catch(err =>
            logger.error(`[voiceBridge:${callId}] post-call summary error`, { msg: err.message }));
        }
        break;
    }
  });

  twilioWs.on('close', () => {
    logger.info(`[voiceBridge:${callId}] Twilio WS closed`);
    try { openaiWs?.close(); } catch {}
  });

  twilioWs.on('error', (err) => {
    logger.error(`[voiceBridge:${callId}] Twilio WS error`, { msg: err.message });
  });
}

// ───────────────────── Function call dispatcher ─────────────────────

async function handleFunctionCall(openaiWs, evt, { callId, sellerPhone, ctx, transcript, markSummarySent }) {
  const name = evt.name;
  const callIdOpenAI = evt.call_id; // OpenAI's id for the function call, distinct from our callId
  let args = {};
  try { args = JSON.parse(evt.arguments || '{}'); } catch {}

  logger.info(`[voiceBridge:${callId}] function call`, { name, args });

  let result;
  try {
    if (name === 'getAvailableSlots') {
      result = await callGetAvailableSlots(args);
    } else if (name === 'bookSlot') {
      result = await callBookSlot({ ...args, seller_phone: args.seller_phone || sellerPhone, our_call_id: callId, listing_url: ctx.listing_url });
    } else if (name === 'sendCallSummary') {
      result = await callSendCallSummary({ ...args, seller_phone: sellerPhone, our_call_id: callId, listing_url: ctx.listing_url });
      markSummarySent();
    } else {
      result = { error: `Unknown function: ${name}` };
    }
  } catch (err) {
    logger.error(`[voiceBridge:${callId}] function call error`, { name, msg: err.message });
    result = { error: err.message };
  }

  // Send the result back to OpenAI so the model can continue
  openaiWs.send(JSON.stringify({
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: callIdOpenAI,
      output: JSON.stringify(result)
    }
  }));
  // Trigger a new response generation now that we've provided the function output
  openaiWs.send(JSON.stringify({ type: 'response.create' }));
}

// ───────────────────── Tool implementations ─────────────────────
// These delegate to existing endpoints / services so we don't duplicate logic.

const SELF_BASE = process.env.SELF_BASE_URL || `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'quantum-bot-production-feb5.up.railway.app'}`;

async function callGetAvailableSlots() {
  try {
    const vapiRoutes = require('../routes/vapiRoutes');
    if (typeof vapiRoutes.fetchFreeSlots === 'function') {
      const slots = await vapiRoutes.fetchFreeSlots();
      return { slots: (slots || []).slice(0, 4) };
    }
  } catch (err) {
    logger.warn('[voiceBridge] fetchFreeSlots direct call failed', { msg: err.message });
  }
  return { error: 'slot lookup unavailable' };
}

async function callBookSlot({ slot_start, seller_name, seller_phone, property_summary, our_call_id, listing_url }) {
  try {
    const { data } = await axios.post(`${SELF_BASE}/api/twilio/voice/internal/book-slot`, {
      slot_start, seller_name, seller_phone, property_summary, our_call_id, listing_url
    }, { timeout: 12000 });
    return data;
  } catch (err) {
    return { error: 'book failed', detail: err.response?.data || err.message };
  }
}

async function callSendCallSummary({ summary, meeting_at, seller_phone, our_call_id, listing_url }) {
  try {
    const { data } = await axios.post(`${SELF_BASE}/api/twilio/voice/internal/send-summary`, {
      summary, meeting_at, seller_phone, our_call_id, listing_url
    }, { timeout: 12000 });
    return data;
  } catch (err) {
    return { error: 'summary send failed', detail: err.response?.data || err.message };
  }
}

async function firePostCallSummary({ callId, sellerPhone, transcript, ctx }) {
  if (!sellerPhone || !transcript.length) return;
  // build a short summary from the transcript (first 20 turns) and ship it
  const summary = transcript.slice(0, 30).map(t => `${t.role === 'assistant' ? 'רן' : 'מוכר'}: ${t.text}`).join('\n').slice(0, 1000);
  return callSendCallSummary({ summary, seller_phone: sellerPhone, our_call_id: callId, listing_url: ctx.listing_url });
}

module.exports = { handleConnection };
