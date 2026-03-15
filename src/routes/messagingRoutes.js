/**
 * Enhanced Messaging Routes v3
 * 
 * NEW in v3:
 *   GET  /api/messaging/all-listings    - All listings with full filters (sent + unsent)
 *   GET  /api/messaging/cities          - Cities dropdown
 *   GET  /api/messaging/complexes       - Complexes dropdown (optional city filter)
 *   POST /api/messaging/enrich-phones   - Batch phone enrichment for yad2 listings
 * 
 * ENHANCED:
 *   GET  /api/messaging/unsent          - Now supports rooms, min_price, days_on_market, has_phone, complex_name
 * 
 * EXISTING:
 *   POST /send, /send-bulk, /send-filtered, /check-replies
 *   PUT  /listing/:id/deal-status, /listing/:id/message-status
 *   GET  /listing/:id/messages, /stats, /status, /deal-statuses
 *   GET  /templates, /dashboard, /auto-send
 *   PUT  /auto-send
 *   POST /auto-send/test, /preview
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

function getOrchestrator() {
  try { return require('../services/messagingOrchestrator'); } catch (e) { 
    logger.warn('messagingOrchestrator not available:', e.message);
    return null; 
  }
}

let yad2Messenger;
try { yad2Messenger = require('../services/yad2Messenger'); } catch (e) {
  logger.warn('yad2Messenger not available:', e.message);
  yad2Messenger = null;
}

// ============================================================
// HELPER: Build filter conditions
// ============================================================

function buildFilterConditions(query) {
  let conditions = ['l.is_active = TRUE'];
  let params = []; let idx = 1;

  if (query.city) { conditions.push(`l.city = $${idx++}`); params.push(query.city); }
  if (query.platform || query.source) { conditions.push(`l.source = $${idx++}`); params.push(query.platform || query.source); }
  if (query.min_ssi) { conditions.push(`l.ssi_score >= $${idx++}`); params.push(parseFloat(query.min_ssi)); }
  if (query.max_ssi) { conditions.push(`l.ssi_score <= $${idx++}`); params.push(parseFloat(query.max_ssi)); }
  if (query.min_iai) { conditions.push(`c.iai_score >= $${idx++}`); params.push(parseFloat(query.min_iai)); }
  if (query.max_iai) { conditions.push(`c.iai_score <= $${idx++}`); params.push(parseFloat(query.max_iai)); }
  if (query.min_price) { conditions.push(`l.asking_price >= $${idx++}`); params.push(parseFloat(query.min_price)); }
  if (query.max_price) { conditions.push(`l.asking_price <= $${idx++}`); params.push(parseFloat(query.max_price)); }
  if (query.min_rooms) { conditions.push(`l.rooms >= $${idx++}`); params.push(parseFloat(query.min_rooms)); }
  if (query.max_rooms) { conditions.push(`l.rooms <= $${idx++}`); params.push(parseFloat(query.max_rooms)); }
  if (query.min_days) { conditions.push(`l.days_on_market >= $${idx++}`); params.push(parseInt(query.min_days)); }
  if (query.max_days) { conditions.push(`l.days_on_market <= $${idx++}`); params.push(parseInt(query.max_days)); }
  if (query.complex_id) { conditions.push(`l.complex_id = $${idx++}`); params.push(parseInt(query.complex_id)); }
  if (query.complex_name) { conditions.push(`c.name ILIKE $${idx++}`); params.push(`%${query.complex_name}%`); }
  if (query.has_phone === 'true') { conditions.push(`l.phone IS NOT NULL AND l.phone != ''`); }
  if (query.has_url === 'true') { conditions.push(`l.url IS NOT NULL AND l.url != ''`); }
  if (query.is_foreclosure === 'true') { conditions.push(`l.is_foreclosure = TRUE`); }
  if (query.is_inheritance === 'true') { conditions.push(`l.is_inheritance = TRUE`); }
  if (query.deal_status) { conditions.push(`l.deal_status = $${idx++}`); params.push(query.deal_status); }
  if (query.message_status) { conditions.push(`l.message_status = $${idx++}`); params.push(query.message_status); }
  if (query.search) { 
    conditions.push(`(l.address ILIKE $${idx} OR l.city ILIKE $${idx} OR c.name ILIKE $${idx})`); 
    params.push(`%${query.search}%`); idx++; 
  }

  return { conditions, params, idx };
}

const LISTING_SELECT = `
  l.id, l.address, l.city, l.asking_price, l.rooms, l.area_sqm, l.floor,
  l.source, l.url, l.source_listing_id, l.phone, l.contact_name,
  l.message_status, l.deal_status, l.created_at, l.updated_at,
  l.ssi_score, l.days_on_market, l.price_changes, l.total_price_drop_percent,
  l.is_foreclosure, l.is_inheritance, l.has_urgent_keywords, l.urgent_keywords_found,
  l.last_message_sent_at, l.last_reply_at, l.last_reply_text, l.notes,
  c.name as complex_name, c.iai_score, c.status as complex_status,
  l.complex_id
`;

// ============================================================
// STATUS & LOGIN
// ============================================================

router.get('/status', (req, res) => {
  const orch = getOrchestrator();
  res.json({
    yad2: yad2Messenger ? yad2Messenger.getStatus() : { available: false },
    orchestrator: orch ? 'available' : 'not loaded',
    auto_send: orch ? orch.getAutoSendConfig() : null
  });
});

router.post('/login', async (req, res) => {
  try {
    if (!yad2Messenger) return res.status(503).json({ error: 'Puppeteer not available' });
    const result = await yad2Messenger.login();
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// ALL LISTINGS (with full filters)
// ============================================================

router.get('/all-listings', async (req, res) => {
  try {
    const { conditions, params } = buildFilterConditions(req.query);
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const offset = parseInt(req.query.offset) || 0;
    const sort = req.query.sort || 'created_at';
    const order = req.query.order === 'asc' ? 'ASC' : 'DESC';
    
    const validSorts = ['created_at', 'asking_price', 'ssi_score', 'days_on_market', 'rooms', 'iai_score', 'updated_at'];
    const sortCol = validSorts.includes(sort) ? (sort === 'iai_score' ? 'c.iai_score' : `l.${sort}`) : 'l.created_at';

    const result = await pool.query(`
      SELECT ${LISTING_SELECT}
      FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${sortCol} ${order} NULLS LAST
      LIMIT ${limit} OFFSET ${offset}
    `, params);

    const countResult = await pool.query(`
      SELECT COUNT(*) as total 
      FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id 
      WHERE ${conditions.join(' AND ')}
    `, params);

    res.json({ 
      total: parseInt(countResult.rows[0].total), 
      returned: result.rows.length, 
      offset, 
      listings: result.rows 
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// UNSENT LISTINGS (enhanced filters)
// ============================================================

router.get('/unsent', async (req, res) => {
  try {
    const { conditions, params } = buildFilterConditions(req.query);
    conditions.push(`(l.message_status IS NULL OR l.message_status = 'לא נשלחה')`);
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    
    const result = await pool.query(`
      SELECT ${LISTING_SELECT}
      FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY l.created_at DESC LIMIT ${limit} OFFSET ${offset}
    `, params);
    const countResult = await pool.query(`
      SELECT COUNT(*) as total FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id WHERE ${conditions.join(' AND ')}
    `, params);
    res.json({ total: parseInt(countResult.rows[0].total), returned: result.rows.length, offset, listings: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// CITIES & COMPLEXES DROPDOWNS
// ============================================================

router.get('/cities', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT l.city, COUNT(*) as listing_count,
        COUNT(*) FILTER (WHERE l.message_status IS NULL OR l.message_status = 'לא נשלחה') as unsent,
        ROUND(AVG(l.ssi_score), 1) as avg_ssi
      FROM listings l WHERE l.is_active = TRUE AND l.city IS NOT NULL
      GROUP BY l.city ORDER BY listing_count DESC
    `);
    res.json({ cities: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/complexes', async (req, res) => {
  try {
    let where = 'l.is_active = TRUE'; const params = [];
    if (req.query.city) { where += ` AND l.city = $1`; params.push(req.query.city); }
    const result = await pool.query(`
      SELECT c.id, c.name, c.city, c.iai_score, c.status,
        COUNT(l.id) as listing_count,
        COUNT(l.id) FILTER (WHERE l.message_status IS NULL OR l.message_status = 'לא נשלחה') as unsent
      FROM complexes c JOIN listings l ON l.complex_id = c.id
      WHERE ${where}
      GROUP BY c.id ORDER BY listing_count DESC
    `, params);
    res.json({ complexes: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// SEND MESSAGES
// ============================================================

router.post('/send', async (req, res) => {
  const { listing_id, message_text, template_id, channel } = req.body;
  if (!listing_id) return res.status(400).json({ error: 'listing_id required' });
  
  try {
    const orch = getOrchestrator();
    const listingResult = await pool.query(
      `SELECT l.*, c.name as complex_name, c.iai_score
       FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id WHERE l.id = $1`,
      [listing_id]
    );
    if (listingResult.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });
    const listing = listingResult.rows[0];
    
    let finalMessage = message_text;
    if (!finalMessage && template_id && orch) {
      const templates = orch.getTemplates();
      const tmpl = templates[template_id];
      if (tmpl) finalMessage = orch.fillTemplate(tmpl.template, listing);
    }
    if (!finalMessage) return res.status(400).json({ error: 'message_text or template_id required' });
    
    // Channel priority: platform > whatsapp > sms
    if (orch) {
      const result = await orch.sendToListing(listing, finalMessage, { preferredChannel: channel });
      return res.json(result);
    }
    
    // Fallback direct
    const msgRecord = await pool.query(
      `INSERT INTO listing_messages (listing_id, direction, message_text, status, channel) VALUES ($1, 'sent', $2, 'pending', $3) RETURNING id`,
      [listing_id, finalMessage, channel || 'auto']
    );

    let result = { success: false, status: 'manual' };
    
    // Try yad2 platform first
    if ((!channel || channel === 'platform' || channel === 'yad2') && yad2Messenger && listing.source === 'yad2' && listing.url) {
      try {
        result = await yad2Messenger.sendMessage(listing.url, finalMessage);
        result.channel = 'yad2';
      } catch (e) { logger.warn('yad2 send failed, falling back', { error: e.message }); }
    }
    
    // Try WhatsApp
    if (!result.success && (!channel || channel === 'whatsapp') && listing.phone) {
      const phone = listing.phone.replace(/[^0-9]/g, '');
      const waLink = `https://wa.me/972${phone.startsWith('0') ? phone.slice(1) : phone}?text=${encodeURIComponent(finalMessage)}`;
      result = { success: true, channel: 'whatsapp', whatsapp_link: waLink };
    }
    
    // Try SMS
    if (!result.success && (!channel || channel === 'sms') && listing.phone) {
      try {
        const inforuService = require('../services/inforuService');
        result = await inforuService.sendSms(listing.phone, finalMessage);
        result.channel = 'sms';
      } catch (e) { logger.warn('SMS send failed', { error: e.message }); }
    }
    
    await pool.query(`UPDATE listing_messages SET status = $1, error_message = $2, channel = $3 WHERE id = $4`,
      [result.success ? 'sent' : 'failed', result.error || null, result.channel || 'manual', msgRecord.rows[0].id]);
    if (result.success || result.whatsapp_link) {
      await pool.query(`UPDATE listings SET message_status = $1, last_message_sent_at = NOW() WHERE id = $2`, 
        [result.channel === 'whatsapp' ? 'קישור וואטסאפ' : 'נשלחה', listing_id]);
    }
    res.json({ listing_id, message_id: msgRecord.rows[0].id, ...result });
  } catch (err) {
    logger.error('Send message failed', { listing_id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.post('/send-bulk', async (req, res) => {
  const { listing_ids, message_template, template_id, channel } = req.body;
  if (!listing_ids || !listing_ids.length) return res.status(400).json({ error: 'listing_ids array required' });
  if (!message_template && !template_id) return res.status(400).json({ error: 'message_template or template_id required' });
  if (listing_ids.length > 100) return res.status(400).json({ error: 'Maximum 100 per batch' });
  
  const orch = getOrchestrator();
  const results = [];
  for (const lid of listing_ids) {
    try {
      const listing = await pool.query(
        `SELECT l.*, c.name as complex_name, c.iai_score
         FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id WHERE l.id = $1`, [lid]);
      if (listing.rows.length === 0) { results.push({ listing_id: lid, success: false, error: 'Not found' }); continue; }
      const l = listing.rows[0];
      let msg;
      if (template_id && orch) {
        const tmpl = orch.getTemplates()[template_id];
        msg = tmpl ? orch.fillTemplate(tmpl.template, l) : message_template;
      } else {
        msg = message_template.replace(/{address}/g, l.address || '').replace(/{city}/g, l.city || '')
          .replace(/{price}/g, l.asking_price ? `${Number(l.asking_price).toLocaleString()} ש"ח` : '')
          .replace(/{rooms}/g, l.rooms || '').replace(/{area}/g, l.area_sqm || '').replace(/{platform}/g, l.source || '');
      }
      if (orch) { results.push(await orch.sendToListing(l, msg, { preferredChannel: channel })); }
      else { results.push({ listing_id: lid, success: false, error: 'Orchestrator not available' }); }
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 5000));
    } catch (err) { results.push({ listing_id: lid, success: false, error: err.message }); }
  }
  res.json({ total: listing_ids.length, sent: results.filter(r => r.success || r.whatsapp_link).length, failed: results.filter(r => !r.success && !r.whatsapp_link).length, results });
});

// ============================================================
// FILTER-BASED MESSAGING
// ============================================================

router.post('/send-filtered', async (req, res) => {
  const { filters = {}, template_id = 'yad2_seller', extra_vars = {}, channel } = req.body;
  const orch = getOrchestrator();
  if (!orch) return res.status(503).json({ error: 'Messaging orchestrator not available' });
  try {
    const result = await orch.sendByFilter(filters, template_id, extra_vars, { preferredChannel: channel });
    res.json(result);
  } catch (err) {
    logger.error('send-filtered failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// PHONE ENRICHMENT
// ============================================================

router.post('/enrich-phones', async (req, res) => {
  try {
    // Find yad2 listings with URLs but no phone
    const listings = await pool.query(`
      SELECT id, url, source_listing_id, source 
      FROM listings 
      WHERE is_active = TRUE AND (phone IS NULL OR phone = '')
        AND url IS NOT NULL AND url != ''
        AND source IN ('yad2', 'yad2.co.il')
      LIMIT 20
    `);
    
    if (listings.rows.length === 0) {
      return res.json({ message: 'No listings need phone enrichment', enriched: 0 });
    }
    
    // For yad2, try to extract phone from listing page
    const results = [];
    for (const listing of listings.rows) {
      try {
        // yad2 API phone endpoint
        const itemId = listing.source_listing_id;
        if (itemId && !itemId.startsWith('ai-')) {
          const axios = require('axios');
          const phoneResp = await axios.get(`https://gw.yad2.co.il/feed-search/item/${itemId}/phone`, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
            timeout: 10000
          }).catch(() => null);
          
          if (phoneResp && phoneResp.data && phoneResp.data.data) {
            const phone = phoneResp.data.data.phone || phoneResp.data.data.phone_number;
            if (phone) {
              await pool.query(`UPDATE listings SET phone = $1 WHERE id = $2`, [phone, listing.id]);
              results.push({ id: listing.id, phone, success: true });
              await new Promise(r => setTimeout(r, 2000)); // Rate limit
              continue;
            }
          }
        }
        results.push({ id: listing.id, success: false, reason: 'No phone found' });
      } catch (err) {
        results.push({ id: listing.id, success: false, error: err.message });
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    
    const enriched = results.filter(r => r.success).length;
    res.json({ total: listings.rows.length, enriched, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// TEMPLATES
// ============================================================

router.get('/templates', (req, res) => {
  const orch = getOrchestrator();
  res.json({ templates: orch ? orch.getTemplates() : {} });
});

router.post('/preview', async (req, res) => {
  const { listing_id, template_id = 'yad2_seller', extra_vars = {} } = req.body;
  if (!listing_id) return res.status(400).json({ error: 'listing_id required' });
  const orch = getOrchestrator();
  if (!orch) return res.status(503).json({ error: 'Orchestrator not available' });
  try {
    const preview = await orch.previewMessage(listing_id, template_id, extra_vars);
    res.json(preview);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// AUTO-SEND CONFIG
// ============================================================

router.get('/auto-send', (req, res) => {
  const orch = getOrchestrator();
  if (!orch) return res.status(503).json({ error: 'Orchestrator not available' });
  res.json(orch.getAutoSendConfig());
});

router.put('/auto-send', (req, res) => {
  const orch = getOrchestrator();
  if (!orch) return res.status(503).json({ error: 'Orchestrator not available' });
  const config = orch.updateAutoSendConfig(req.body);
  res.json({ success: true, config });
});

router.post('/auto-send/test', async (req, res) => {
  const orch = getOrchestrator();
  if (!orch) return res.status(503).json({ error: 'Orchestrator not available' });
  try {
    const listing = await pool.query(`
      SELECT l.id FROM listings l
      WHERE l.is_active = TRUE AND (l.message_status IS NULL OR l.message_status = 'לא נשלחה')
      ORDER BY l.created_at DESC LIMIT 1`);
    if (listing.rows.length === 0) return res.json({ success: false, message: 'No unsent listings found' });
    const prevEnabled = orch.getAutoSendConfig().enabled;
    orch.updateAutoSendConfig({ enabled: true });
    const result = await orch.autoSendToNewListings([listing.rows[0].id]);
    orch.updateAutoSendConfig({ enabled: prevEnabled });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// DASHBOARD
// ============================================================

router.get('/dashboard', async (req, res) => {
  const orch = getOrchestrator();
  try {
    const stats = await pool.query(`
      SELECT COUNT(*) as total,
        COUNT(*) FILTER (WHERE message_status IS NULL OR message_status = 'לא נשלחה') as unsent,
        COUNT(*) FILTER (WHERE message_status = 'נשלחה') as sent,
        COUNT(*) FILTER (WHERE message_status = 'קישור וואטסאפ') as whatsapp_links,
        COUNT(*) FILTER (WHERE message_status = 'התקבלה תשובה') as replied,
        COUNT(*) FILTER (WHERE deal_status = 'תיווך') as brokered,
        COUNT(*) FILTER (WHERE deal_status = 'בטיפול') as in_progress,
        COUNT(*) FILTER (WHERE phone IS NOT NULL AND phone != '') as with_phone
      FROM listings WHERE is_active = TRUE`);
    
    const bySource = await pool.query(`
      SELECT source, COUNT(*) as count,
        COUNT(*) FILTER (WHERE message_status = 'נשלחה' OR message_status = 'קישור וואטסאפ') as sent,
        COUNT(*) FILTER (WHERE phone IS NOT NULL AND phone != '') as with_phone
      FROM listings WHERE is_active = TRUE
      GROUP BY source ORDER BY count DESC`);
    
    const byCity = await pool.query(`
      SELECT city, COUNT(*) as count,
        COUNT(*) FILTER (WHERE message_status IS NULL OR message_status = 'לא נשלחה') as unsent
      FROM listings WHERE is_active = TRUE AND city IS NOT NULL
      GROUP BY city ORDER BY count DESC LIMIT 15`);
    
    const recentMessages = await pool.query(`
      SELECT lm.*, l.address, l.city, l.source
      FROM listing_messages lm
      JOIN listings l ON lm.listing_id = l.id
      ORDER BY lm.created_at DESC LIMIT 20`);
    
    res.json({
      overview: stats.rows[0],
      by_source: bySource.rows,
      by_city: byCity.rows,
      recent_messages: recentMessages.rows,
      auto_send: orch ? orch.getAutoSendConfig() : null
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// EXISTING ROUTES
// ============================================================

router.post('/check-replies', async (req, res) => {
  try {
    if (!yad2Messenger) return res.status(503).json({ error: 'Puppeteer not available' });
    const result = await yad2Messenger.checkReplies();
    if (result.new_replies && result.new_replies.length > 0) {
      for (const reply of result.new_replies) {
        await pool.query(`INSERT INTO listing_messages (listing_id, direction, message_text, status) VALUES (NULL, 'received', $1, 'received')`, [reply.reply_text]);
      }
    }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/listing/:id/deal-status', async (req, res) => {
  const { id } = req.params;
  const { deal_status, notes } = req.body;
  const validStatuses = ['חדש', 'נשלחה הודעה', 'התקבלה תשובה', 'תיווך', 'ללא תיווך', 'נמכרה', 'לא רלוונטי', 'נא ליצור קשר', 'בטיפול', 'סגור'];
  if (deal_status && !validStatuses.includes(deal_status)) return res.status(400).json({ error: 'Invalid deal_status', valid: validStatuses });
  try {
    const updates = []; const values = []; let idx = 1;
    if (deal_status) { updates.push(`deal_status = $${idx++}`); values.push(deal_status); }
    if (notes !== undefined) { updates.push(`notes = $${idx++}`); values.push(notes); }
    if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    values.push(id);
    await pool.query(`UPDATE listings SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${idx}`, values);
    res.json({ success: true, listing_id: parseInt(id), deal_status, notes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/listing/:id/message-status', async (req, res) => {
  const { id } = req.params;
  const { message_status, last_reply_text } = req.body;
  try {
    const updates = ['message_status = $1']; const values = [message_status];
    if (last_reply_text) { updates.push('last_reply_text = $2', 'last_reply_at = NOW()'); values.push(last_reply_text); }
    values.push(id);
    await pool.query(`UPDATE listings SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${values.length}`, values);
    res.json({ success: true, listing_id: parseInt(id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/listing/:id/messages', async (req, res) => {
  try {
    const listing = await pool.query(`
      SELECT l.*, c.name as complex_name, c.iai_score
      FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id WHERE l.id = $1`, [req.params.id]);
    const messages = await pool.query(`SELECT * FROM listing_messages WHERE listing_id = $1 ORDER BY created_at ASC`, [req.params.id]);
    res.json({ listing: listing.rows[0] || null, messages: messages.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/stats', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE message_status IS NULL OR message_status = 'לא נשלחה') as not_sent,
        COUNT(*) FILTER (WHERE message_status = 'נשלחה') as sent,
        COUNT(*) FILTER (WHERE message_status = 'קישור וואטסאפ') as whatsapp_links,
        COUNT(*) FILTER (WHERE message_status = 'התקבלה תשובה') as replied,
        COUNT(*) FILTER (WHERE deal_status = 'חדש' OR deal_status IS NULL) as new_leads,
        COUNT(*) FILTER (WHERE deal_status = 'תיווך') as brokered,
        COUNT(*) FILTER (WHERE deal_status = 'בטיפול') as in_progress,
        COUNT(*) FILTER (WHERE phone IS NOT NULL AND phone != '') as with_phone,
        COUNT(*) as total
      FROM listings WHERE is_active = TRUE`);
    const msgCount = await pool.query(`
      SELECT COUNT(*) as total_messages,
        COUNT(*) FILTER (WHERE direction = 'sent') as total_sent,
        COUNT(*) FILTER (WHERE direction = 'received') as total_received
      FROM listing_messages`);
    res.json({ listings: stats.rows[0], messages: msgCount.rows[0], messenger: yad2Messenger ? yad2Messenger.getStatus() : { available: false } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/deal-statuses', (req, res) => {
  res.json({ statuses: [
    { value: 'חדש', label: 'חדש', color: '#94a3b8' },
    { value: 'נשלחה הודעה', label: 'נשלחה הודעה', color: '#60a5fa' },
    { value: 'התקבלה תשובה', label: 'התקבלה תשובה', color: '#34d399' },
    { value: 'תיווך', label: 'תיווך', color: '#f97316' },
    { value: 'ללא תיווך', label: 'ללא תיווך', color: '#a78bfa' },
    { value: 'נמכרה', label: 'נמכרה', color: '#ef4444' },
    { value: 'לא רלוונטי', label: 'לא רלוונטי', color: '#6b7280' },
    { value: 'נא ליצור קשר', label: 'נא ליצור קשר', color: '#facc15' },
    { value: 'בטיפול', label: 'בטיפול', color: '#22d3ee' },
    { value: 'סגור', label: 'סגור', color: '#1e293b' }
  ] });
});

module.exports = router;
