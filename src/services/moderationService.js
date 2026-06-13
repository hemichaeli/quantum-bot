/**
 * QUANTUM Moderation Bot — Social Media ENGAGEMENT Service
 *
 * NEW BEHAVIOR (2026-06-13): instead of hiding/blocking hostile commenters, the bot
 * REPLIES — calmly, in the commenter's own language — to antisemitic / anti-Israel /
 * "Free Palestine" / "genocide" / "baby killer" comments, and warmly to supportive ones.
 * Replies are measured and NEVER inflammatory. Spam is still hidden.
 *
 * Talking points (calm, defensible, dignified — never cruel):
 *   - Israel defends itself; it is only "aggressive" toward those who attack it.
 *   - The Jewish people has only ONE state in the world; other peoples have many.
 *   - We genuinely want peace. The path to peace: those attacking us lay down their
 *     weapons and stop attacking. Everyone here — Israeli and Palestinian — deserves
 *     to live in safety and dignity.
 *
 * Kill switch: set MODERATION_AUTOREPLY=off to stop posting (still classifies + logs).
 * Platforms: Facebook Page + Instagram (Meta Graph API). Token already in env.
 */

const axios  = require('axios');
const pool   = require('../db/pool');
const { logger } = require('./logger');

const META_ACCESS_TOKEN  = process.env.META_ACCESS_TOKEN  || '';
const META_FB_PAGE_ID    = process.env.META_FB_PAGE_ID    || '';
const META_IG_ACCOUNT_ID = process.env.META_IG_ACCOUNT_ID || '';
const OPENAI_API_KEY     = process.env.OPENAI_API_KEY     || '';
const AUTOREPLY          = (process.env.MODERATION_AUTOREPLY || 'on').toLowerCase() !== 'off';
const MAX_PER_RUN        = parseInt(process.env.MODERATION_MAX_PER_RUN || '5', 10); // drip slowly, not all at once
const GRAPH              = 'https://graph.facebook.com/v19.0';

