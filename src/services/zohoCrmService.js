/**
 * QUANTUM Bot — Zoho CRM Leads Service
 * Fetches leads from Zoho CRM (scraped ad contacts)
 * and syncs them to the local DB for outreach processing.
 */

const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

const ZOHO_CLIENT_ID     = process.env.ZOHO_CLIENT_ID     || '';
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || '';
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || '';
const ZOHO_API_DOMAIN    = process.env.ZOHO_API_DOMAIN    || 'https://www.zohoapis.com';

let _accessToken = null;
let _tokenExpiry = 0;

// ── OAuth Token ───────────────────────────────────────────────────────────────

async function getAccessToken() {
  if (_accessToken && Date.now() < _tokenExpiry - 60000) return _accessToken;

  const resp = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, {
    params: {
      refresh_token: ZOHO_REFRESH_TOKEN,
      client_id:     ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET,
      grant_type:    'refresh_token',
    },
    timeout: 10000,
  });

  if (!resp.data?.access_token) throw new Error('Zoho token refresh failed');
  _accessToken = resp.data.access_token;
  _tokenExpiry = Date.now() + (resp.data.expires_in || 3600) * 1000;
  return _accessToken;
}

// ── Fetch Leads from Zoho CRM ─────────────────────────────────────────────────

/**
 * Fetch leads from Zoho CRM Leads module
 * Filters by: Lead_Source = 'Ad Scraping' (or custom field)
 * Returns array of lead objects
 */
async function fetchLeadsFromZoho({ page = 1, perPage = 100, leadSource = null } = {}) {
  const token = await getAccessToken();

  const params = {
    page,
    per_page: perPage,
    sort_by: 'Created_Time',
    sort_order: 'desc',
  };

  // Filter by lead source if specified
  let url = `${ZOHO_API_DOMAIN}/crm/v3/Leads`;
  if (leadSource) {
    // Use COQL for filtered query
    url = `${ZOHO_API_DOMAIN}/crm/v3/coql`;
    const query = `SELECT id, First_Name, Last_Name, Phone, Mobile, Email, Lead_Source, City, Description, Created_Time, Last_Activity_Time FROM Leads WHERE Lead_Source = '${leadSource}' ORDER BY Created_Time DESC LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`;

    const resp = await axios.post(url, { select_query: query }, {
      headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
      timeout: 15000,
    });

    return (resp.data?.data || []).map(normalizeZohoLead);
  }

  const resp = await axios.get(url, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params,
    timeout: 15000,
  });

  return (resp.data?.data || []).map(normalizeZohoLead);
}

function normalizeZohoLead(lead) {
  const firstName = lead.First_Name || '';
  const lastName  = lead.Last_Name  || '';
  const fullName  = [firstName, lastName].filter(Boolean).join(' ') || 'ליד';
  const phone     = lead.Mobile || lead.Phone || null;

  return {
    zoho_id:      lead.id,
    contact_name: fullName,
    phone:        phone ? phone.replace(/[^0-9+]/g, '') : null,
    email:        lead.Email || null,
    city:         lead.City || null,
    description:  lead.Description || null,
    lead_source:  lead.Lead_Source || null,
    created_at:   lead.Created_Time || null,
  };
}

// ── Sync Zoho Leads to Local DB ───────────────────────────────────────────────

