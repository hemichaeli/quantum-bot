/**
 * QUANTUM Bot — Main Entry Point
 *
 * Responsibilities:
 *  1. Auto first-contact WhatsApp to new listing publishers (Yad2 / Facebook / Kones)
 *  2. Follow-up reminders if no reply (configurable intervals)
 *  3. VAPI outbound call if still no reply after 3 hours (Zoho CRM leads)
 *  4. Incoming WhatsApp polling → route to conversation handler
 *  5. Social media moderation (Facebook + Instagram) with AI classification
 *
 * Data source: PostgreSQL (DATABASE_URL)
 * Outbound channel: INFORU CAPI
 * Voice calls: VAPI AI
 * Moderation: Meta Graph API + OpenAI GPT
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { logger } = require('./services/logger');

const app = express();
app.use(cors());
app.use(express.json());

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'quantum-bot',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    env: {
      inforu:       !!(process.env.INFORU_USERNAME && (process.env.INFORU_TOKEN || process.env.INFORU_PASSWORD)),
      vapi:         !!process.env.VAPI_API_KEY,
      zoho:         !!(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_REFRESH_TOKEN),
      meta:         !!process.env.META_ACCESS_TOKEN,
      openai:       !!process.env.OPENAI_API_KEY,
      db:           !!process.env.DATABASE_URL,
      anthropic:    !!process.env.ANTHROPIC_API_KEY,
      businessLine: process.env.INFORU_BUSINESS_LINE || '037572229',
    },
  });
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/outreach',    require('./routes/outreachRoutes'));
app.use('/api/vapi',        require('./routes/vapiRoutes'));
app.use('/api/whatsapp',    require('./routes/whatsappRoutes'));
app.use('/api/webhook',     require('./routes/whatsappWebhookRoutes'));
app.use('/api/leads',       require('./routes/leadRoutes'));
app.use('/api/messaging',   require('./routes/messagingRoutes'));
app.use('/api/campaigns',   require('./routes/campaignRoutes'));
app.use('/api/conversation',require('./routes/quantumConversationRoutes'));
app.use('/api/bot',         require('./routes/botRoutes'));
app.use('/api/quantum-wa',  require('./routes/quantumWhatsAppRoutes'));

// New: Zoho CRM Outreach (3-hour escalation)
app.use('/api/zoho-outreach', require('./routes/zohoOutreachRoutes'));

// New: Social Media Moderation
app.use('/api/moderation',    require('./routes/moderationRoutes'));

// ── Scheduled Jobs ────────────────────────────────────────────────────────────

// 1. Auto first-contact: every 30 minutes — scan for new listings and send WA
cron.schedule('*/30 * * * *', async () => {
  try {
    const { runAutoFirstContact, runKonesAutoContact } = require('./services/autoFirstContactService');
    const yad2fb = await runAutoFirstContact();
    const kones  = await runKonesAutoContact();
    logger.info('[Cron] Auto first-contact completed', { yad2fb, kones });
  } catch (err) {
    logger.error('[Cron] Auto first-contact error:', err.message);
  }
});

// 2. WA follow-up: every hour — send follow-up to leads with no reply > 24h
cron.schedule('0 * * * *', async () => {
  try {
    const { runFollowUpJob } = require('./jobs/whatsappFollowUp');
    const result = await runFollowUpJob();
    logger.info('[Cron] WhatsApp follow-up completed', result);
  } catch (err) {
    logger.error('[Cron] Follow-up job error:', err.message);
  }
});

// 3. VAPI scheduled calls: every 30 minutes — execute pending outbound calls
cron.schedule('*/30 * * * *', async () => {
  try {
    const pool = require('./db/pool');
    const { placeVapiCall } = require('./services/vapiCampaignService');
    const pending = await pool.query(`
      SELECT id, phone, name, city
      FROM listings
      WHERE call_scheduled_at IS NOT NULL
        AND call_scheduled_at <= NOW()
        AND message_status != 'called'
      LIMIT 10
    `).catch(() => ({ rows: [] }));
    for (const listing of pending.rows) {
      try {
        await placeVapiCall({ phone: listing.phone, leadName: listing.name, leadCity: listing.city, scriptType: 'general' });
        await pool.query(`UPDATE listings SET call_scheduled_at = NULL, message_status = 'called', updated_at = NOW() WHERE id = $1`, [listing.id]);
        logger.info(`[Cron] VAPI call placed for listing ${listing.id}`);
      } catch (callErr) {
        logger.error(`[Cron] VAPI call failed for listing ${listing.id}:`, callErr.message);
        await pool.query(`UPDATE listings SET call_scheduled_at = NULL, updated_at = NOW() WHERE id = $1`, [listing.id]).catch(() => {});
      }
    }
    if (pending.rows.length > 0) logger.info(`[Cron] VAPI scheduled calls: processed ${pending.rows.length}`);
  } catch (err) {
    logger.error('[Cron] VAPI scheduled calls error:', err.message);
  }
});

