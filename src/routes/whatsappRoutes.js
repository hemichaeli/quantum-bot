const express = require('express');
const router = express.Router();
const { logger } = require('../services/logger');
const pool = require('../db/pool');

// POST /api/whatsapp/webhook - Receive incoming messages from INFORU
router.post('/webhook', async (req, res) => {
  try {
    const startTime = Date.now();
    logger.info('[WHATSAPP WEBHOOK] Received payload:', {
      customerId: req.body.CustomerId,
      projectId: req.body.ProjectId,
      dataCount: req.body.Data?.length || 0
    });

    if (!req.body.Data || !Array.isArray(req.body.Data)) {
      logger.warn('[WHATSAPP WEBHOOK] Invalid payload - missing Data array');
      return res.status(400).json({ error: 'Invalid payload', message: 'Data array is required' });
    }

    const results = [];
    for (const message of req.body.Data) {
      try {
        const result = await processIncomingMessage(message);
        results.push(result);
      } catch (error) {
        logger.error('[WHATSAPP WEBHOOK] Failed to process message:', error);
        results.push({ status: 'error', phone: message.Value, error: error.message });
      }
    }

    const duration = Date.now() - startTime;
    logger.info(`[WHATSAPP WEBHOOK] Processed ${results.length} messages in ${duration}ms`);
    res.status(200).json({ status: 'ok', processed: results.length, duration: `${duration}ms`, results });
  } catch (error) {
    logger.error('[WHATSAPP WEBHOOK] Unexpected error:', error);
    res.status(200).json({ status: 'error', message: error.message });
  }
});

async function processIncomingMessage(message) {
  const {
    Value: phoneNumber,
    Message: text,
    Keyword: keyword,
    Network: network,
    ShortCode: businessNumber,
    CustomerParam: messageId,
    MoSessionId: sessionId,
    AdditionalInfo: additionalInfo
  } = message;

  logger.info('[WHATSAPP MESSAGE]', {
    from: phoneNumber,
    to: businessNumber,
    text,
    keyword,
    messageId: messageId?.substring(0, 20) + '...'
  });

  let accountInfo = {};
  try {
    if (additionalInfo && typeof additionalInfo === 'string') {
      accountInfo = JSON.parse(additionalInfo);
    }
  } catch (e) {
    logger.warn('[WHATSAPP MESSAGE] Failed to parse AdditionalInfo:', e.message);
  }

  // Save incoming message to DB
  try {
    const convResult = await pool.query(
      `INSERT INTO whatsapp_conversations (phone, status, source, created_at, updated_at)
       VALUES ($1, 'active', 'incoming', NOW(), NOW())
       ON CONFLICT (phone) DO UPDATE SET updated_at = NOW(), status = 'active'
       RETURNING id`,
      [phoneNumber]
    );
    const conversationId = convResult.rows[0]?.id;
    if (conversationId) {
      await pool.query(
        `INSERT INTO whatsapp_messages (conversation_id, phone, direction, message, status, created_at)
         VALUES ($1, $2, 'incoming', $3, 'received', NOW())`,
        [conversationId, phoneNumber, text || '']
      );
    }
  } catch (err) {
    logger.warn('[WHATSAPP MESSAGE] Could not save to DB:', err.message);
  }

  const intent = detectIntent(text, keyword);
  logger.info('[WHATSAPP MESSAGE] Detected intent:', { phone: phoneNumber, intent, text });
  return { status: 'processed', phone: phoneNumber, intent, messageId: messageId?.substring(0, 20) + '...' };
}

function detectIntent(text, keyword) {
  const lowerText = (text || '').toLowerCase();
  if (/^(שלום|היי|הי|בוקר טוב|ערב טוב|hello|hi|hey)/i.test(lowerText)) return 'greeting';
  if (/^(עזרה|מידע|help|info|\?)/i.test(lowerText)) return 'help';
  if (/^\d+$/.test(lowerText.trim())) return 'menu_selection';
  return 'unknown';
}

// GET /api/whatsapp/status
router.get('/status', (req, res) => {
  res.json({ status: 'ok', webhook: '/api/whatsapp/webhook', method: 'POST', format: 'INFORU', timestamp: new Date().toISOString() });
});