// ── DB ──────────────────────────────────────────────────────────────────────
async function ensureModerationTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS moderation_queue (
      id              SERIAL PRIMARY KEY,
      platform        TEXT NOT NULL,
      comment_id      TEXT UNIQUE NOT NULL,
      post_id         TEXT,
      user_id         TEXT,
      user_name       TEXT,
      comment_text    TEXT,
      ai_score        FLOAT,
      ai_reason       TEXT,
      status          TEXT DEFAULT 'pending_approval',
      approval_token  TEXT UNIQUE,
      actioned_at     TIMESTAMP,
      created_at      TIMESTAMP DEFAULT NOW()
    )
  `);
  // new columns for the engagement flow (idempotent)
  await pool.query(`ALTER TABLE moderation_queue ADD COLUMN IF NOT EXISTS category TEXT`);
  await pool.query(`ALTER TABLE moderation_queue ADD COLUMN IF NOT EXISTS lang TEXT`);
  await pool.query(`ALTER TABLE moderation_queue ADD COLUMN IF NOT EXISTS reply_text TEXT`);
}

// ── Meta Graph: fetch ─────────────────────────────────────────────────────────
async function fetchFBComments() {
  if (!META_ACCESS_TOKEN || !META_FB_PAGE_ID) return [];
  try {
    const postsResp = await axios.get(`${GRAPH}/${META_FB_PAGE_ID}/posts`, {
      params: { access_token: META_ACCESS_TOKEN, fields: 'id,message,created_time', limit: 10 }, timeout: 10000,
    });
    const out = [];
    for (const post of postsResp.data?.data || []) {
      const c = await axios.get(`${GRAPH}/${post.id}/comments`, {
        params: { access_token: META_ACCESS_TOKEN, fields: 'id,message,from,created_time', limit: 50 }, timeout: 10000,
      });
      for (const cm of c.data?.data || []) out.push({ platform: 'facebook', comment_id: cm.id, post_id: post.id, user_id: cm.from?.id || null, user_name: cm.from?.name || null, text: cm.message || '' });
    }
    return out;
  } catch (err) { logger.error('[Moderation] FB fetch error:', err.response?.data ? JSON.stringify(err.response.data) : err.message); return []; }
}

async function fetchIGComments() {
  if (!META_ACCESS_TOKEN || !META_IG_ACCOUNT_ID) return [];
  try {
    const mediaResp = await axios.get(`${GRAPH}/${META_IG_ACCOUNT_ID}/media`, {
      params: { access_token: META_ACCESS_TOKEN, fields: 'id,caption,timestamp', limit: 10 }, timeout: 10000,
    });
    const out = [];
    for (const post of mediaResp.data?.data || []) {
      const c = await axios.get(`${GRAPH}/${post.id}/comments`, {
        params: { access_token: META_ACCESS_TOKEN, fields: 'id,text,username,timestamp', limit: 50 }, timeout: 10000,
      });
      for (const cm of c.data?.data || []) out.push({ platform: 'instagram', comment_id: cm.id, post_id: post.id, user_id: null, user_name: cm.username || null, text: cm.text || '' });
    }
    return out;
  } catch (err) { logger.error('[Moderation] IG fetch error:', err.response?.data ? JSON.stringify(err.response.data) : err.message); return []; }
}

// ── Classify (OpenAI) ─────────────────────────────────────────────────────────
async function classifyComment(text) {
  if (!OPENAI_API_KEY) return keywordClassify(text);
  try {
    const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content:
`Classify a comment on an Israeli real-estate brand's social post. Return JSON only:
{"category": one of ["hostile","positive","spam","neutral"], "lang": ISO-639-1 code, "score": 0..1}
- hostile: antisemitic, anti-Israel attacks, "Free Palestine", "genocide", "baby killer", "stolen land", slurs, calls to boycott/violence.
- positive: support, praise, interest, blessings.
- spam: ads, scams, links, gibberish.
- neutral: everything else.
"lang" = the language the comment is written in.` },
        { role: 'user', content: `Comment:\n"${text}"` },
      ],
      temperature: 0, max_tokens: 80, response_format: { type: 'json_object' },
    }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 12000 });
    const r = JSON.parse(resp.data.choices[0].message.content);
    return { category: r.category || 'neutral', lang: r.lang || 'en', score: parseFloat(r.score) || 0 };
  } catch (err) { logger.warn('[Moderation] classify error:', err.message); return keywordClassify(text); }
}

function keywordClassify(text) {
  const l = (text || '').toLowerCase();
  const hostile = ['free palestine', 'genocide', 'baby killer', 'apartheid', 'stolen land', 'occupier', 'nazi', 'coloniz', 'from the river', 'בייבי קילר', 'רוצח', 'אפרטהייד', 'כיבוש', 'גנוסייד'];
  if (hostile.some(w => l.includes(w))) return { category: 'hostile', lang: /[֐-׿]/.test(text) ? 'he' : 'en', score: 0.9 };
  const spam = ['http://', 'https://', 'whatsapp +', 'טלגרם', 'spam'];
  if (spam.some(w => l.includes(w))) return { category: 'spam', lang: 'en', score: 0.8 };
  return { category: 'neutral', lang: /[֐-׿]/.test(text) ? 'he' : 'en', score: 0.1 };
}

// ── Generate measured reply (OpenAI) ──────────────────────────────────────────
const REPLY_SYSTEM = `You write SHORT public comment replies for QUANTUM, an Israeli real-estate brand.
Reply in the SAME language as the comment. Keep it to 1-2 short, punchy, on-point sentences. This is social media, not an essay. Calm, never inflammatory. At most one 🕊️ or 🇮🇱.
NEVER use em-dashes or long dashes ("—" or "–"). Use only commas and periods.

ABSOLUTE RULES — never break:
- Never insult, mock, dehumanize, threaten, or use slurs. Never be inflammatory or sarcastic.
- Keep every human's dignity — Israeli and Palestinian alike. Stay calm and warm.
- Be factual and defensible. Do NOT assert contested or false claims.

FOR HOSTILE / ANTI-ISRAEL / ANTISEMITIC comments — answer calmly with (use ONE or two, gently):
- Israel defends itself; it acts firmly only against those who attack it.
- The Jewish people has only ONE state in the entire world; other peoples and faiths have many.
- We truly want peace. The path to peace is simple: those who attack us lay down their weapons and stop the attacks.
- Everyone here deserves to live in safety and dignity.
End on peace, never on provocation.

FOR POSITIVE comments — warm, grateful, human.

