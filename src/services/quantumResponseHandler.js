const { logger } = require('./logger');
const pool = require('../db/pool');
const inforuService = require('./inforuService');

/**
 * QUANTUM WhatsApp Response Handler
 * Automated response system for incoming WhatsApp messages
 */

class QuantumResponseHandler {
  constructor() {
    this.responsePatterns = this.initializePatterns();
    this.conversationState = new Map(); // In-memory conversation tracking
  }

  // ==================== RESPONSE PATTERNS ====================
  
  initializePatterns() {
    return {
      // POSITIVE RESPONSES
      positive: {
        patterns: [
          /מעוניין/i, /כן/i, /בטח/i, /בוודאי/i, /אשמח/i, /רוצה/i,
          /מתאים/i, /נשמע טוב/i, /בסדר/i, /אוקיי/i, /ok/i, /למה לא/i,
          /מושלם/i, /מצוין/i, /בואו/i, /יאללה/i, /חכה/i, /תן לי/i
        ],
        responses: [
          'מעולה! 🎉 אני מכין לך את כל הפרטים. תקבל הודעה עם המידע המלא תוך דקות ספורות.',
          'נפלא! 🚀 אתה עושה בחירה חכמה. אני מעביר אותך לחמי מיד לטיפול אישי.',
          'מושלם! 💎 יש לי עוד פרטים חשובים לספר לך. אפשר לדבר עכשיו או שאתה מעדיף מחר?'
        ],
        nextAction: 'transfer_to_agent'
      },

      // QUESTIONS & REQUESTS FOR INFO
      questions: {
        patterns: [
          /כמה/i, /איך/i, /מתי/i, /איפה/i, /מה/i, /למה/i, /באיזה/i,
          /פרטים/i, /מידע/i, /תסביר/i, /אפשר לדעת/i, /מה זה/i,
          /קישור/i, /תמונות/i, /מחיר/i, /עלות/i, /דמי תיווך/i
        ],
        responses: [
          'שאלה מעולה! 🤔 יש הרבה מה להסביר. בוא נעשה זאת נכון - אני מעביר אותך לחמי שיענה על הכל.',
          'יש לי את כל התשובות! 📋 אבל זה יותר טוב בשיחה קצרה. חמי יתקשר אליך תוך 10 דקות.',
          'תשאל כל מה שאתה רוצה! 🗣️ חמי הוא המומחה שלנו ויש לו את כל הפרטים. מתאים לך עכשיו?'
        ],
        nextAction: 'schedule_callback'
      },

      // PRICE INQUIRIES
      pricing: {
        patterns: [
          /מחיר/i, /עולה/i, /עלות/i, /תשלום/i, /כסף/i, /דמי/i, /עמלה/i,
          /זול/i, /יקר/i, /תקציב/i, /השקעה/i, /כמה עולה/i
        ],
        responses: [
          'מצוין שאתה מתעניין במחירים! 💰 חמי יכין לך הצעת מחיר מותאמת אישית. מתאים לך שיתקשר תוך חצי שעה?',
          'נושא המחיר חשוב מאוד! 💎 יש לנו מספר אופציות מגניבות שחמי יוכל להציג לך. מתי נוח לך לשיחה?'
        ],
        nextAction: 'transfer_to_agent'
      },

      // NEGATIVE RESPONSES
      negative: {
        patterns: [
          /לא/i, /אל תטריד/i, /לא מעוניין/i, /תקח אותי/i, /מחק/i, /הסר/i,
          /עזוב/i, /לא בשבילי/i, /לא מתאים/i, /אל תכתוב/i, /STOP/i, /תפסיק/i
        ],
        responses: [
          'מובן לגמרי! 👍 תודה שהקדשת זמן לקרוא. אם תשנה דעה בעתיד, אני כאן.',
          'בסדר גמור! 😊 מחקתי אותך מהרשימה. בהצלחה עם הכל!',
          'אין בעיה בכלל! 🤝 תודה שהשבת. יום טוב!'
        ],
        nextAction: 'unsubscribe'
      },

      // TIME-BASED RESPONSES
      timing: {
        patterns: [
          /מתי/i, /זמן/i, /תתקשר/i, /מחר/i, /אחרי/i, /בערב/i, /בבוקר/i,
          /השבוע/i, /חזור אליי/i, /אני אחזור/i
        ],
        responses: [
          'בטח! ⏰ מתי הכי נוח לך? בוקר, צהריים או אחרי 17:00?',
          'ללא בעיה! 📞 תגיד לי איזה יום ואיזה שעה מתאימים לך ואני אדאג שחמי יתקשר.',
          'מעולה! 🗓️ אני רושם אותך ונחזור אליך בזמן שיתאים לך.'
        ],
        nextAction: 'schedule_callback'
      },

      // COMPLAINT/CONCERN
      concern: {
        patterns: [
          /בעיה/i, /תלונה/i, /לא עובד/i, /שגיאה/i, /כעוס/i, /מרוגז/i,
          /לא מבין/i, /מבולבל/i, /הונאה/i, /רמאות/i, /לא חוקי/i
        ],
        responses: [
          'אני מצטער שיש בעיה! 😟 זה לא מה שאנחנו רוצים. חמי יתקשר אליך תוך 5 דקות לפתור הכל.',
          'מצטער לשמוע! 💔 איכות השירות חשובה לנו מאוד. אני מעביר אותך מיד לחמי.',
        ],
        nextAction: 'urgent_transfer'
      },

      // DEFAULT FALLBACK
      fallback: {
        patterns: [],
        responses: [
          'תודה שכתבת! 📝 אני מעביר את ההודעה שלך לחמי שיחזור אליך בהקדם.',
          'קיבלתי! ✅ חמי יקרא את מה שכתבת ויחזור אליך תוך זמן קצר.',
          'הודעתך התקבלה! 💬 חמי יטפל בזה אישית וישוב אליך בקרוב.'
        ],
        nextAction: 'transfer_to_agent'
      }
    };
  }

