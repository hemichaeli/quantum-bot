/**
 * AI Service — Claude Sonnet primary, Gemini fallback
 * Used by whatsappWebhookRoutes for WA conversation handling
 */
const { logger } = require('./logger');

let anthropic = null;
let anthropicAvailable = false;

try {
  const Anthropic = require('@anthropic-ai/sdk');
  anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  anthropicAvailable = true;
} catch (e) {
  logger.warn('[aiService] Anthropic SDK not available:', e.message);
}

let lastProvider = 'none';
let lastError = null;

async function generateResponse(systemPrompt, userMessage) {
  // Try Claude first
  if (anthropicAvailable && process.env.ANTHROPIC_API_KEY) {
    try {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      });
      lastProvider = 'claude';
      lastError = null;
      return { text: response.content[0].text, provider: 'claude' };
    } catch (err) {
      logger.warn('[aiService] Claude failed, trying Gemini fallback:', err.message);
      lastError = err.message;
    }
  }

  // Fallback to Gemini via OpenAI-compatible API
  try {
    const axios = require('axios');
    const resp = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      {
        model: 'gemini-2.0-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        max_tokens: 1024
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY}`
        }
      }
    );
    lastProvider = 'gemini';
    lastError = null;
    return { text: resp.data.choices[0].message.content, provider: 'gemini' };
  } catch (err) {
    logger.error('[aiService] Both Claude and Gemini failed:', err.message);
    lastProvider = 'none';
    lastError = err.message;
    throw new Error('AI service unavailable: ' + err.message);
  }
}

function getStatus() {
  return {
    anthropicAvailable,
    lastProvider,
    lastError,
    hasApiKey: !!(process.env.ANTHROPIC_API_KEY)
  };
}

module.exports = { generateResponse, getStatus };
