/**
 * WhatsApp Follow-up Automation
 * Sends automated follow-up messages to leads after 24h of no response
 */

const pool = require('../db/pool');
const axios = require('axios');

const INFORU_CAPI_BASE = 'https://capi.inforu.co.il/api/v2';

function getBasicAuth() {
  const username = process.env.INFORU_USERNAME;
  const password = process.env.INFORU_PASSWORD;
  if (!username || !password) throw new Error('INFORU credentials not configured');
  return Buffer.from(`${username}:${password}`).toString('base64');
}

async function sendWhatsAppMessage(phone, message) {
  try {
    const auth = getBasicAuth();
    
    const result = await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/SendWhatsAppChat`, {
      Data: { 
        Message: message, 
        Phone: phone,
        Settings: {
          CustomerMessageId: `followup_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
          CustomerParameter: 'QUANTUM_FOLLOWUP'
        }
      }
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`
      },
      timeout: 15000,
      validateStatus: () => true
    });
    
    return result.data.StatusId === 1;
  } catch (error) {
    console.error('WhatsApp send error:', error.message);
    return false;
  }
}

// Build contextual follow-up message
function buildFollowUpMessage(lead, lastMessage) {
  const name = lead.name || '';
  const userType = lead.user_type;
  const stage = lead.raw_data?.stage || 'greeting';
  
  // Personalized follow-up based on context
  if (stage === 'greeting') {
    return `${name ? name + ', ' : ''}שלום! 👋\n\nזה QUANTUM - הייתי רוצה לוודא שקיבלת את ההודעה שלי.\n\nאיך אני יכול לעזור לך?`;
  }
  
  if (stage === 'info_gathering') {
    if (userType === 'buyer') {
      return `${name ? name + ', ' : ''}היי!\n\nאני עדיין כאן אם אתה מעוניין לשמוע על נכסים מיוחדים שיש לנו.\n\nיש משהו ספציפי שמעניין אותך?`;
    } else if (userType === 'seller') {
      return `${name ? name + ', ' : ''}שלום,\n\nאם אתה עדיין מעוניין למכור, יש לנו קונים פוטנציאליים שמחפשים עכשיו.\n\nמתי נוח לך לדבר?`;
    }
  }
  
  if (stage === 'scheduling') {
    return `${name ? name + ', ' : ''}היי!\n\nראיתי שרצית לקבוע שיחה עם אחד המומחים שלנו.\n\nאני יכול לארגן את זה - מתי נוח לך? היום? מחר?`;
  }
  
  // Default
  return `${name ? name + ', ' : ''}שלום!\n\nזה QUANTUM - רק רציתי לוודא שהכל בסדר.\n\nאם יש משהו שאני יכול לעזור בו, אני כאן 🙂`;
}

async function runFollowUpJob() {
  try {
    console.log('[FOLLOWUP] Starting follow-up check...');
    
    // Find leads that need follow-up:
    // - Last message was from user (not bot)
    // - Last message was 24-48 hours ago
    // - No follow-up sent in last 24 hours
    // - Status is 'new' or 'active'
    
    const query = `
      SELECT DISTINCT ON (l.id)
        l.id,
        l.phone,
        l.name,
        l.user_type,
        l.status,
        l.raw_data,
        wc.sender as last_sender,
        wc.message as last_message,
        wc.created_at as last_message_at,
        l.raw_data->>'last_followup' as last_followup
      FROM leads l
      INNER JOIN whatsapp_conversations wc ON l.id = wc.lead_id
      WHERE l.source = 'whatsapp_bot'
        AND l.status IN ('new', 'active')
        AND wc.created_at = (
          SELECT MAX(created_at) 
          FROM whatsapp_conversations 
          WHERE lead_id = l.id
        )
        AND wc.sender = 'user'
        AND wc.created_at BETWEEN NOW() - INTERVAL '48 hours' AND NOW() - INTERVAL '24 hours'
        AND (
          l.raw_data->>'last_followup' IS NULL 
          OR (l.raw_data->>'last_followup')::timestamp < NOW() - INTERVAL '24 hours'
        )
      ORDER BY l.id, wc.created_at DESC
    `;
    
    const result = await pool.query(query);
    const leadsToFollowUp = result.rows;
    
    console.log(`[FOLLOWUP] Found ${leadsToFollowUp.length} leads needing follow-up`);
    
    let sentCount = 0;
    let failedCount = 0;
    
    for (const lead of leadsToFollowUp) {
      const message = buildFollowUpMessage(lead, lead.last_message);
      
      console.log(`[FOLLOWUP] Sending to ${lead.phone} (Lead ${lead.id})`);
      
      const success = await sendWhatsAppMessage(lead.phone, message);
      
      if (success) {
        // Save follow-up message to conversation
        await pool.query(
          `INSERT INTO whatsapp_conversations (lead_id, sender, message, ai_metadata, created_at)
           VALUES ($1, 'bot', $2, $3, NOW())`,
          [lead.id, message, JSON.stringify({ type: 'followup', auto: true })]
        );
        
        // Update last_followup timestamp
        await pool.query(
          `UPDATE leads 
           SET raw_data = jsonb_set(COALESCE(raw_data, '{}'::jsonb), '{last_followup}', $1),
               updated_at = NOW()
           WHERE id = $2`,
          [JSON.stringify(new Date().toISOString()), lead.id]
        );
        
        sentCount++;
        console.log(`[FOLLOWUP] ✓ Sent to lead ${lead.id}`);
      } else {
        failedCount++;
        console.log(`[FOLLOWUP] ✗ Failed for lead ${lead.id}`);
      }
      
      // Rate limiting - wait 2 seconds between messages
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    console.log(`[FOLLOWUP] Complete: ${sentCount} sent, ${failedCount} failed`);
    
    return { sent: sentCount, failed: failedCount, total: leadsToFollowUp.length };
  } catch (error) {
    console.error('[FOLLOWUP] Error:', error.message);
    throw error;
  }
}

module.exports = { runFollowUpJob };