  // ==================== MESSAGE PROCESSING ====================

  async processIncomingMessage(messageData) {
    try {
      const { phone, message, customerMessageId, timestamp } = messageData;
      
      logger.info(`Processing incoming message from ${phone}: "${message}"`);

      // Clean phone number
      const cleanPhone = this.normalizePhone(phone);
      
      // Get or create conversation
      const conversation = await this.getOrCreateConversation(cleanPhone);
      
      // Analyze message and determine response
      const analysis = this.analyzeMessage(message);
      
      // Log incoming message
      await this.logMessage(conversation.id, 'incoming', message, customerMessageId);
      
      // Generate and send response
      const response = await this.generateResponse(analysis, conversation);
      
      if (response) {
        await this.sendResponse(cleanPhone, response);
        await this.logMessage(conversation.id, 'outgoing', response.message);
      }
      
      // Update conversation state
      await this.updateConversationState(conversation, analysis);
      
      // Execute next action
      await this.executeNextAction(analysis.nextAction, conversation, message);
      
      return { success: true, analysis, response };
      
    } catch (error) {
      logger.error('Failed to process incoming message:', error);
      throw error;
    }
  }

  analyzeMessage(message) {
    const text = message.trim().toLowerCase();
    
    // Check each pattern category
    for (const [category, config] of Object.entries(this.responsePatterns)) {
      for (const pattern of config.patterns) {
        if (pattern.test(text)) {
          return {
            category,
            confidence: 0.8,
            nextAction: config.nextAction,
            responses: config.responses
          };
        }
      }
    }
    
    // Fallback
    return {
      category: 'fallback',
      confidence: 0.5,
      nextAction: this.responsePatterns.fallback.nextAction,
      responses: this.responsePatterns.fallback.responses
    };
  }

  async generateResponse(analysis, conversation) {
    // Skip auto-response in certain conditions
    if (conversation.status === 'unsubscribed') {
      return null; // Don't respond to unsubscribed users
    }
    
    if (conversation.agent_transferred && analysis.category !== 'concern') {
      return null; // Agent is handling, only respond to urgent concerns
    }

    // Select random response from category
    const responses = analysis.responses;
    const message = responses[Math.floor(Math.random() * responses.length)];
    
    return {
      message,
      category: analysis.category,
      nextAction: analysis.nextAction
    };
  }

  // ==================== CONVERSATION MANAGEMENT ====================

  async getOrCreateConversation(phone) {
    try {
      // Try to get existing conversation
      let result = await pool.query(`
        SELECT * FROM whatsapp_conversations 
        WHERE phone = $1 
        ORDER BY created_at DESC 
        LIMIT 1
      `, [phone]);

      if (result.rows.length > 0) {
        return result.rows[0];
      }

      // Create new conversation
      result = await pool.query(`
        INSERT INTO whatsapp_conversations 
        (phone, status, created_at, updated_at) 
        VALUES ($1, 'active', NOW(), NOW()) 
        RETURNING *
      `, [phone]);

      return result.rows[0];
    } catch (error) {
      logger.error('Failed to get/create conversation:', error);
      throw error;
    }
  }

  async updateConversationState(conversation, analysis) {
    try {
      let newStatus = conversation.status;
      
      // Update status based on message analysis
      switch (analysis.nextAction) {
        case 'unsubscribe':
          newStatus = 'unsubscribed';
          break;
        case 'transfer_to_agent':
        case 'urgent_transfer':
          newStatus = 'agent_handling';
          break;
        case 'schedule_callback':
          newStatus = 'callback_scheduled';
          break;
      }

      await pool.query(`
        UPDATE whatsapp_conversations 
        SET 
          status = $1,
          last_message_category = $2,
          updated_at = NOW(),
          agent_transferred = $3
        WHERE id = $4
      `, [
        newStatus,
        analysis.category,
        ['transfer_to_agent', 'urgent_transfer'].includes(analysis.nextAction),
        conversation.id
      ]);
      
    } catch (error) {
      logger.error('Failed to update conversation state:', error);
    }
  }

