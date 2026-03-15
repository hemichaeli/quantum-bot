/**
 * QUANTUM WhatsApp Bot - v7.0
 * Persona: רן מ-QUANTUM (aligned with Vapi agent — overlapping scripts)
 * Auto-fallback: Claude → Gemini on credit error + WhatsApp alert to owner
 * v7.0: "רן" persona, WA reply signals to campaign system
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const axios = require('axios');
const aiService = require('../services/aiService');

const INFORU_CAPI_BASE = 'https://capi.inforu.co.il/api/v2';

function getBasicAuth() {
  const username = process.env.INFORU_USERNAME;
  const password = process.env.INFORU_PASSWORD;
  if (!username || !password) throw new Error('INFORU credentials not configured');
  return Buffer.from(`${username}:${password}`).toString('base64');
}

function getWebhookUrl() {
  const domain = process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN || 'pinuy-binuy-analyzer-production-ab85.up.railway.app';
  return `https://${domain}/api/whatsapp/webhook`;
}

function parseInforuWebhook(body) {
  if (body.Data && Array.isArray(body.Data) && body.Data.length > 0) {
    const item = body.Data[0];
    return {
      phone: item.Value || item.Phone || null,
      message: item.Message || item.Keyword || item.Text || null,
      network: item.Network || 'Unknown',
      channel: item.Channel || 'Unknown',
      raw: body
    };
  }
  return {
    phone: body.phone || body.from || body.Phone || null,
    message: body.message || body.text || body.body || body.Message || null,
    network: 'Direct',
    channel: 'Direct',
    raw: body
  };
}

function shouldHandoff(message, history, leadInfo) {
  const messageCount = history.length;
  if (message.match(/רוצה לדבר עם אדם|תעביר אותי לאדם|אני רוצה אדם|לדבר עם מישהו|אנשי|מוקד|מתווך אמיתי/i)) {
    return { should: true, reason: 'explicit_request', urgency: 'high' };
  }
  if (message.match(/לא מבין|לא עוזר|לא עונה|מה קורה|די|מספיק|תפסיק/i)) {
    return { should: true, reason: 'frustration', urgency: 'high' };
  }
  if (message.match(/עורך דין|משפטי|חוזה|מיסים|היטל השבחה|מע"מ|רישוי/i)) {
    return { should: true, reason: 'complex_legal', urgency: 'normal' };
  }
  if (messageCount >= 8) {
    const userMessages = history.filter(m => m.sender === 'user').map(m => m.message);
    const lastThree = userMessages.slice(-3);
    const similarityCount = lastThree.filter((msg, idx) =>
      lastThree.some((other, otherIdx) =>
        idx !== otherIdx && msg.length > 10 && other.length > 10 &&
        (msg.includes(other.substring(0, 20)) || other.includes(msg.substring(0, 20)))
      )
    ).length;
    if (similarityCount >= 2) return { should: true, reason: 'stuck_in_loop', urgency: 'normal' };
  }
  if (messageCount >= 10 && leadInfo.stage !== 'scheduling') {
    return { should: true, reason: 'long_conversation', urgency: 'normal' };
  }
  return { should: false };
}

async function requestHandoff(leadId, reason, urgency, phone, name) {
  try {
    await pool.query(`
      UPDATE leads SET
        status = 'pending_handoff',
        raw_data = jsonb_set(jsonb_set(jsonb_set(
          COALESCE(raw_data, '{}'::jsonb),
          '{handoff_requested}', 'true'),
          '{handoff_reason}', $1),
          '{handoff_urgency}', $2),
        updated_at = NOW()
      WHERE id = $3
    `, [JSON.stringify(reason), JSON.stringify(urgency), leadId]);

    const msg = `${name ? name + ', ' : ''}אני מעביר אותך למומחה שלנו.\n\nהוא יחזור אליך תוך ${urgency === 'high' ? '30 דקות' : 'שעה-שעתיים'}. תודה 🙏`;
    const auth = getBasicAuth();
    await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/SendWhatsAppChat`, {
      Data: { Message: msg, Phone: phone, Settings: { CustomerMessageId: `handoff_${Date.now()}` } }
    }, { headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` }, timeout: 15000, validateStatus: () => true });

    await pool.query(
      `INSERT INTO whatsapp_conversations (lead_id, sender, message, ai_metadata, created_at) VALUES ($1, 'bot', $2, $3, NOW())`,
      [leadId, msg, JSON.stringify({ type: 'auto_handoff', reason, urgency })]
    );
    return true;
  } catch (err) {
    console.error('[HANDOFF] Error:', err.message);
    return false;
  }
}

// ─── רן מ-QUANTUM — System Prompt ────────────────────────────────────────────
// חופף לתסריט ה-Vapi: אותה פרסונה, אותו DNA, שני ערוצים
function buildRanPrompt(leadInfo, conversationContext) {
  const stage = leadInfo?.stage || 'greeting';
  const name = leadInfo?.name || null;
  const userType = leadInfo?.user_type || null;
  const isFirstMessage = !conversationContext;

  let p = `אתה רן — נציג QUANTUM, משרד תיווך בוטיק המתמחה בפינוי-בינוי.

## האישיות
- חכם, חם, ישיר — כמו האדם החכם ביותר שהלקוח פגש
- בטוח אבל לא מתנשא — נותן ערך, לא "מוכר"
- מהיר — 1-3 משפטים בכל תגובה
- עברית טבעית, לא פורמלית
- לא מזכיר "מערכת", "AI", "אלגוריתם", "פלטפורמה"

## מטרה
לזהות קונה / מוכר → לאסוף פרטים → לקבוע שיחה עם המומחה.

## תובנות לזרוק לפי קונטקסט
מוכר: "אנחנו יודעים מי הקונים הרציניים לפני שהם מפרסמים — בנכס כמו שלך זה יכול לחסוך 3-4 חודשים."
קונה: "80% מהעסקאות הטובות לא יוצאות לשוק. אנחנו שמים אנשים לפני נכסים שכולם ידברו עליהם בעוד 3 חודשים."
פינוי-בינוי: "רוב האנשים נכנסים מאוחר מדי לפינוי-בינוי. אנחנו רואים מתחמים 18 חודשים לפני שהם בשוק."`;

  if (stage === 'greeting' && isFirstMessage) {
    p += `\n\n## פגישה ראשונה
הצג את עצמך פעם אחת: "שלום${name ? ' ' + name : ''}! אני רן מ-QUANTUM 👋"
שאל שאלה פתוחה אחת: "קונה, מוכר, או בשלב של בדיקה?"`;
  } else if (stage === 'info_gathering') {
    p += userType === 'buyer'
      ? `\n\n## קונה — שאל:
שאלה אחת בכל פעם: אזור, תקציב, לוח זמנים, מתווך קיים?`
      : userType === 'seller'
      ? `\n\n## מוכר — שאל:
שאלה אחת בכל פעם: איפה הנכס, כמה חדרים, כמה זמן בשוק, סיבת המכירה?`
      : `\n\n## קודם כל — זהה: קונה או מוכר?`;
  } else if (stage === 'scheduling') {
    p += `\n\n## קביעת פגישה
"יש לי המומחה שלנו פנוי השבוע — מתי נוח לך ל-15 דקות שיחה?"`;
  }

  if (conversationContext) p += `\n\n## השיחה עד כה:\n${conversationContext}\n\nהמשך באופן טבעי.`;
  if (name) p += `\n\nשם הלקוח: ${name}`;

  p += `\n\n## חוקי זהב
✓ קצר — 1-3 משפטים בלבד
✓ שאלה אחת בכל פעם — לא רשימות
✓ הצג את עצמך כ"רן" רק בהודעה הראשונה
❌ אל תבטיח מחירים ספציפיים
❌ אל תשאל את אותה שאלה פעמיים`;

  return p;
}

async function getOrCreateLead(phone) {
  try {
    let r = await pool.query(`SELECT * FROM leads WHERE phone=$1 AND source='whatsapp_bot' ORDER BY created_at DESC LIMIT 1`, [phone]);
    if (r.rows.length > 0) return r.rows[0];
    r = await pool.query(`INSERT INTO leads (phone,source,status,raw_data,created_at,updated_at) VALUES ($1,'whatsapp_bot','new','{}',NOW(),NOW()) RETURNING *`, [phone]);
    return r.rows[0];
  } catch (err) { console.error('DB error (getOrCreateLead):', err.message); return null; }
}

async function getConversationHistory(leadId) {
  try {
    const r = await pool.query(`SELECT sender,message,created_at FROM whatsapp_conversations WHERE lead_id=$1 ORDER BY created_at ASC`, [leadId]);
    return r.rows;
  } catch (err) { console.error('DB error (history):', err.message); return []; }
}

async function saveMessage(leadId, sender, message, meta = null) {
  try {
    await pool.query(`INSERT INTO whatsapp_conversations (lead_id,sender,message,ai_metadata,created_at) VALUES ($1,$2,$3,$4,NOW())`,
      [leadId, sender, message, meta ? JSON.stringify(meta) : null]);
  } catch (err) { console.error('DB error (saveMessage):', err.message); }
}

async function updateLead(leadId, updates) {
  try {
    const fields = [], values = [];
    let idx = 1;
    if (updates.name)      { fields.push(`name=$${idx++}`);      values.push(updates.name); }
    if (updates.user_type) { fields.push(`user_type=$${idx++}`); values.push(updates.user_type); }
    if (updates.status)    { fields.push(`status=$${idx++}`);    values.push(updates.status); }
    const now = new Date().toISOString();
    if (updates.stage) {
      fields.push(`raw_data=jsonb_set(jsonb_set(COALESCE(raw_data,'{}'),'{stage}',$${idx++}),'{last_contact}',$${idx++})`);
      values.push(JSON.stringify(updates.stage), JSON.stringify(now));
    } else {
      fields.push(`raw_data=jsonb_set(COALESCE(raw_data,'{}'),'{last_contact}',$${idx++})`);
      values.push(JSON.stringify(now));
    }
    fields.push(`updated_at=NOW()`);
    values.push(leadId);
    await pool.query(`UPDATE leads SET ${fields.join(',')} WHERE id=$${idx}`, values);
  } catch (err) { console.error('DB error (updateLead):', err.message); }
}

function extractInsights(message, history) {
  const ins = {};
  const nm = message.match(/שמי ([\u0590-\u05FF]+)|קוראים לי ([\u0590-\u05FF]+)/);
  if (nm) ins.name = nm[1] || nm[2];
  if (message.match(/רוצה לקנות|מחפש דירה|קונה|מעוניין לקנות/)) ins.user_type = 'buyer';
  else if (message.match(/רוצה למכור|יש לי דירה|מוכר|למכירה/)) ins.user_type = 'seller';
  if (history.length === 0) ins.stage = 'greeting';
  else if (history.length < 4) ins.stage = 'info_gathering';
  else if (message.match(/פגישה|שיחה|נדבר|מתי נוח/)) ins.stage = 'scheduling';
  else ins.stage = 'info_gathering';
  return ins;
}

// Signal to campaign system that this phone replied (cancel pending escalation)
async function signalCampaignReply(phone) {
  try {
    await axios.post(
      `http://localhost:${process.env.PORT || 3000}/api/campaigns/webhook/wa-reply`,
      { phone },
      { timeout: 3000, validateStatus: () => true }
    );
  } catch (_) { /* non-blocking */ }
}

