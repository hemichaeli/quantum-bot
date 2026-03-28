/**
 * QUANTUM Bot — Zoho Outreach Routes
 *
 * POST /api/zoho-outreach/sync          — sync leads from Zoho CRM
 * GET  /api/zoho-outreach/pending       — list pending leads
 * POST /api/zoho-outreach/send          — send WA to pending leads
 * POST /api/zoho-outreach/escalate      — escalate no-reply leads to Vapi call
 * GET  /api/zoho-outreach/stats         — outreach stats
 */

const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const { logger } = require('../services/logger');
const zoho    = require('../services/zohoCrmService');

const INFORU_USERNAME      = process.env.INFORU_USERNAME      || 'hemichaeli';
const INFORU_TOKEN         = process.env.INFORU_TOKEN         || '95452ace-07cf-48be-8671-a197c15d3c17';
const INFORU_BUSINESS_LINE = process.env.INFORU_BUSINESS_LINE || '037572229';
const VAPI_API_KEY         = process.env.VAPI_API_KEY         || '';
const VAPI_ASSISTANT_COLD  = process.env.VAPI_ASSISTANT_COLD  || process.env.VAPI_ASSISTANT_ID || '';
const VAPI_PHONE_NUMBER_ID = process.env.VAPI_PHONE_NUMBER_ID || '';

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizePhone(phone) {
  if (!phone) return null;
  let p = String(phone).replace(/[^0-9]/g, '');
  if (p.startsWith('972')) return p;
  if (p.startsWith('0'))   return '972' + p.slice(1);
  return '972' + p;
}

function buildWAMessage(lead) {
  const name     = lead.contact_name || '';
  const city     = lead.city || '';
  const greeting = name ? `שלום ${name}` : 'שלום';
  const location = city ? ` באזור ${city}` : '';

  return [
    `${greeting},`,
    '',
    `אני חמי ממשרד קוונטום נדלן.`,
    `שמתי לב שיש לך נכס${location} — תחום שאני מתמחה בו.`,
    '',
    'יש לנו רוכשים מתאימים ואני רוצה לעדכן אותך על ערך הנכס שלך בשוק הנוכחי.',
    '',
    'מתי נוח לך לדבר 5 דקות?',
    '',
    'קוונטום נדלן | 03-757-2229',
  ].join('\n');
}