  // ==================== ACTION EXECUTION ====================

  async executeNextAction(action, conversation, originalMessage) {
    switch (action) {
      case 'transfer_to_agent':
        await this.transferToAgent(conversation, 'normal');
        break;
      case 'urgent_transfer':
        await this.transferToAgent(conversation, 'urgent');
        break;
      case 'schedule_callback':
        await this.scheduleCallback(conversation);
        break;
      case 'unsubscribe':
        await this.unsubscribeUser(conversation);
        break;
    }
  }

  async transferToAgent(conversation, priority = 'normal') {
    try {
      // Create agent notification
      await pool.query(`
        INSERT INTO agent_notifications 
        (phone, conversation_id, priority, type, message, created_at)
        VALUES ($1, $2, $3, 'whatsapp_transfer', $4, NOW())
      `, [
        conversation.phone,
        conversation.id,
        priority,
        `לקוח חדש מחכה לטיפול דרך WhatsApp - ${conversation.phone}`
      ]);

      // Send SMS to agent if urgent
      if (priority === 'urgent') {
        try {
          await inforuService.sendSms(
            '0522377712', // Agent phone
            `🚨 QUANTUM - לקוח דחוף בוואטסאפ: ${conversation.phone}. יש לטפל מיידית!`
          );
        } catch (error) {
          logger.error('Failed to send urgent SMS to agent:', error);
        }
      }

      logger.info(`Transferred conversation ${conversation.id} to agent (${priority})`);
    } catch (error) {
      logger.error('Failed to transfer to agent:', error);
    }
  }

  async scheduleCallback(conversation) {
    // For now, just transfer to agent with callback note
    await this.transferToAgent(conversation, 'normal');
  }

  async unsubscribeUser(conversation) {
    try {
      await pool.query(`
        UPDATE whatsapp_conversations 
        SET status = 'unsubscribed', unsubscribed_at = NOW()
        WHERE id = $1
      `, [conversation.id]);

      // Also mark in main contacts if exists
      await pool.query(`
        UPDATE contacts 
        SET whatsapp_unsubscribed = TRUE 
        WHERE phone = $1
      `, [conversation.phone]);

      logger.info(`Unsubscribed user: ${conversation.phone}`);
    } catch (error) {
      logger.error('Failed to unsubscribe user:', error);
    }
  }

  // ==================== MESSAGING ====================

  async sendResponse(phone, response) {
    try {
      const result = await inforuService.sendWhatsAppChat(phone, response.message, {
        source: 'quantum_auto_response',
        category: response.category
      });

      logger.info(`Auto-response sent to ${phone}: ${response.category}`);
      return result;
    } catch (error) {
      logger.error('Failed to send auto response:', error);
      throw error;
    }
  }

  async logMessage(conversationId, direction, message, externalId = null) {
    try {
      await pool.query(`
        INSERT INTO whatsapp_messages 
        (conversation_id, direction, message, external_id, created_at)
        VALUES ($1, $2, $3, $4, NOW())
      `, [conversationId, direction, message, externalId]);
    } catch (error) {
      logger.error('Failed to log message:', error);
    }
  }

  // ==================== UTILITIES ====================

  normalizePhone(phone) {
    let cleaned = phone.replace(/[^\d]/g, '');
    if (cleaned.startsWith('972')) {
      cleaned = '0' + cleaned.substring(3);
    }
    return cleaned;
  }

  // ==================== DATABASE SETUP ====================

  async initializeDatabase() {
    try {
      // Conversations table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_conversations (
          id SERIAL PRIMARY KEY,
          phone VARCHAR(20) NOT NULL,
          status VARCHAR(50) DEFAULT 'active',
          last_message_category VARCHAR(50),
          agent_transferred BOOLEAN DEFAULT FALSE,
          unsubscribed_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Messages table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_messages (
          id SERIAL PRIMARY KEY,
          conversation_id INTEGER REFERENCES whatsapp_conversations(id),
          direction VARCHAR(20) NOT NULL,
          message TEXT NOT NULL,
          external_id VARCHAR(100),
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Agent notifications table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS agent_notifications (
          id SERIAL PRIMARY KEY,
          phone VARCHAR(20),
          conversation_id INTEGER REFERENCES whatsapp_conversations(id),
          priority VARCHAR(20) DEFAULT 'normal',
          type VARCHAR(50),
          message TEXT,
          handled BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Indexes
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_phone ON whatsapp_conversations(phone)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_conversation ON whatsapp_messages(conversation_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_notifications_handled ON agent_notifications(handled) WHERE handled = FALSE`);

      logger.info('WhatsApp response handler database initialized');
    } catch (error) {
      logger.error('Failed to initialize response handler database:', error);
    }
  }
}

// ==================== SINGLETON ====================

const responseHandler = new QuantumResponseHandler();

// Initialize on startup
responseHandler.initializeDatabase().catch(err => {
  logger.error('Failed to initialize response handler:', err);
});

module.exports = responseHandler;