// ─── GET webhook verification ─────────────────────────────────────────────────
router.get('/whatsapp/webhook', (req, res) => {
  const aiStatus = aiService.getStatus();
  res.json({
    success: true,
    version: '7.0',
    persona: 'רן מ-QUANTUM',
    ai: aiStatus,
    webhookUrl: getWebhookUrl(),
    timestamp: new Date().toISOString()
  });
});

// ─── POST webhook (INFORU incoming) ──────────────────────────────────────────
router.post('/whatsapp/webhook', async (req, res) => {
  try {
    const parsed = parseInforuWebhook(req.body);
    if (!parsed.phone || !parsed.message) return res.status(200).json({ received: true, processed: false });
    if (parsed.network !== 'WhatsApp' && parsed.network !== 'Direct') return res.json({ received: true, processed: false });

    // Signal campaign system: this phone replied (prevents escalation call)
    signalCampaignReply(parsed.phone);

    const lead = await getOrCreateLead(parsed.phone);
    if (!lead) throw new Error('Failed to get/create lead');
    const history = await getConversationHistory(lead.id);
    await saveMessage(lead.id, 'user', parsed.message);

    const insights = extractInsights(parsed.message, history);
    const leadInfo = { id: lead.id, name: insights.name || lead.name, user_type: insights.user_type || lead.user_type, stage: insights.stage, status: lead.status };

    const handoffCheck = shouldHandoff(parsed.message, history, leadInfo);
    if (handoffCheck.should) {
      await requestHandoff(lead.id, handoffCheck.reason, handoffCheck.urgency, parsed.phone, leadInfo.name);
      return res.json({ success: true, handoff: true, reason: handoffCheck.reason, leadId: lead.id });
    }

    const contextSummary = history.slice(-4).map(m => `${m.sender === 'user' ? 'לקוח' : 'רן'}: ${m.message}`).join('\n');
    const systemPrompt = buildRanPrompt(leadInfo, contextSummary);
    const { text: aiResponse, provider } = await aiService.generateResponse(systemPrompt, parsed.message);

    await saveMessage(lead.id, 'bot', aiResponse, { provider, stage: insights.stage });
    await updateLead(lead.id, insights);

    const auth = getBasicAuth();
    const result = await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/SendWhatsAppChat`, {
      Data: { Message: aiResponse, Phone: parsed.phone, Settings: { CustomerMessageId: `bot_${Date.now()}`, CustomerParameter: 'QUANTUM_RAN_V7' } }
    }, { headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` }, timeout: 15000, validateStatus: () => true });

    res.json({ success: result.data.StatusId === 1, processed: true, leadId: lead.id, insights, provider });
  } catch (err) {
    console.error('✗ Webhook error:', err.message);
    res.status(500).json({ error: 'Processing failed', details: err.message });
  }
});