// GET /api/whatsapp/conversations - list all conversations grouped by phone (Issue #6)
router.get('/conversations', async (req, res) => {
  try {
    const { search, status } = req.query;

    // Unified: count messages by both conversation_id and phone (handles outgoing from autoFirstContact)
    let query = `
      SELECT
        wc.id,
        wc.phone,
        wc.status,
        wc.source,
        wc.updated_at,
        wc.created_at,
        COALESCE(l.contact_name, wc.phone) as display_name,
        l.address as listing_address,
        l.city as listing_city,
        (
          SELECT message FROM whatsapp_messages
          WHERE (conversation_id = wc.id OR phone = wc.phone)
          ORDER BY created_at DESC LIMIT 1
        ) as last_message,
        (
          SELECT direction FROM whatsapp_messages
          WHERE (conversation_id = wc.id OR phone = wc.phone)
          ORDER BY created_at DESC LIMIT 1
        ) as last_direction,
        (
          SELECT COUNT(*) FROM whatsapp_messages
          WHERE (conversation_id = wc.id OR phone = wc.phone) AND direction = 'incoming'
        )::int as incoming_count,
        (
          SELECT COUNT(*) FROM whatsapp_messages
          WHERE (conversation_id = wc.id OR phone = wc.phone)
        )::int as message_count
      FROM whatsapp_conversations wc
      LEFT JOIN listings l ON l.phone = wc.phone AND l.is_active = TRUE
      WHERE 1=1`;

    const params = [];
    let n = 1;
    if (status) { query += ` AND wc.status = $${n}`; params.push(status); n++; }
    if (search?.trim()) {
      query += ` AND (wc.phone ILIKE $${n} OR COALESCE(l.contact_name,'') ILIKE $${n} OR COALESCE(l.address,'') ILIKE $${n})`;
      params.push('%' + search.trim() + '%'); n++;
    }
    query += ` ORDER BY wc.updated_at DESC LIMIT 100`;

    const result = await pool.query(query, params);
    res.json({ success: true, conversations: result.rows, total: result.rows.length });
  } catch (error) {
    logger.error('[Conversations] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/whatsapp/conversations/:phone/messages - all messages for a phone (Issue #6)
// Fixed: queries by BOTH conversation_id and phone to catch outgoing messages from autoFirstContact
router.get('/conversations/:phone/messages', async (req, res) => {
  try {
    const phone = req.params.phone;

    // Find or upsert conversation
    const convResult = await pool.query(
      `SELECT id FROM whatsapp_conversations WHERE phone = $1 LIMIT 1`,
      [phone]
    );

    let convId = convResult.rows[0]?.id || null;

    // Query messages by both conversation_id AND phone (catches autoFirstContact outgoing messages)
    const messages = await pool.query(
      `SELECT id, COALESCE(conversation_id, 0) as conversation_id, phone, direction,
              COALESCE(message, '') as message, status, created_at
       FROM whatsapp_messages
       WHERE (${convId ? `conversation_id = $1 OR ` : ''}phone = $${convId ? 2 : 1})
       ORDER BY created_at ASC`,
      convId ? [convId, phone] : [phone]
    );

    let convInfo = null;
    if (convId) {
      const convRow = await pool.query(
        `SELECT wc.*, COALESCE(l.contact_name, wc.phone) as display_name, l.address, l.city
         FROM whatsapp_conversations wc
         LEFT JOIN listings l ON l.phone = wc.phone AND l.is_active = TRUE
         WHERE wc.id = $1 LIMIT 1`,
        [convId]
      );
      convInfo = convRow.rows[0] || null;
    }

    res.json({ success: true, data: messages.rows, total: messages.rows.length, conversation: convInfo });
  } catch (error) {
    logger.error('[ConvMessages] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/whatsapp/conversations/:phone/reply - send reply to a conversation
router.post('/conversations/:phone/reply', async (req, res) => {
  try {
    const phone = req.params.phone;
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    const axios = require('axios');
    const INFORU_USERNAME = process.env.INFORU_USERNAME || 'hemichaeli';
    const INFORU_TOKEN = process.env.INFORU_TOKEN || '95452ace-07cf-48be-8671-a197c15d3c17';
    const INFORU_BUSINESS_LINE = process.env.INFORU_BUSINESS_LINE || '037572229';

    let cleanPhone = phone.replace(/[^0-9]/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '972' + cleanPhone.substring(1);
    if (!cleanPhone.startsWith('972')) cleanPhone = '972' + cleanPhone;

    const payload = {
      Data: { Message: message, Recipients: [{ Phone: cleanPhone }] },
      Settings: { BusinessLine: INFORU_BUSINESS_LINE },
      Authentication: { Username: INFORU_USERNAME, ApiToken: INFORU_TOKEN }
    };

    const resp = await axios.post('https://capi.inforu.co.il/api/v2/WhatsApp/SendWhatsAppChat', payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });

    const success = resp.data?.Status === 'SUCCESS' || resp.status === 200;

    if (success) {
      // Save outgoing message
      await pool.query(
        `INSERT INTO whatsapp_messages (phone, direction, message, status, created_at)
         VALUES ($1, 'outgoing', $2, 'sent', NOW())`,
        [phone, message]
      ).catch(() => null);

      // Update conversation timestamp
      await pool.query(
        `INSERT INTO whatsapp_conversations (phone, status, updated_at, created_at)
         VALUES ($1, 'active', NOW(), NOW())
         ON CONFLICT (phone) DO UPDATE SET updated_at = NOW()`,
        [phone]
      ).catch(() => null);
    }

    res.json({ success, phone, inforu: resp.data });
  } catch (error) {
    logger.error('[ConvReply] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
