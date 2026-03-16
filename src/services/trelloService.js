/**
 * Trello Service — QUANTUM Lead Card Management
 * Creates cards for new leads in the appropriate Trello board/list
 * Requires: TRELLO_API_KEY, TRELLO_TOKEN, TRELLO_BOARD_ID
 */
const { logger } = require('./logger');

const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const TRELLO_BOARD_ID = process.env.TRELLO_BOARD_ID;
const TRELLO_BASE = 'https://api.trello.com/1';

let configured = !!(TRELLO_API_KEY && TRELLO_TOKEN && TRELLO_BOARD_ID);

function isConfigured() {
  return configured;
}

function getStatus() {
  return {
    configured,
    boardId: TRELLO_BOARD_ID || null,
    hasApiKey: !!TRELLO_API_KEY,
    hasToken: !!TRELLO_TOKEN
  };
}

async function getListId(listName) {
  if (!configured) return null;
  try {
    const axios = require('axios');
    const resp = await axios.get(`${TRELLO_BASE}/boards/${TRELLO_BOARD_ID}/lists`, {
      params: { key: TRELLO_API_KEY, token: TRELLO_TOKEN, fields: 'name,id' }
    });
    const list = resp.data.find(l => l.name.toLowerCase().includes(listName.toLowerCase()));
    return list ? list.id : resp.data[0]?.id || null;
  } catch (err) {
    logger.warn('[trello] Failed to get list ID:', err.message);
    return null;
  }
}

async function createCard({ name, desc, listName = 'מוכרים', labels = [], due = null }) {
  if (!configured) {
    logger.warn('[trello] Not configured — skipping card creation');
    return { success: false, reason: 'not_configured' };
  }
  try {
    const axios = require('axios');
    const listId = await getListId(listName);
    if (!listId) throw new Error('Could not find list: ' + listName);

    const params = {
      key: TRELLO_API_KEY,
      token: TRELLO_TOKEN,
      name,
      desc,
      idList: listId,
      ...(due ? { due } : {})
    };

    const resp = await axios.post(`${TRELLO_BASE}/cards`, null, { params });
    logger.info('[trello] Card created:', { id: resp.data.id, name });
    return { success: true, cardId: resp.data.id, cardUrl: resp.data.shortUrl };
  } catch (err) {
    logger.error('[trello] Failed to create card:', err.message);
    return { success: false, error: err.message };
  }
}

async function createInvestorCard(lead) {
  return createCard({
    name: `🏢 משקיע: ${lead.name} | ${lead.phone}`,
    desc: `**שם:** ${lead.name}\n**טלפון:** ${lead.phone}\n**אימייל:** ${lead.email || 'לא צוין'}\n**מקור:** ${lead.source || 'אתר'}\n\n${JSON.stringify(lead.form_data || {}, null, 2)}`,
    listName: 'מוכרים'
  });
}

async function createSellerCard(lead) {
  return createCard({
    name: `🏠 מוכר: ${lead.name} | ${lead.phone}`,
    desc: `**שם:** ${lead.name}\n**טלפון:** ${lead.phone}\n**אימייל:** ${lead.email || 'לא צוין'}\n**מקור:** ${lead.source || 'אתר'}\n\n${JSON.stringify(lead.form_data || {}, null, 2)}`,
    listName: 'מוכרים'
  });
}

async function createContactCard(lead) {
  return createCard({
    name: `📩 פנייה: ${lead.name} | ${lead.phone}`,
    desc: `**שם:** ${lead.name}\n**טלפון:** ${lead.phone}\n**אימייל:** ${lead.email || 'לא צוין'}\n**מקור:** ${lead.source || 'אתר'}\n\n${JSON.stringify(lead.form_data || {}, null, 2)}`,
    listName: 'מוכרים'
  });
}

async function createNotificationCard(title, desc, listName = 'התראות') {
  return createCard({ name: title, desc, listName });
}

module.exports = {
  isConfigured,
  getStatus,
  createCard,
  createInvestorCard,
  createSellerCard,
  createContactCard,
  createNotificationCard
};
