const { logger } = require('./logger');

let inforuService;
let quantumResponseHandler;
try {
  inforuService = require('./inforuService');
  quantumResponseHandler = require('./quantumResponseHandler');
} catch (err) {
  logger.warn('Services not available for polling', { error: err.message });
}

/**
 * QUANTUM WhatsApp Polling Service
 * Polls INFORU for incoming messages and routes them to Claude AI (botRoutes)
 * Falls back to pattern-matching handler if Claude is unavailable
 */

class WhatsAppPollingService {
  constructor() {
    this.isPolling = false;
    this.pollInterval = 10000; // 10 seconds
    this.intervalId = null;
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 5;
    this.messagesProcessed = 0;
    this.lastSuccessfulPoll = null;
  }

  async start() {
    if (this.isPolling || !inforuService) {
      logger.warn('WhatsApp polling already running or INFORU not available');
      return;
    }

    logger.info('Starting QUANTUM WhatsApp polling with auto-response', { 
      interval: this.pollInterval,
      responseHandler: !!quantumResponseHandler
    });
    
    this.isPolling = true;
    this.consecutiveErrors = 0;

    // Start polling immediately, then every interval
    await this.pollOnce();
    this.intervalId = setInterval(() => this.pollOnce(), this.pollInterval);
  }

  async stop() {
    if (!this.isPolling) return;

    logger.info('Stopping QUANTUM WhatsApp polling');
    this.isPolling = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async pollOnce() {
    if (!this.isPolling || !inforuService) return;

    try {
      // Pull incoming WhatsApp messages
      const incoming = await inforuService.pullIncomingWhatsApp(50);
      
      if (incoming.StatusId === 1 && incoming.Data?.List?.length > 0) {
        logger.info(`📥 Received ${incoming.Data.List.length} incoming WhatsApp messages`);
        
        // Process each message through QUANTUM Response Handler
        for (const message of incoming.Data.List) {
          await this.processIncomingMessage(message);
          this.messagesProcessed++;
        }
      }

      // Pull delivery reports
      const dlr = await inforuService.pullWhatsAppDLR(50);
      if (dlr.StatusId === 1 && dlr.Data?.List?.length > 0) {
        logger.info(`📋 Received ${dlr.Data.List.length} WhatsApp delivery reports`);
        
        for (const report of dlr.Data.List) {
          await this.processDeliveryReport(report);
        }
      }

      // Update success metrics
      this.consecutiveErrors = 0;
      this.lastSuccessfulPoll = new Date();

    } catch (err) {
      this.consecutiveErrors++;
      logger.error('WhatsApp polling error', { 
        error: err.message, 
        consecutiveErrors: this.consecutiveErrors 
      });

      // Stop polling if too many consecutive errors
      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        logger.error('❌ Too many consecutive polling errors, stopping service');
        await this.stop();
      }
    }
  }

  async processIncomingMessage(message) {
    try {
      const phone = message.Phone;
      const text = message.Message || '';
      const timestamp = message.Timestamp;
      const messageId = message.MessageId;

      logger.info('📱 Processing incoming WhatsApp message', {
        from: phone,
        preview: text.substring(0, 50) + (text.length > 50 ? '...' : ''),
        messageId: messageId
      });

      // Enhanced message data
      const messageData = {
        phone: phone,
        message: text,
        customerMessageId: messageId,
        timestamp: timestamp,
        source: 'whatsapp_incoming',
        rawData: message
      };

      // Route to Claude AI first, fall back to pattern handler, then basic fallback
      const claudeHandled = await this.routeToClaude(phone, text, messageData);
      if (!claudeHandled) {
        if (quantumResponseHandler) {
          const result = await quantumResponseHandler.processIncomingMessage(messageData);
          logger.info(`✅ Message processed via pattern handler`, {
            phone: phone,
            category: result.analysis?.category,
            responded: !!result.response,
          });
        } else {
          logger.warn('No handler available, using basic fallback');
          await this.fallbackToBasicBot(phone, text, messageData);
        }
      }

    } catch (err) {
      logger.error('❌ Error processing incoming WhatsApp message', { 
        error: err.message, 
        phone: message.Phone,
        stack: err.stack
      });
      
      // Send error message to user
      try {
        await inforuService.sendWhatsAppChat(
          message.Phone, 
          '🤖 מתנצל על התקלה הטכנית. נציג QUANTUM יחזור אליך בהקדם.',
          { source: 'error_fallback' }
        );
      } catch (replyErr) {
        logger.error('Failed to send error reply', { error: replyErr.message });
      }
    }
  }

  async processDeliveryReport(report) {
    try {
      logger.info('📊 Processing WhatsApp delivery report', {
        phone: report.Phone,
        status: report.Status,
        messageId: report.MessageId,
        timestamp: report.Timestamp
      });

      // Update database with delivery status
      try {
        const pool = require('../db/pool');
        await pool.query(`
          UPDATE sent_messages 
          SET 
            status = CASE 
              WHEN $1 = 'delivered' THEN 'delivered'
              WHEN $1 = 'read' THEN 'read'
              WHEN $1 = 'failed' THEN 'failed'
              ELSE 'sent'
            END,
            updated_at = NOW()
          WHERE platform_message_id = $2
        `, [report.Status, report.MessageId]);
      } catch (dbErr) {
        logger.error('Failed to update delivery status in DB:', dbErr);
      }

    } catch (err) {
      logger.error('❌ Error processing WhatsApp delivery report', { 
        error: err.message, 
        report: report 
      });
    }
  }