// ─── GET conversations list ───────────────────────────────────────────────────
router.get('/whatsapp/conversations', async (req, res) => {
  try {
    const { search, status } = req.query;
    let q = `SELECT l.id,l.phone,l.name,l.user_type,l.status,l.raw_data->>'stage' as stage,l.created_at,COUNT(wc.id) as message_count,MAX(wc.created_at) as last_message_at FROM leads l LEFT JOIN whatsapp_conversations wc ON l.id=wc.lead_id WHERE l.source='whatsapp_bot'`;
    const params = []; let n = 1;
    if (search) { q += ` AND (l.phone ILIKE $${n} OR COALESCE(l.name,'') ILIKE $${n})`; params.push('%'+search+'%'); n++; }
    if (status) { q += ` AND l.status=$${n}`; params.push(status); n++; }
    q += ` GROUP BY l.id ORDER BY MAX(wc.created_at) DESC NULLS LAST LIMIT 50`;
    const r = await pool.query(q, params);
    res.json({ success: true, conversations: r.rows, data: r.rows, total: r.rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── GET single conversation messages ────────────────────────────────────────
router.get('/whatsapp/conversations/:identifier/messages', async (req, res) => {
  try {
    const { identifier } = req.params;
    let leadId;
    if (/^\d{1,8}$/.test(identifier)) {
      leadId = parseInt(identifier);
    } else {
      const r = await pool.query(`SELECT id FROM leads WHERE phone=$1 AND source='whatsapp_bot' ORDER BY created_at DESC LIMIT 1`, [identifier]);
      if (!r.rows.length) return res.status(404).json({ success: false, error: 'Lead not found' });
      leadId = r.rows[0].id;
    }
    const lead = (await pool.query(`SELECT * FROM leads WHERE id=$1`, [leadId])).rows[0];
    if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });
    const msgs = (await pool.query(`SELECT sender,message,ai_metadata,created_at FROM whatsapp_conversations WHERE lead_id=$1 ORDER BY created_at ASC`, [leadId])).rows;
    res.json({ success: true, conversation: { display_name: lead.name || lead.phone, phone: lead.phone }, data: msgs.map(m => ({ direction: m.sender === 'bot' ? 'outgoing' : 'incoming', message: m.message, created_at: m.created_at })) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── POST trigger (testing) ───────────────────────────────────────────────────
router.post('/whatsapp/trigger', async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'Phone and message required' });
    const lead = await getOrCreateLead(phone);
    const history = await getConversationHistory(lead.id);
    await saveMessage(lead.id, 'user', message);
    const insights = extractInsights(message, history);
    const leadInfo = { id: lead.id, name: insights.name || lead.name, user_type: insights.user_type || lead.user_type, stage: insights.stage };
    const contextSummary = history.slice(-4).map(m => `${m.sender === 'user' ? 'לקוח' : 'רן'}: ${m.message}`).join('\n');
    const systemPrompt = buildRanPrompt(leadInfo, contextSummary);
    const { text: aiResponse, provider } = await aiService.generateResponse(systemPrompt, message);
    await saveMessage(lead.id, 'bot', aiResponse, { provider });
    await updateLead(lead.id, insights);
    const auth = getBasicAuth();
    const result = await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/SendWhatsAppChat`, {
      Data: { Message: aiResponse, Phone: phone, Settings: { CustomerMessageId: `trigger_${Date.now()}` } }
    }, { headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` }, timeout: 15000, validateStatus: () => true });
    res.json({ success: result.data.StatusId === 1, aiResponse, provider, leadId: lead.id, insights, aiStatus: aiService.getStatus() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── GET stats ────────────────────────────────────────────────────────────────
router.get('/whatsapp/stats', async (req, res) => {
  try {
    const stats = (await pool.query(`SELECT COUNT(DISTINCT l.id) as total_leads,COUNT(DISTINCT CASE WHEN l.status='new' THEN l.id END) as new_leads,COUNT(DISTINCT CASE WHEN l.status='pending_handoff' THEN l.id END) as pending_handoff,COUNT(DISTINCT CASE WHEN l.status='vapi_called' THEN l.id END) as escalated_to_call,COUNT(wc.id) as total_messages FROM leads l LEFT JOIN whatsapp_conversations wc ON l.id=wc.lead_id WHERE l.source='whatsapp_bot'`)).rows[0];
    res.json({ success: true, version: '7.0', persona: 'רן מ-QUANTUM', ai: aiService.getStatus(), stats, webhookUrl: getWebhookUrl() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