Return ONLY the reply text. No quotes, no preamble.`;

async function generateReply(text, category, lang) {
  if (!OPENAI_API_KEY) return null;
  try {
    const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: REPLY_SYSTEM },
        { role: 'user', content: `Comment language: ${lang}. Type: ${category}.\nComment:\n"""${text}"""\nWrite the reply now.` },
      ],
      temperature: 0.5, max_tokens: 140,
    }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 20000 });
    return (resp.data.choices[0].message.content || '').trim() || null;
  } catch (err) { logger.warn('[Moderation] generateReply error:', err.message); return null; }
}

// ── Meta Graph: reply / hide ──────────────────────────────────────────────────
async function postReply(platform, commentId, message) {
  const edge = platform === 'instagram' ? 'replies' : 'comments';
  await axios.post(`${GRAPH}/${commentId}/${edge}`, null, { params: { message, access_token: META_ACCESS_TOKEN }, timeout: 12000 });
}

async function hideComment(commentId) {
  await axios.post(`${GRAPH}/${commentId}`, null, { params: { is_hidden: true, access_token: META_ACCESS_TOKEN }, timeout: 10000 });
}

// kept for manual/admin use (e.g. extreme cases)
async function hideAndBlockComment(commentId, platform, userId) {
  const results = { hidden: false, blocked: false };
  try {
    await hideComment(commentId); results.hidden = true;
    if (platform === 'facebook' && userId && META_FB_PAGE_ID) {
      await axios.post(`${GRAPH}/${META_FB_PAGE_ID}/blocked`, { user: userId }, { params: { access_token: META_ACCESS_TOKEN }, timeout: 10000 });
      results.blocked = true;
    }
  } catch (err) { logger.error(`[Moderation] hide/block error ${commentId}:`, err.message); }
  return results;
}

// ── Main scan: reply to hostile + positive, hide spam ─────────────────────────
async function runModerationScan() {
  await ensureModerationTable();
  const [fb, ig] = await Promise.all([fetchFBComments(), fetchIGComments()]);
  const all = [...fb, ...ig];
  logger.info(`[Moderation] scanning ${all.length} comments (FB:${fb.length} IG:${ig.length}) autoreply=${AUTOREPLY}`);
  let replied = 0, hidden = 0, skipped = 0;

  for (const c of all) {
    if (!c.text?.trim()) continue;
    const seen = await pool.query('SELECT id FROM moderation_queue WHERE comment_id=$1', [c.comment_id]);
    if (seen.rows.length) { skipped++; continue; }

    const cls = await classifyComment(c.text);
    let status = 'ignored', reply = null;

    if (cls.category === 'hostile' || cls.category === 'positive') {
      reply = await generateReply(c.text, cls.category, cls.lang);
      if (reply && AUTOREPLY) {
        try { await postReply(c.platform, c.comment_id, reply); replied++; status = 'replied'; }
        catch (err) { logger.error(`[Moderation] reply failed ${c.comment_id}:`, err.response?.data ? JSON.stringify(err.response.data).slice(0,160) : err.message); status = 'reply_failed'; }
      } else if (reply) { status = 'draft'; }
    } else if (cls.category === 'spam') {
      try { await hideComment(c.comment_id); hidden++; status = 'hidden'; } catch (e) { status = 'hide_failed'; }
    }

    await pool.query(
      `INSERT INTO moderation_queue (platform, comment_id, post_id, user_id, user_name, comment_text, ai_score, ai_reason, category, lang, reply_text, status, actioned_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW()) ON CONFLICT (comment_id) DO NOTHING`,
      [c.platform, c.comment_id, c.post_id, c.user_id, c.user_name, c.text, cls.score, cls.category, cls.category, cls.lang, reply, status]
    );
    if (replied >= MAX_PER_RUN) { logger.info(`[Moderation] per-run cap ${MAX_PER_RUN} reached, pausing until next run`); break; }
    await new Promise(r => setTimeout(r, 120));
  }
  logger.info(`[Moderation] done - replied:${replied} hidden:${hidden} skipped:${skipped}`);
  return { total: all.length, replied, hidden, skipped };
}

module.exports = { runModerationScan, generateReply, classifyComment, postReply, hideComment, hideAndBlockComment, ensureModerationTable };