async function ensureLeadsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS zoho_leads (
      id                SERIAL PRIMARY KEY,
      zoho_id           TEXT UNIQUE NOT NULL,
      contact_name      TEXT,
      phone             TEXT,
      email             TEXT,
      city              TEXT,
      description       TEXT,
      lead_source       TEXT,
      outreach_status   TEXT DEFAULT 'pending',
      wa_sent_at        TIMESTAMP,
      call_scheduled_at TIMESTAMP,
      call_sent_at      TIMESTAMP,
      replied_at        TIMESTAMP,
      notes             TEXT,
      created_at        TIMESTAMP DEFAULT NOW(),
      updated_at        TIMESTAMP DEFAULT NOW()
    )
  `);
}

async function syncLeadsFromZoho({ leadSource = null } = {}) {
  await ensureLeadsTable();

  let page = 1;
  let totalSynced = 0;
  let totalNew = 0;

  while (true) {
    const leads = await fetchLeadsFromZoho({ page, perPage: 100, leadSource });
    if (!leads.length) break;

    for (const lead of leads) {
      if (!lead.phone) continue;

      const result = await pool.query(`
        INSERT INTO zoho_leads (zoho_id, contact_name, phone, email, city, description, lead_source)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (zoho_id) DO UPDATE SET
          contact_name = EXCLUDED.contact_name,
          phone        = EXCLUDED.phone,
          city         = EXCLUDED.city,
          updated_at   = NOW()
        RETURNING (xmax = 0) AS is_new
      `, [lead.zoho_id, lead.contact_name, lead.phone, lead.email, lead.city, lead.description, lead.lead_source]);

      totalSynced++;
      if (result.rows[0]?.is_new) totalNew++;
    }

    if (leads.length < 100) break;
    page++;
  }

  logger.info(`[ZohoCRM] Synced ${totalSynced} leads (${totalNew} new)`);
  return { totalSynced, totalNew };
}

// ── Get Pending Leads for Outreach ────────────────────────────────────────────

async function getPendingLeads({ limit = 50 } = {}) {
  await ensureLeadsTable();

  const { rows } = await pool.query(`
    SELECT * FROM zoho_leads
    WHERE outreach_status = 'pending'
      AND phone IS NOT NULL
    ORDER BY created_at DESC
    LIMIT $1
  `, [limit]);

  return rows;
}

// ── Get Leads Ready for Call Escalation (3 hours after WA) ───────────────────

async function getLeadsReadyForEscalation() {
  await ensureLeadsTable();

  const { rows } = await pool.query(`
    SELECT * FROM zoho_leads
    WHERE outreach_status = 'wa_sent'
      AND wa_sent_at IS NOT NULL
      AND wa_sent_at <= NOW() - INTERVAL '3 hours'
      AND call_scheduled_at IS NULL
      AND replied_at IS NULL
      AND phone IS NOT NULL
    ORDER BY wa_sent_at ASC
    LIMIT 30
  `);

  return rows;
}

// ── Write QUANTUM Campaign ID to Zoho CRM ────────────────────────────────────

/**
 * Updates the QUANTUM_Campaign_ID custom field on a Zoho CRM Lead record.
 * Called whenever a lead is added to a QUANTUM Bot campaign.
 * @param {string} zohoLeadId  - The Zoho CRM lead record ID
 * @param {string|number} campaignId - The QUANTUM Bot campaign ID (from local DB)
 */
async function setZohoCampaignId(zohoLeadId, campaignId) {
  if (!zohoLeadId || !campaignId) return;
  try {
    const token = await getAccessToken();
    const resp = await axios.put(
      `${ZOHO_API_DOMAIN}/crm/v3/Leads/${zohoLeadId}`,
      { data: [{ QUANTUM_Campaign_ID: String(campaignId) }] },
      { headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    const result = resp.data?.data?.[0];
    if (result?.code === 'SUCCESS') {
      logger.info(`[ZohoCRM] Set QUANTUM_Campaign_ID=${campaignId} on lead ${zohoLeadId}`);
    } else {
      logger.warn(`[ZohoCRM] setZohoCampaignId unexpected response`, { zohoLeadId, campaignId, result });
    }
  } catch (err) {
    logger.error(`[ZohoCRM] setZohoCampaignId failed`, { zohoLeadId, campaignId, error: err.message });
  }
}

async function updateLeadStatus(id, status, extra = {}) {
  const updates = ['outreach_status = $1', 'updated_at = NOW()'];
  const values  = [status];
  let idx = 2;

  if (extra.wa_sent_at)        { updates.push(`wa_sent_at = $${idx++}`);        values.push(extra.wa_sent_at); }
  if (extra.call_scheduled_at) { updates.push(`call_scheduled_at = $${idx++}`); values.push(extra.call_scheduled_at); }
  if (extra.call_sent_at)      { updates.push(`call_sent_at = $${idx++}`);      values.push(extra.call_sent_at); }
  if (extra.replied_at)        { updates.push(`replied_at = $${idx++}`);        values.push(extra.replied_at); }
  if (extra.notes)             { updates.push(`notes = COALESCE(notes,'') || $${idx++}`); values.push('\n' + extra.notes); }

  values.push(id);
  await pool.query(
    `UPDATE zoho_leads SET ${updates.join(', ')} WHERE id = $${idx}`,
    values
  );
}

module.exports = {
  fetchLeadsFromZoho,
  syncLeadsFromZoho,
  getPendingLeads,
  getLeadsReadyForEscalation,
  updateLeadStatus,
  ensureLeadsTable,
  setZohoCampaignId,
};
