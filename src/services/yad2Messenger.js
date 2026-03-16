/**
 * Yad2 Messenger — In-platform messaging via Yad2 chat
 * NOTE: Requires Puppeteer (headless Chrome) which is not available in Railway.
 * This service gracefully stubs all methods and logs warnings.
 * To enable: install puppeteer and set YAD2_EMAIL + YAD2_PASSWORD env vars.
 */
const { logger } = require('./logger');

const PUPPETEER_AVAILABLE = (() => {
  try { require('puppeteer'); return true; } catch (e) { return false; }
})();

const YAD2_EMAIL = process.env.YAD2_EMAIL;
const YAD2_PASSWORD = process.env.YAD2_PASSWORD;
const configured = PUPPETEER_AVAILABLE && !!(YAD2_EMAIL && YAD2_PASSWORD);

if (!PUPPETEER_AVAILABLE) {
  logger.warn('[yad2Messenger] Puppeteer not available — in-platform Yad2 messaging disabled. Using INFORU WhatsApp fallback instead.');
}

function getStatus() {
  return {
    available: configured,
    puppeteerAvailable: PUPPETEER_AVAILABLE,
    hasCredentials: !!(YAD2_EMAIL && YAD2_PASSWORD),
    loggedIn: false,
    reason: !PUPPETEER_AVAILABLE ? 'puppeteer_not_installed' : !YAD2_EMAIL ? 'no_credentials' : 'ok'
  };
}

async function login() {
  if (!configured) {
    return { success: false, reason: getStatus().reason };
  }
  // Full Puppeteer implementation would go here
  logger.warn('[yad2Messenger] login() called but Puppeteer not available');
  return { success: false, reason: 'puppeteer_not_available' };
}

async function sendMessage(listingUrl, message) {
  if (!configured) {
    logger.warn('[yad2Messenger] sendMessage() skipped — not configured. URL:', listingUrl);
    return { success: false, reason: 'not_configured', fallback: 'use_inforu_whatsapp' };
  }
  logger.warn('[yad2Messenger] sendMessage() called but Puppeteer not available');
  return { success: false, reason: 'puppeteer_not_available' };
}

async function checkReplies() {
  if (!configured) {
    return { success: false, reason: 'not_configured', replies: [] };
  }
  return { success: false, reason: 'puppeteer_not_available', replies: [] };
}

module.exports = { getStatus, login, sendMessage, checkReplies };
