/**
 * Yad2 Messenger — In-platform messaging via Yad2 chat
 * Uses Puppeteer (headless Chromium) to log in to Yad2 and send messages
 * through the platform's native messaging system.
 *
 * Requires env vars: YAD2_EMAIL, YAD2_PASSWORD
 * Requires: Dockerfile with Chromium installed (PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium)
 */
const { logger } = require('./logger');

const YAD2_EMAIL = process.env.YAD2_EMAIL;
const YAD2_PASSWORD = process.env.YAD2_PASSWORD;
const EXEC_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

let browser = null;
let page = null;
let loggedIn = false;
let lastLoginAt = null;

function isConfigured() {
  return !!(YAD2_EMAIL && YAD2_PASSWORD);
}

function getStatus() {
  let puppeteerAvailable = false;
  try { require('puppeteer'); puppeteerAvailable = true; } catch (e) {}
  return {
    available: isConfigured() && puppeteerAvailable,
    puppeteerAvailable,
    hasCredentials: isConfigured(),
    loggedIn,
    lastLoginAt,
    executablePath: EXEC_PATH
  };
}

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch (e) {
    throw new Error('Puppeteer not installed');
  }
  browser = await puppeteer.launch({
    headless: 'new',
    executablePath: EXEC_PATH,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ]
  });
  logger.info('[yad2Messenger] Browser launched');
  return browser;
}

async function login() {
  if (!isConfigured()) {
    return { success: false, reason: 'no_credentials' };
  }
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    logger.info('[yad2Messenger] Navigating to Yad2 login...');
    await page.goto('https://www.yad2.co.il/auth/login', { waitUntil: 'networkidle2', timeout: 30000 });

    // Fill email
    await page.waitForSelector('input[type="email"], input[name="email"], input[placeholder*="מייל"], input[placeholder*="email"]', { timeout: 10000 });
    await page.type('input[type="email"], input[name="email"]', YAD2_EMAIL, { delay: 50 });

    // Fill password
    await page.type('input[type="password"]', YAD2_PASSWORD, { delay: 50 });

    // Submit
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });

    // Check if logged in
    const url = page.url();
    if (url.includes('/auth/login')) {
      logger.error('[yad2Messenger] Login failed — still on login page');
      loggedIn = false;
      return { success: false, reason: 'invalid_credentials' };
    }

    loggedIn = true;
    lastLoginAt = new Date().toISOString();
    logger.info('[yad2Messenger] Logged in successfully');
    return { success: true };
  } catch (err) {
    logger.error('[yad2Messenger] Login error:', err.message);
    loggedIn = false;
    return { success: false, error: err.message };
  }
}

async function ensureLoggedIn() {
  if (loggedIn && page && !page.isClosed()) {
    // Re-check every 30 minutes
    const thirtyMin = 30 * 60 * 1000;
    if (lastLoginAt && (Date.now() - new Date(lastLoginAt).getTime()) < thirtyMin) {
      return true;
    }
  }
  const result = await login();
  return result.success;
}

async function sendMessage(listingUrl, message) {
  if (!isConfigured()) {
    logger.warn('[yad2Messenger] sendMessage() skipped — no credentials');
    return { success: false, reason: 'no_credentials', fallback: 'use_inforu_whatsapp' };
  }

  try {
    const ok = await ensureLoggedIn();
    if (!ok) return { success: false, reason: 'login_failed' };

    logger.info('[yad2Messenger] Navigating to listing:', listingUrl);
    await page.goto(listingUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // Look for the contact/message button
    const msgBtnSelectors = [
      'button[data-testid="contact-seller-button"]',
      'button[class*="contact"]',
      'button[class*="message"]',
      '[data-testid="send-message"]',
      'button:has-text("שלח הודעה")',
      'button:has-text("צור קשר")'
    ];

    let clicked = false;
    for (const sel of msgBtnSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 3000 });
        await page.click(sel);
        clicked = true;
        logger.info('[yad2Messenger] Clicked contact button:', sel);
        break;
      } catch (e) { /* try next */ }
    }

    if (!clicked) {
      logger.warn('[yad2Messenger] Could not find contact button on:', listingUrl);
      return { success: false, reason: 'no_contact_button', url: listingUrl };
    }

    // Wait for message textarea
    await page.waitForSelector('textarea', { timeout: 8000 });
    await page.evaluate(() => {
      const ta = document.querySelector('textarea');
      if (ta) ta.value = '';
    });
    await page.type('textarea', message, { delay: 30 });

    // Submit
    const submitSelectors = ['button[type="submit"]', 'button:has-text("שלח")', '[data-testid="send-button"]'];
    let submitted = false;
    for (const sel of submitSelectors) {
      try {
        await page.click(sel);
        submitted = true;
        break;
      } catch (e) { /* try next */ }
    }

    if (!submitted) {
      await page.keyboard.press('Enter');
    }

    await page.waitForTimeout(2000);
    logger.info('[yad2Messenger] Message sent to:', listingUrl);
    return { success: true, url: listingUrl };
  } catch (err) {
    logger.error('[yad2Messenger] sendMessage error:', err.message);
    return { success: false, error: err.message };
  }
}

async function checkReplies() {
  if (!isConfigured()) {
    return { success: false, reason: 'no_credentials', replies: [] };
  }
  try {
    const ok = await ensureLoggedIn();
    if (!ok) return { success: false, reason: 'login_failed', replies: [] };

    await page.goto('https://www.yad2.co.il/my-ads/messages', { waitUntil: 'networkidle2', timeout: 30000 });

    // Extract unread messages
    const replies = await page.evaluate(() => {
      const items = document.querySelectorAll('[class*="message-item"], [class*="chat-item"]');
      const results = [];
      items.forEach(item => {
        const unread = item.querySelector('[class*="unread"]');
        if (unread) {
          results.push({
            text: item.querySelector('[class*="message-text"]')?.innerText || '',
            sender: item.querySelector('[class*="sender"]')?.innerText || '',
            time: item.querySelector('[class*="time"]')?.innerText || ''
          });
        }
      });
      return results;
    });

    logger.info(`[yad2Messenger] Found ${replies.length} unread replies`);
    return { success: true, replies };
  } catch (err) {
    logger.error('[yad2Messenger] checkReplies error:', err.message);
    return { success: false, error: err.message, replies: [] };
  }
}

async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
    page = null;
    loggedIn = false;
    logger.info('[yad2Messenger] Browser closed');
  }
}

module.exports = { isConfigured, getStatus, login, sendMessage, checkReplies, closeBrowser };
