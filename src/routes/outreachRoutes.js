/**
 * QUANTUM Outreach Routes — v1.0.0
 * POST /api/outreach/send — send WA / call / wa_then_call to selected listings
 * GET  /api/outreach/stats — outreach stats
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');
const axios = require('axios');

const INFORU_USERNAME      = process.env.INFORU_USERNAME      || 'hemichaeli';
const INFORU_TOKEN         = process.env.INFORU_TOKEN         || '95452ace-07cf-48be-8671-a197c15d3c17';
const INFORU_BUSINESS_LINE = process.env.INFORU_BUSINESS_LINE || '037572229';
const VAPI_API_KEY         = process.env.VAPI_API_KEY         || '';
const VAPI_ASSISTANT_COLD  = process.env.VAPI_ASSISTANT_COLD  || '';

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizePhone(phone) {
  if (!phone) return null;
  let p = String(phone).replace(/[^0-9]/g, '');
  if (p.startsWith('972')) return p;
  if (p.startsWith('0')) return '972' + p.slice(1);
  return '972' + p;
}

function buildWAMessage(listing) {
  const city    = listing.city    || listing.complex_city || '';
  const complex = listing.complex_name || '';
  const addr    = listing.address || listing.title || '';
  const name    = listing.contact_name || '';

  const greeting = name ? `שלום ${name}` : 'שלום';
  const location = complex ? `${complex}${city ? ' ב' + city : ''}` : city;

  return [
    `${greeting},`,
    '',
    `אני חמי ממשרד קוונטום נדלן.`,
    location
      ? `שמתי לב שיש לך נכס באזור ${location} — תחום שאני מתמחה בו.`
      : 'שמתי לב שיש לך נכס שעשוי להיות רלוונטי עבורנו.',
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
    Data: { Message: message, Recipients: [{ Phone: normalized }] },
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
    return { success: ok, inforu: resp.data, normalized };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function sendCall(phone, listing) {
  if (!VAPI_API_KEY || !VAPI_ASSISTANT_COLD) {
    return { success: false, error: 'Vapi not configured' };
  }
  const normalized = normalizePhone(phone);
  if (!normalized) return { success: false, error: 'invalid phone' };

  const callPayload = {
    assistantId: VAPI_ASSISTANT_COLD,
    customer: { number: '+' + normalized },
    assistantOverrides: {
      variableValues: {
        lead_name: listing.contact_name || 'לקוח',
        complex_city: listing.city || listing.complex_city || '',
        complex_name: listing.complex_name || '',
      },
    },
  };
  if (process.env.VAPI_PHONE_NUMBER_ID) callPayload.phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;

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

async function updateListingStatus(id, status, sentAt) {
  try {
    await pool.query(
      `UPDATE listings SET message_status = $1, last_message_sent_at = $2,
       contact_attempts = COALESCE(contact_attempts, 0) + 1,
       last_contact_at = NOW()
       WHERE id = $3`,
      [status, sentAt || new Date(), id]
    );
  } catch (err) {
    logger.warn('[Outreach] Failed to update listing status:', err.message);
  }
}

// ── POST /api/outreach/send ────────────────────────────────────────────────────

router.post('/send', async (req, res) => {
  try {
    const { listing_ids, action } = req.body;

    if (!listing_ids || !Array.isArray(listing_ids) || listing_ids.length === 0) {
      return res.status(400).json({ success: false, error: 'listing_ids array required' });
    }
    if (!['wa', 'call', 'wa_then_call'].includes(action)) {
      return res.status(400).json({ success: false, error: 'action must be: wa | call | wa_then_call' });
    }
    if (listing_ids.length > 100) {
      return res.status(400).json({ success: false, error: 'Max 100 listings per batch' });
    }

    // Fetch listings
    const placeholders = listing_ids.map((_, i) => `$${i + 1}`).join(', ');
    const result = await pool.query(
      `SELECT l.id, l.phone, l.contact_name, l.address, l.city, l.title,
              c.name as complex_name, c.city as complex_city
       FROM listings l
       LEFT JOIN complexes c ON c.id = l.complex_id
       WHERE l.id IN (${placeholders}) AND l.phone IS NOT NULL`,
      listing_ids
    );

    const listings = result.rows;
    if (!listings.length) {
      return res.json({ success: false, error: 'No listings with phone found' });
    }

    logger.info(`[Outreach] action=${action} count=${listings.length}`);

    const results = [];
    let sent = 0, failed = 0;

    for (const listing of listings) {
      const phone = listing.phone;
      let success = false;
      let detail = '';
      const now = new Date();

      try {
        if (action === 'wa') {
          const msg = buildWAMessage(listing);
          const waResult = await sendWA(phone, msg);
          success = waResult.success;
          detail = success ? `WA נשלח → ${waResult.normalized}` : `WA נכשל: ${waResult.error}`;
          if (success) await updateListingStatus(listing.id, 'sent', now);

        } else if (action === 'call') {
          const callResult = await sendCall(phone, listing);
          success = callResult.success;
          detail = success ? `שיחה יצאה → ${callResult.call_id}` : `שיחה נכשלה: ${callResult.error}`;
          if (success) await updateListingStatus(listing.id, 'called', now);

        } else if (action === 'wa_then_call') {
          // Send WA first
          const msg = buildWAMessage(listing);
          const waResult = await sendWA(phone, msg);
          success = waResult.success;
          detail = success ? `WA נשלח → ${waResult.normalized}` : `WA נכשל: ${waResult.error}`;

          if (success) {
            await updateListingStatus(listing.id, 'sent', now);
            // Schedule call after 2 hours via DB flag (cron will pick it up)
            try {
              await pool.query(
                `UPDATE listings SET
                   call_scheduled_at = NOW() + INTERVAL '2 hours',
                   notes = COALESCE(notes, '') || $1
                 WHERE id = $2`,
                [`\n[outreach ${now.toISOString()}] WA sent, call scheduled in 2h`, listing.id]
              );
              detail += ' | שיחה תצא בעוד ~2 שעות';
            } catch (e) {
              // Fallback: try to call now if scheduling fails
              const callResult = await sendCall(phone, listing);
              detail += callResult.success ? ' | שיחה יצאה מיד' : ` | שיחה נכשלה: ${callResult.error}`;
            }
          }
        }

        results.push({ id: listing.id, phone, success, detail });
        if (success) sent++; else failed++;

      } catch (err) {
        logger.error(`[Outreach] Error for listing ${listing.id}:`, err.message);
        results.push({ id: listing.id, phone, success: false, detail: err.message });
        failed++;
      }

      // Rate limit: 200ms between requests
      await new Promise(r => setTimeout(r, 200));
    }

    const detailLines = results.slice(0, 20).map(r => `${r.success ? '✅' : '❌'} ${r.phone}: ${r.detail}`).join('\n');
    const suffix = results.length > 20 ? `\n...ועוד ${results.length - 20}` : '';

    logger.info(`[Outreach] Done: sent=${sent} failed=${failed}`);

    res.json({
      success: true,
      sent,
      failed,
      total: listings.length,
      details: detailLines + suffix,
      results,
    });

  } catch (err) {
    logger.error('[Outreach] send error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/outreach/stats ───────────────────────────────────────────────────

router.get('/stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE message_status = 'sent')     AS wa_sent,
        COUNT(*) FILTER (WHERE message_status = 'replied')  AS replied,
        COUNT(*) FILTER (WHERE message_status = 'no_reply') AS no_reply,
        COUNT(*) FILTER (WHERE message_status = 'called')   AS called,
        COUNT(*) FILTER (WHERE phone IS NOT NULL)           AS with_phone,
        COUNT(*)                                             AS total
      FROM listings
      WHERE is_active = TRUE
    `);
    res.json({ success: true, stats: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/outreach/wa-then-call-cron ─────────────────────────────────────
// Called by cron every 30min — executes pending scheduled calls

router.post('/wa-then-call-cron', async (req, res) => {
  try {
    const pending = await pool.query(`
      SELECT l.id, l.phone, l.contact_name, l.city,
             c.name as complex_name, c.city as complex_city
      FROM listings l
      LEFT JOIN complexes c ON c.id = l.complex_id
      WHERE l.call_scheduled_at IS NOT NULL
        AND l.call_scheduled_at <= NOW()
        AND l.message_status = 'sent'
        AND l.phone IS NOT NULL
      LIMIT 20
    `);

    const listings = pending.rows;
    if (!listings.length) return res.json({ success: true, processed: 0 });

    let called = 0;
    for (const listing of listings) {
      const callResult = await sendCall(listing.phone, listing);
      if (callResult.success) {
        called++;
        await pool.query(
          `UPDATE listings SET call_scheduled_at = NULL, message_status = 'called' WHERE id = $1`,
          [listing.id]
        );
      } else {
        // Clear scheduled to avoid infinite retry
        await pool.query(
          `UPDATE listings SET call_scheduled_at = NULL WHERE id = $1`,
          [listing.id]
        );
      }
      await new Promise(r => setTimeout(r, 500));
    }

    logger.info(`[Outreach Cron] Processed ${listings.length}, called ${called}`);
    res.json({ success: true, processed: listings.length, called });

  } catch (err) {
    logger.error('[Outreach Cron] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