  // Route to Claude AI (uses ranScript VAPI_SYSTEM_PROMPT for sales conversation)
  async routeToClaude(phone, text, metadata) {
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_API_KEY) return false;
    try {
      const axios = require('axios');
      const pool  = require('../db/pool');
      const { VAPI_SYSTEM_PROMPT } = require('./ranScript');
      // Upsert lead
      const leadRes = await pool.query(`
        INSERT INTO leads (phone, source, status, created_at, updated_at)
        VALUES ($1, 'whatsapp_bot', 'active', NOW(), NOW())
        ON CONFLICT (phone) DO UPDATE SET status = 'active', updated_at = NOW()
        RETURNING id
      `, [phone]).catch(() => null);
      const leadId = leadRes?.rows?.[0]?.id;
      // Save incoming message
      if (leadId) {
        await pool.query(`
          INSERT INTO whatsapp_conversations (lead_id, sender, message, created_at)
          VALUES ($1, 'user', $2, NOW())
        `, [leadId, text]).catch(() => {});
      }
      // Get conversation history (last 10 turns)
      const histRes = await pool.query(`
        SELECT sender, message FROM whatsapp_conversations
        WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 10
      `, [leadId]).catch(() => ({ rows: [] }));
      const history = (histRes.rows || []).reverse().map(r => ({
        role: r.sender === 'user' ? 'user' : 'assistant',
        content: r.message
      }));
      if (history.length === 0) history.push({ role: 'user', content: text });
      // Call Claude Sonnet
      const claudeRes = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-sonnet-4-5',
        max_tokens: 500,
        system: VAPI_SYSTEM_PROMPT,
        messages: history
      }, {
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        timeout: 12000
      });
      const reply = claudeRes.data?.content?.[0]?.text;
      if (reply) {
        await inforuService.sendWhatsAppChat(phone, reply, { source: 'claude_bot' });
        if (leadId) {
          await pool.query(`
            INSERT INTO whatsapp_conversations (lead_id, sender, message, created_at)
            VALUES ($1, 'bot', $2, NOW())
          `, [leadId, reply]).catch(() => {});
        }
        logger.info(`✅ Claude reply sent to ${phone} (lead ${leadId})`);
        return true;
      }
    } catch (err) {
      logger.error('[Claude] Error routing message:', err.message);
    }
    return false;
  }

  // Fallback method if Claude and pattern handler are not available
  async fallbackToBasicBot(phone, text, metadata) {
    try {
      // Simple auto-response
      const basicResponse = text.toLowerCase().includes('לא') || text.toLowerCase().includes('stop') 
        ? 'הבנתי. תודה שהשבת. לא נכתוב יותר.'
        : 'תודה שכתבת! נציג QUANTUM יחזור אליך בהקדם.';

      await inforuService.sendWhatsAppChat(phone, basicResponse, {
        source: 'basic_fallback'
      });

      logger.info(`📤 Sent basic fallback response to ${phone}`);

    } catch (err) {
      logger.error('❌ Fallback response failed', { error: err.message, phone });
    }
  }

  // ==================== STATUS & METRICS ====================

  getStatus() {
    return {
      isPolling: this.isPolling,
      intervalMs: this.pollInterval,
      consecutiveErrors: this.consecutiveErrors,
      messagesProcessed: this.messagesProcessed,
      lastSuccessfulPoll: this.lastSuccessfulPoll,
      uptime: this.lastSuccessfulPoll ? Date.now() - this.lastSuccessfulPoll.getTime() : null,
      services: {
        inforuAvailable: !!inforuService,
        responseHandlerAvailable: !!quantumResponseHandler
      },
      health: this.consecutiveErrors < this.maxConsecutiveErrors ? 'healthy' : 'degraded'
    };
  }

  getMetrics() {
    return {
      messagesProcessed: this.messagesProcessed,
      consecutiveErrors: this.consecutiveErrors,
      isPolling: this.isPolling,
      lastPoll: this.lastSuccessfulPoll,
      errorRate: this.messagesProcessed > 0 ? (this.consecutiveErrors / this.messagesProcessed) : 0
    };
  }

  async restartPolling() {
    logger.info('🔄 Restarting WhatsApp polling service');
    await this.stop();
    setTimeout(() => this.start(), 2000); // Wait 2 seconds before restart
  }
}

// Singleton instance
const pollingService = new WhatsAppPollingService();

// NOTE: polling is started explicitly from index.js via pollingService.start()
// (removed auto-start here to avoid double-start and to allow non-production environments)

// ==================== GRACEFUL SHUTDOWN ====================

process.on('SIGTERM', async () => {
  logger.info('🛑 Received SIGTERM, stopping WhatsApp polling gracefully');
  await pollingService.stop();
});

process.on('SIGINT', async () => {
  logger.info('🛑 Received SIGINT, stopping WhatsApp polling gracefully');
  await pollingService.stop();
});

module.exports = {
  WhatsAppPollingService,
  pollingService
};