async function sendWA(phone, message) {
  const normalized = normalizePhone(phone);
  if (!normalized) return { success: false, error: 'invalid phone' };

  const payload = {
    Data: {
      Message: message,
      Recipients: [{ Phone: normalized }],
    },
    Settings: { BusinessLine: INFORU_BUSINESS_LINE },
    Authentication: { Username: INFORU_USERNAME, ApiToken: INFORU_TOKEN },
  };

  try {
    const resp = await axios.post(
      'https://capi.inforu.co.il/api/v2/WhatsApp/SendWhatsAppChat',
      payload,
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    const ok = resp.data?.Status === 'SUCCESS' || resp.status === 200;
    return { success: ok, normalized, inforu: resp.data };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function sendVapiCall(lead) {
  if (!VAPI_API_KEY || !VAPI_ASSISTANT_COLD) {
    return { success: false, error: 'Vapi not configured' };
  }
  const normalized = normalizePhone(lead.phone);
  if (!normalized) return { success: false, error: 'invalid phone' };

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
    if (!resp.ok) return { success: false, error: data.message || 'Vapi error' };
    return { success: true, call_id: data.id };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── POST /api/zoho-outreach/sync ─────────────────────────────────────────────

router.post('/sync', async (req, res) => {
  try {
    const { lead_source } = req.body;
    const result = await zoho.syncLeadsFromZoho({ leadSource: lead_source || null });
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('[ZohoOutreach] sync error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/zoho-outreach/pending ────────────────────────────────────────────

router.get('/pending', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const leads = await zoho.getPendingLeads({ limit });
    res.json({ success: true, total: leads.length, leads });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/zoho-outreach/send ─────────────────────────────────────────────
// Send WhatsApp to pending leads (up to 100 at a time)

router.post('/send', async (req, res) => {
  try {
    const { limit = 50, lead_ids } = req.body;

    let leads;
    if (lead_ids && Array.isArray(lead_ids)) {
      const { rows } = await require('../db/pool').query(
        `SELECT * FROM zoho_leads WHERE id = ANY($1) AND phone IS NOT NULL`,
        [lead_ids]
      );
      leads = rows;
    } else {
      leads = await zoho.getPendingLeads({ limit: Math.min(limit, 100) });
    }

    if (!leads.length) return res.json({ success: true, sent: 0, message: 'No pending leads' });

    let sent = 0, failed = 0;
    const results = [];

    for (const lead of leads) {
      const msg    = buildWAMessage(lead);
      const result = await sendWA(lead.phone, msg);

      if (result.success) {
        sent++;
        await zoho.updateLeadStatus(lead.id, 'wa_sent', { wa_sent_at: new Date() });
        results.push({ id: lead.id, phone: lead.phone, status: 'sent' });
      } else {
        failed++;
        await zoho.updateLeadStatus(lead.id, 'wa_failed', { notes: `WA failed: ${result.error}` });
        results.push({ id: lead.id, phone: lead.phone, status: 'failed', error: result.error });
      }

      await new Promise(r => setTimeout(r, 200));
    }

    logger.info(`[ZohoOutreach] WA sent=${sent} failed=${failed}`);
    res.json({ success: true, sent, failed, total: leads.length, results });

  } catch (err) {
    logger.error('[ZohoOutreach] send error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/zoho-outreach/escalate ─────────────────────────────────────────
// Escalate leads with no WA reply after 3 hours → Vapi call

router.post('/escalate', async (req, res) => {
  try {
    const leads = await zoho.getLeadsReadyForEscalation();

    if (!leads.length) return res.json({ success: true, escalated: 0, message: 'No leads ready for escalation' });

    let called = 0, failed = 0;
    const results = [];

    for (const lead of leads) {
      const result = await sendVapiCall(lead);

      if (result.success) {
        called++;
        await zoho.updateLeadStatus(lead.id, 'call_sent', {
          call_sent_at: new Date(),
          notes: `Vapi call escalated after 3h no reply. call_id=${result.call_id}`,
        });
        results.push({ id: lead.id, phone: lead.phone, status: 'called', call_id: result.call_id });
      } else {
        failed++;
        await zoho.updateLeadStatus(lead.id, 'call_failed', {
          notes: `Vapi call failed: ${result.error}`,
        });
        results.push({ id: lead.id, phone: lead.phone, status: 'failed', error: result.error });
      }

      await new Promise(r => setTimeout(r, 500));
    }

    logger.info(`[ZohoOutreach] Escalation: called=${called} failed=${failed}`);
    res.json({ success: true, escalated: leads.length, called, failed, results });

  } catch (err) {
    logger.error('[ZohoOutreach] escalate error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/zoho-outreach/stats ──────────────────────────────────────────────

router.get('/stats', async (req, res) => {
  try {
    await zoho.ensureLeadsTable();
    const { rows } = await require('../db/pool').query(`
      SELECT
        COUNT(*)                                                  AS total,
        COUNT(*) FILTER (WHERE outreach_status = 'pending')      AS pending,
        COUNT(*) FILTER (WHERE outreach_status = 'wa_sent')      AS wa_sent,
        COUNT(*) FILTER (WHERE outreach_status = 'wa_failed')    AS wa_failed,
        COUNT(*) FILTER (WHERE outreach_status = 'call_sent')    AS call_sent,
        COUNT(*) FILTER (WHERE outreach_status = 'call_failed')  AS call_failed,
        COUNT(*) FILTER (WHERE outreach_status = 'replied')      AS replied,
        COUNT(*) FILTER (WHERE replied_at IS NOT NULL)           AS total_replied
      FROM zoho_leads
    `);
    res.json({ success: true, stats: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
