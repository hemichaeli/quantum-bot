const express = require('express');
const router = express.Router();
const { logger } = require('../services/logger');

let quantumResponseHandler;
let pollingService;
try {
  quantumResponseHandler = require('../services/quantumResponseHandler');
  pollingService = require('../services/whatsappPollingService').pollingService;
} catch (err) {
  logger.warn('Response services not available', { error: err.message });
}

// ==================== CONVERSATIONS MANAGEMENT ====================

// Get all conversations with filtering and pagination
router.get('/conversations', async (req, res) => {
  try {
    const { status, page = 1, limit = 20, phone } = req.query;
    const offset = (page - 1) * limit;
    
    let whereClause = '';
    const params = [limit, offset];
    let paramCount = 2;

    if (status) {
      whereClause += ` WHERE status = $${++paramCount}`;
      params.push(status);
    }

    if (phone) {
      whereClause += whereClause ? ' AND' : ' WHERE';
      whereClause += ` phone LIKE $${++paramCount}`;
      params.push(`%${phone}%`);
    }

    const pool = require('../db/pool');
    
    // Get conversations with message counts
    const query = `
      SELECT 
        c.*,
        COUNT(m.id) as message_count,
        MAX(m.created_at) as last_message_time,
        (SELECT COUNT(*) FROM whatsapp_messages m2 
         WHERE m2.conversation_id = c.id AND m2.direction = 'incoming') as incoming_messages,
        (SELECT COUNT(*) FROM whatsapp_messages m3 
         WHERE m3.conversation_id = c.id AND m3.direction = 'outgoing') as outgoing_messages
      FROM whatsapp_conversations c
      LEFT JOIN whatsapp_messages m ON c.id = m.conversation_id
      ${whereClause}
      GROUP BY c.id
      ORDER BY c.updated_at DESC
      LIMIT $1 OFFSET $2
    `;

    const result = await pool.query(query, params);
    
    // Get total count
    const countQuery = `
      SELECT COUNT(*) FROM whatsapp_conversations c ${whereClause}
    `;
    const countResult = await pool.query(countQuery, params.slice(2));
    
    res.json({
      conversations: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count),
        totalPages: Math.ceil(countResult.rows[0].count / limit)
      }
    });
  } catch (err) {
    logger.error('Failed to get conversations', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Get specific conversation with full message history
router.get('/conversations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const pool = require('../db/pool');
    
    // Get conversation details
    const convResult = await pool.query(`
      SELECT * FROM whatsapp_conversations WHERE id = $1
    `, [id]);
    
    if (convResult.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    
    // Get all messages in conversation
    const messagesResult = await pool.query(`
      SELECT * FROM whatsapp_messages 
      WHERE conversation_id = $1 
      ORDER BY created_at ASC
    `, [id]);
    
    res.json({
      conversation: convResult.rows[0],
      messages: messagesResult.rows
    });
  } catch (err) {
    logger.error('Failed to get conversation', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Update conversation status or transfer to agent
router.put('/conversations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, agent_transferred, notes } = req.body;
    
    const pool = require('../db/pool');
    await pool.query(`
      UPDATE whatsapp_conversations 
      SET 
        status = COALESCE($1, status),
        agent_transferred = COALESCE($2, agent_transferred),
        notes = COALESCE($3, notes),
        updated_at = NOW()
      WHERE id = $4
    `, [status, agent_transferred, notes, id]);
    
    res.json({ success: true, message: 'Conversation updated' });
  } catch (err) {
    logger.error('Failed to update conversation', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Send manual message in conversation
router.post('/conversations/:id/message', async (req, res) => {
  try {
    const { id } = req.params;
    const { message, agent_name = 'Manual' } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }
    
    const pool = require('../db/pool');
    
    // Get conversation phone number
    const convResult = await pool.query(`
      SELECT phone FROM whatsapp_conversations WHERE id = $1
    `, [id]);
    
    if (convResult.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    
    const phone = convResult.rows[0].phone;
    
    // Send WhatsApp message
    const inforuService = require('../services/inforuService');
    const result = await inforuService.sendWhatsAppChat(phone, message, {
      source: 'manual_agent',
      agent: agent_name,
      conversationId: id
    });
    
    if (result.success) {
      // Log the message
      await pool.query(`
        INSERT INTO whatsapp_messages (conversation_id, direction, message, created_at)
        VALUES ($1, 'outgoing', $2, NOW())
      `, [id, message]);
      
      // Mark as agent handled
      await pool.query(`
        UPDATE whatsapp_conversations 
        SET agent_transferred = TRUE, status = 'agent_handling', updated_at = NOW()
        WHERE id = $1
      `, [id]);
    }
    
    res.json(result);
  } catch (err) {
    logger.error('Failed to send manual message', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ==================== AGENT NOTIFICATIONS ====================

// Get pending agent notifications
router.get('/notifications', async (req, res) => {
  try {
    const { priority, handled = 'false' } = req.query;
    
    let whereClause = handled === 'false' ? 'WHERE handled = FALSE' : '';
    const params = [];
    let paramCount = 0;

    if (priority && handled === 'false') {
      whereClause += ` AND priority = $${++paramCount}`;
      params.push(priority);
    } else if (priority) {
      whereClause = `WHERE priority = $${++paramCount}`;
      params.push(priority);
    }

    const pool = require('../db/pool');
    const result = await pool.query(`
      SELECT 
        n.*,
        c.phone,
        c.status as conversation_status
      FROM agent_notifications n
      LEFT JOIN whatsapp_conversations c ON n.conversation_id = c.id
      ${whereClause}
      ORDER BY 
        CASE WHEN priority = 'urgent' THEN 1 
             WHEN priority = 'high' THEN 2 
             ELSE 3 END,
        created_at DESC
      LIMIT 50
    `, params);
    
    res.json({ notifications: result.rows });
  } catch (err) {
    logger.error('Failed to get notifications', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Mark notification as handled
router.put('/notifications/:id/handled', async (req, res) => {
  try {
    const { id } = req.params;
    const { agent_name } = req.body;
    
    const pool = require('../db/pool');
    await pool.query(`
      UPDATE agent_notifications 
      SET handled = TRUE, handled_by = $1, handled_at = NOW()
      WHERE id = $2
    `, [agent_name || 'Unknown', id]);
    
    res.json({ success: true });
  } catch (err) {
    logger.error('Failed to mark notification as handled', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ==================== AUTO-RESPONSE MANAGEMENT ====================

// Get response handler status and statistics
router.get('/auto-response/status', (req, res) => {
  try {
    if (!quantumResponseHandler) {
      return res.status(503).json({ 
        error: 'Response handler not available',
        available: false 
      });
    }

    res.json({
      available: true,
      patterns: Object.keys(quantumResponseHandler.responsePatterns || {}),
      note: 'Auto-response is active and processing incoming messages'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test auto-response with sample message
router.post('/auto-response/test', async (req, res) => {
  try {
    if (!quantumResponseHandler) {
      return res.status(503).json({ error: 'Response handler not available' });
    }

    const { message, phone = '0500000000' } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Simulate message processing (dry run)
    const analysis = quantumResponseHandler.analyzeMessage(message);
    const mockConversation = { 
      id: 'test', 
      phone, 
      status: 'active', 
      agent_transferred: false 
    };
    
    const response = await quantumResponseHandler.generateResponse(analysis, mockConversation);
    
    res.json({
      input: message,
      analysis,
      response,
      note: 'This is a test - no actual message was sent'
    });
  } catch (err) {
    logger.error('Failed to test auto-response', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ==================== POLLING SERVICE CONTROL ====================

// Get polling service status
router.get('/polling/status', (req, res) => {
  try {
    if (!pollingService) {
      return res.status(503).json({ error: 'Polling service not available' });
    }

    res.json({
      ...pollingService.getStatus(),
      metrics: pollingService.getMetrics()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start/stop polling service
router.post('/polling/:action', async (req, res) => {
  try {
    if (!pollingService) {
      return res.status(503).json({ error: 'Polling service not available' });
    }

    const { action } = req.params;
    
    switch (action) {
      case 'start':
        await pollingService.start();
        res.json({ message: 'Polling service started' });
        break;
      case 'stop':
        await pollingService.stop();
        res.json({ message: 'Polling service stopped' });
        break;
      case 'restart':
        await pollingService.restartPolling();
        res.json({ message: 'Polling service restarted' });
        break;
      default:
        res.status(400).json({ error: 'Invalid action. Use: start, stop, restart' });
    }
  } catch (err) {
    logger.error(`Failed to ${req.params.action} polling service`, { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ==================== ANALYTICS & INSIGHTS ====================

// Conversation analytics
router.get('/analytics', async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const pool = require('../db/pool');
    
    // Overall statistics
    const statsResult = await pool.query(`
      SELECT 
        COUNT(*) as total_conversations,
        COUNT(CASE WHEN status = 'active' THEN 1 END) as active_conversations,
        COUNT(CASE WHEN status = 'agent_handling' THEN 1 END) as agent_conversations,
        COUNT(CASE WHEN status = 'unsubscribed' THEN 1 END) as unsubscribed,
        COUNT(CASE WHEN agent_transferred = TRUE THEN 1 END) as transferred_to_agent,
        AVG(
          CASE WHEN status != 'active' 
          THEN EXTRACT(EPOCH FROM (updated_at - created_at))/3600 
          END
        ) as avg_resolution_hours
      FROM whatsapp_conversations
      WHERE created_at >= NOW() - INTERVAL '${parseInt(days)} days'
    `);

    // Message volume by day
    const volumeResult = await pool.query(`
      SELECT 
        DATE(c.created_at) as date,
        COUNT(DISTINCT c.id) as conversations,
        COUNT(m.id) as total_messages,
        COUNT(CASE WHEN m.direction = 'incoming' THEN 1 END) as incoming,
        COUNT(CASE WHEN m.direction = 'outgoing' THEN 1 END) as outgoing
      FROM whatsapp_conversations c
      LEFT JOIN whatsapp_messages m ON c.id = m.conversation_id
      WHERE c.created_at >= NOW() - INTERVAL '${parseInt(days)} days'
      GROUP BY DATE(c.created_at)
      ORDER BY date DESC
    `);

    // Response categories
    const categoriesResult = await pool.query(`
      SELECT 
        last_message_category,
        COUNT(*) as count
      FROM whatsapp_conversations
      WHERE last_message_category IS NOT NULL
        AND created_at >= NOW() - INTERVAL '${parseInt(days)} days'
      GROUP BY last_message_category
      ORDER BY count DESC
    `);

    res.json({
      timeframe: `${days} days`,
      overall: statsResult.rows[0],
      daily_volume: volumeResult.rows,
      response_categories: categoriesResult.rows,
      generated_at: new Date().toISOString()
    });
  } catch (err) {
    logger.error('Failed to get conversation analytics', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Export conversations to CSV
router.get('/export/conversations', async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const pool = require('../db/pool');
    
    const result = await pool.query(`
      SELECT 
        c.phone,
        c.status,
        c.last_message_category,
        c.agent_transferred,
        c.created_at,
        c.updated_at,
        COUNT(m.id) as message_count
      FROM whatsapp_conversations c
      LEFT JOIN whatsapp_messages m ON c.id = m.conversation_id
      WHERE c.created_at >= NOW() - INTERVAL '${parseInt(days)} days'
      GROUP BY c.id, c.phone, c.status, c.last_message_category, c.agent_transferred, c.created_at, c.updated_at
      ORDER BY c.created_at DESC
    `);

    // Convert to CSV
    const csvHeader = 'Phone,Status,Category,Agent Transferred,Created,Updated,Messages\n';
    const csvData = result.rows.map(row => 
      `"${row.phone}","${row.status}","${row.last_message_category || ''}","${row.agent_transferred}","${row.created_at}","${row.updated_at}","${row.message_count}"`
    ).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="quantum_conversations_${days}days.csv"`);
    res.send(csvHeader + csvData);
  } catch (err) {
    logger.error('Failed to export conversations', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