// 4. Zoho outreach escalation: every 30 minutes — escalate leads with no WA reply after 3 hours
cron.schedule('*/30 * * * *', async () => {
  try {
    const zoho = require('./services/zohoCrmService');
    const leads = await zoho.getLeadsReadyForEscalation();
    if (!leads.length) return;

    logger.info(`[Scheduler] Escalating ${leads.length} Zoho leads to Vapi calls`);

    const VAPI_API_KEY         = process.env.VAPI_API_KEY || '';
    const VAPI_ASSISTANT_COLD  = process.env.VAPI_ASSISTANT_COLD || process.env.VAPI_ASSISTANT_ID || '';
    const VAPI_PHONE_NUMBER_ID = process.env.VAPI_PHONE_NUMBER_ID || '';

    for (const lead of leads) {
      if (!VAPI_API_KEY || !VAPI_ASSISTANT_COLD) {
        logger.warn('[Scheduler] Vapi not configured — skipping call escalation');
        break;
      }

      const phone = lead.phone.replace(/[^0-9]/g, '');
      const normalized = phone.startsWith('972') ? phone : phone.startsWith('0') ? '972' + phone.slice(1) : '972' + phone;

      const callPayload = {
        assistantId: VAPI_ASSISTANT_COLD,
        customer: { number: '+' + normalized },
        assistantOverrides: {
          variableValues: {
            lead_name: lead.contact_name || 'לקוח',
            lead_city: lead.city || '',
          },
        },
      };
      if (VAPI_PHONE_NUMBER_ID) callPayload.phoneNumberId = VAPI_PHONE_NUMBER_ID;

      try {
        const resp = await fetch('https://api.vapi.ai/call/phone', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${VAPI_API_KEY}` },
          body: JSON.stringify(callPayload),
        });
        const data = await resp.json();
        if (resp.ok) {
          await zoho.updateLeadStatus(lead.id, 'call_sent', {
            call_sent_at: new Date(),
            notes: `Auto-escalated after 3h. call_id=${data.id}`,
          });
          logger.info(`[Scheduler] Called lead ${lead.id} (${lead.phone})`);
        } else {
          await zoho.updateLeadStatus(lead.id, 'call_failed', { notes: `Vapi error: ${data.message}` });
        }
      } catch (err) {
        logger.error(`[Scheduler] Vapi call error for lead ${lead.id}:`, err.message);
      }

      await new Promise(r => setTimeout(r, 500));
    }
  } catch (err) {
    logger.error('[Scheduler] Zoho escalation job error:', err.message);
  }
});

// 5. Moderation scan: every 15 minutes
cron.schedule('*/15 * * * *', async () => {
  try {
    if (!process.env.META_ACCESS_TOKEN) return;
    const { runModerationScan } = require('./services/moderationService');
    const result = await runModerationScan();
    if (result.flagged > 0) {
      logger.info(`[Scheduler] Moderation scan: ${result.total} comments, ${result.flagged} flagged`);
    }
  } catch (err) {
    logger.error('[Scheduler] Moderation scan error:', err.message);
  }
});

// ── Incoming WhatsApp Polling ─────────────────────────────────────────────────
// Polls INFORU every 10 seconds for incoming messages → routes to Claude (botRoutes)
const { pollingService } = require('./services/whatsappPollingService');
setTimeout(() => {
  pollingService.start();
  logger.info('[QUANTUM Bot] WhatsApp polling started');
}, 5000);  // wait 5s for server to fully init

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  logger.info(`[QUANTUM Bot] Running on port ${PORT}`);
  logger.info(`[QUANTUM Bot] Business line: ${process.env.INFORU_BUSINESS_LINE || '037572229'}`);
  logger.info(`[QUANTUM Bot] VAPI: ${process.env.VAPI_PHONE_NUMBER_ID ? 'configured' : 'NOT SET — outbound calls disabled'}`);
  logger.info(`[QUANTUM Bot] Claude: ${process.env.ANTHROPIC_API_KEY ? 'configured' : 'NOT SET — AI responses disabled'}`);
  logger.info(`[QUANTUM Bot] Features: Zoho Outreach (3h escalation), Moderation (FB+IG)`);
});
