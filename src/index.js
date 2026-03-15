/**
 * QUANTUM Bot — Main Entry Point
 *
 * Responsibilities:
 *  1. Auto first-contact WhatsApp to new listing publishers (Yad2 / Facebook / Kones)
 *  2. Follow-up reminders if no reply (configurable intervals)
 *  3. VAPI outbound call if still no reply after N reminders
 *  4. Incoming WhatsApp polling → route to conversation handler
 *
 * Data source: pinuy-binuy-analyzer PostgreSQL (DATABASE_URL)
 * Outbound channel: INFORU CAPI (QUANTUM business line)
 * Voice calls: VAPI AI
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
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    env: {
      inforu: !!(process.env.INFORU_USERNAME && process.env.INFORU_PASSWORD),
      vapi: !!process.env.VAPI_API_KEY,
      db: !!process.env.DATABASE_URL,
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

// WhatsApp follow-up: every hour check for leads with no reply > 24h
cron.schedule('0 * * * *', async () => {
  try {
    const { runFollowUp } = require('./jobs/whatsappFollowUp');
    await runFollowUp();
    logger.info('[Scheduler] WhatsApp follow-up job completed');
  } catch (err) {
    logger.error('[Scheduler] Follow-up job error:', err.message);
  }
});

// Incoming WhatsApp polling: every 30 seconds
const { startPolling } = require('./services/whatsappPollingService');
startPolling();

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  logger.info(`[QUANTUM Bot] Running on port ${PORT}`);
});
