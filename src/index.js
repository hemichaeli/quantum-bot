/**
 * QUANTUM Bot — Main Entry Point
 *
 * Responsibilities:
 *  1. Auto first-contact WhatsApp to new listing publishers (Yad2 / Facebook / Kones)
 *  2. Follow-up reminders if no reply (configurable intervals)
 *  3. VAPI outbound call if still no reply after N reminders
 *  4. Incoming WhatsApp polling → route to Claude conversation handler
 *
 * Data source: pinuy-binuy-analyzer PostgreSQL (DATABASE_URL)
 * Outbound channel: INFORU CAPI (QUANTUM business line: 037572229)
 * Voice calls: VAPI AI (QUANTUM phone number)
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
    version: '1.1.0',
    timestamp: new Date().toISOString(),
    env: {
      inforu:       !!(process.env.INFORU_USERNAME && process.env.INFORU_PASSWORD),
      vapi:         !!process.env.VAPI_API_KEY,
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
//    FIX: correct export name is runFollowUpJob (was wrongly called runFollowUp)
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

// ── Incoming WhatsApp Polling ─────────────────────────────────────────────────
// Polls INFORU every 10 seconds for incoming messages → routes to Claude (botRoutes)
// FIX: correct export is pollingService (not startPolling)
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
});
