/**
 * QUANTUM Moderation Bot — Social Media Moderation Service
 *
 * Scans Facebook Page and Instagram comments for negative/offensive content.
 * Uses GPT to classify comments.
 * Sends email to hemi.michaeli@gmail.com for approval before hiding + blocking.
 *
 * Platforms: Facebook Page + Instagram Business Account (via Meta Graph API)
 */

const axios  = require('axios');
const pool   = require('../db/pool');
const { logger } = require('./logger');

const META_ACCESS_TOKEN  = process.env.META_ACCESS_TOKEN  || '';
const META_FB_PAGE_ID    = process.env.META_FB_PAGE_ID    || '';
const META_IG_ACCOUNT_ID = process.env.META_IG_ACCOUNT_ID || '';
const OPENAI_API_KEY     = process.env.OPENAI_API_KEY     || '';
const APPROVAL_EMAIL     = process.env.MODERATION_APPROVAL_EMAIL || 'hemi.michaeli@gmail.com';
const SENDGRID_API_KEY   = process.env.SENDGRID_API_KEY   || '';
const FROM_EMAIL         = process.env.FROM_EMAIL         || 'bot@minhelet.org';

// ── DB Setup ──────────────────────────────────────────────────────────────────

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
}

// ── Meta Graph API ────────────────────────────────────────────────────────────

async function fetchFBComments() {
  if (!META_ACCESS_TOKEN || !META_FB_PAGE_ID) return [];

  try {
    // Get recent posts
    const postsResp = await axios.get(
      `https://graph.facebook.com/v19.0/${META_FB_PAGE_ID}/posts`,
      {
        params: {
          access_token: META_ACCESS_TOKEN,
          fields: 'id,message,created_time',
          limit: 10,
        },
        timeout: 10000,
      }
    );

    const posts = postsResp.data?.data || [];
    const allComments = [];

    for (const post of posts) {
      const commentsResp = await axios.get(
        `https://graph.facebook.com/v19.0/${post.id}/comments`,
        {
          params: {
            access_token: META_ACCESS_TOKEN,
            fields: 'id,message,from,created_time',
            limit: 50,
          },
          timeout: 10000,
        }
      );

      const comments = commentsResp.data?.data || [];
      for (const c of comments) {
        allComments.push({
          platform:   'facebook',
          comment_id: c.id,
          post_id:    post.id,
          user_id:    c.from?.id || null,
          user_name:  c.from?.name || null,
          text:       c.message || '',
          created_at: c.created_time,
        });
      }
    }

    return allComments;
  } catch (err) {
    logger.error('[Moderation] FB fetch error:', err.message);
    return [];
  }
}

async function fetchIGComments() {
  if (!META_ACCESS_TOKEN || !META_IG_ACCOUNT_ID) return [];

  try {
    // Get recent IG media
    const mediaResp = await axios.get(
      `https://graph.facebook.com/v19.0/${META_IG_ACCOUNT_ID}/media`,
      {
        params: {
          access_token: META_ACCESS_TOKEN,
          fields: 'id,caption,timestamp',
          limit: 10,
        },
        timeout: 10000,
      }
    );

    const media = mediaResp.data?.data || [];
    const allComments = [];

    for (const post of media) {
      const commentsResp = await axios.get(
        `https://graph.facebook.com/v19.0/${post.id}/comments`,
        {
          params: {
            access_token: META_ACCESS_TOKEN,
            fields: 'id,text,username,timestamp',
            limit: 50,
          },
          timeout: 10000,
        }
      );

      const comments = commentsResp.data?.data || [];
      for (const c of comments) {
        allComments.push({
          platform:   'instagram',
          comment_id: c.id,
          post_id:    post.id,
          user_id:    null,
          user_name:  c.username || null,
          text:       c.text || '',
          created_at: c.timestamp,
        });
      }
    }

    return allComments;
  } catch (err) {
    logger.error('[Moderation] IG fetch error:', err.message);
    return [];
  }
}

// ── AI Classification ─────────────────────────────────────────────────────────

async function classifyComment(text) {
  if (!OPENAI_API_KEY) {
    // Fallback: keyword-based classification
    return keywordClassify(text);
  }

  try {
    const resp = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `אתה מנוע מודרציה לרשתות חברתיות. עליך לסווג תגובות של משתמשים.
החזר JSON בלבד עם שדות:
- "score": מספר בין 0 ל-1 (0=תקין לחלוטין, 1=פוגעני/שלילי מאוד)
- "reason": הסבר קצר בעברית (מקסימום 20 מילים)
- "action": "hide" אם score >= 0.6, אחרת "ignore"

תגובות שיש לסמן (score >= 0.6):
- 욕설, גידופים, תוכן פוגעני
- הטרדה, איומים, גזענות
- ספאם, פרסומות לא רלוונטיות
- תוכן שלילי מאוד על החברה/עסק`,
          },
          {
            role: 'user',
            content: `סווג את התגובה הבאה:\n"${text}"`,
          },
        ],
        temperature: 0.1,
        max_tokens: 150,
        response_format: { type: 'json_object' },
      },
      {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );

    const result = JSON.parse(resp.data.choices[0].message.content);
    return {
      score:  parseFloat(result.score) || 0,
      reason: result.reason || '',
      action: result.action || 'ignore',
    };
  } catch (err) {
    logger.warn('[Moderation] GPT classify error:', err.message);
    return keywordClassify(text);
  }
}

function keywordClassify(text) {
  const lower = text.toLowerCase();
  const badWords = ['מניאק', 'זין', 'כוס', 'בן זונה', 'תמות', 'שרלטן', 'רמאי', 'גנב', 'שקרן', 'ספאם', 'spam'];
  const found = badWords.filter(w => lower.includes(w));
  if (found.length > 0) {
    return { score: 0.9, reason: `מילות מפתח פוגעניות: ${found.join(', ')}`, action: 'hide' };
  }
  return { score: 0.1, reason: 'תקין', action: 'ignore' };
}

// ── Email Approval ────────────────────────────────────────────────────────────

async function sendApprovalEmail(comment, classification) {
  const token = require('crypto').randomBytes(24).toString('hex');

  // Save to DB with token
  await pool.query(`
    INSERT INTO moderation_queue
      (platform, comment_id, post_id, user_id, user_name, comment_text, ai_score, ai_reason, status, approval_token)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending_approval', $9)
    ON CONFLICT (comment_id) DO NOTHING
  `, [
    comment.platform, comment.comment_id, comment.post_id,
    comment.user_id, comment.user_name, comment.text,
    classification.score, classification.reason, token,
  ]);

  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'https://quantum-bot-production.up.railway.app';

  const approveUrl = `${baseUrl}/api/moderation/approve/${token}`;
  const ignoreUrl  = `${baseUrl}/api/moderation/ignore/${token}`;

  const platformLabel = comment.platform === 'facebook' ? 'פייסבוק' : 'אינסטגרם';
  const scorePercent  = Math.round(classification.score * 100);

  const emailBody = `
<div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <h2 style="color: #c0392b;">⚠️ תגובה חשודה זוהתה — QUANTUM Moderation</h2>

  <table style="border-collapse: collapse; width: 100%; margin-bottom: 20px;">
    <tr><td style="padding: 8px; background: #f8f9fa; font-weight: bold;">פלטפורמה</td><td style="padding: 8px;">${platformLabel}</td></tr>
    <tr><td style="padding: 8px; background: #f8f9fa; font-weight: bold;">משתמש</td><td style="padding: 8px;">${comment.user_name || 'לא ידוע'}</td></tr>
    <tr><td style="padding: 8px; background: #f8f9fa; font-weight: bold;">תגובה</td><td style="padding: 8px; color: #c0392b;">"${comment.text}"</td></tr>
    <tr><td style="padding: 8px; background: #f8f9fa; font-weight: bold;">ציון AI</td><td style="padding: 8px;">${scorePercent}% פוגעני</td></tr>
    <tr><td style="padding: 8px; background: #f8f9fa; font-weight: bold;">סיבה</td><td style="padding: 8px;">${classification.reason}</td></tr>
  </table>

  <div style="text-align: center; margin: 30px 0;">
    <a href="${approveUrl}" style="background: #c0392b; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; margin: 0 10px; font-size: 16px;">
      ✅ אשר — הסתר וחסום
    </a>
    <a href="${ignoreUrl}" style="background: #7f8c8d; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; margin: 0 10px; font-size: 16px;">
      ❌ התעלם
    </a>
  </div>

  <p style="color: #7f8c8d; font-size: 12px;">QUANTUM Moderation Bot | ${new Date().toLocaleString('he-IL')}</p>
</div>
  `;

  // Send via SendGrid if configured, otherwise log
  if (SENDGRID_API_KEY) {
    try {
      await axios.post(
        'https://api.sendgrid.com/v3/mail/send',
        {
          personalizations: [{ to: [{ email: APPROVAL_EMAIL }] }],
          from: { email: FROM_EMAIL, name: 'QUANTUM Moderation Bot' },
          subject: `⚠️ תגובה חשודה ב${platformLabel} — אישור נדרש`,
          content: [{ type: 'text/html', value: emailBody }],
        },
        {
          headers: { Authorization: `Bearer ${SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      );
      logger.info(`[Moderation] Approval email sent for comment ${comment.comment_id}`);
    } catch (err) {
      logger.error('[Moderation] SendGrid error:', err.message);
    }
  } else {
    // Fallback: log the approval URLs
    logger.info(`[Moderation] APPROVAL NEEDED for ${comment.comment_id}:`);
    logger.info(`  Approve: ${approveUrl}`);
    logger.info(`  Ignore:  ${ignoreUrl}`);
  }

  return token;
}

// ── Hide Comment + Block User ─────────────────────────────────────────────────

async function hideAndBlockComment(commentId, platform, userId) {
  const results = { hidden: false, blocked: false };

  try {
    if (platform === 'facebook') {
      // Hide FB comment
      await axios.post(
        `https://graph.facebook.com/v19.0/${commentId}`,
        { is_hidden: true },
        {
          params: { access_token: META_ACCESS_TOKEN },
          timeout: 10000,
        }
      );
      results.hidden = true;

      // Block user from page (if userId available)
      if (userId && META_FB_PAGE_ID) {
        await axios.post(
          `https://graph.facebook.com/v19.0/${META_FB_PAGE_ID}/blocked`,
          { user: userId },
          {
            params: { access_token: META_ACCESS_TOKEN },
            timeout: 10000,
          }
        );
        results.blocked = true;
      }

    } else if (platform === 'instagram') {
      // Hide IG comment
      await axios.post(
        `https://graph.facebook.com/v19.0/${commentId}`,
        { is_hidden: true },
        {
          params: { access_token: META_ACCESS_TOKEN },
          timeout: 10000,
        }
      );
      results.hidden = true;
      // Note: IG user blocking requires different API flow
    }
  } catch (err) {
    logger.error(`[Moderation] Hide/block error for ${commentId}:`, err.message);
  }

  return results;
}

// ── Main Scan Job ─────────────────────────────────────────────────────────────

async function runModerationScan() {
  await ensureModerationTable();

  const [fbComments, igComments] = await Promise.all([
    fetchFBComments(),
    fetchIGComments(),
  ]);

  const allComments = [...fbComments, ...igComments];
  logger.info(`[Moderation] Scanning ${allComments.length} comments (FB: ${fbComments.length}, IG: ${igComments.length})`);

  let flagged = 0, skipped = 0;

  for (const comment of allComments) {
    // Skip already processed
    const existing = await pool.query(
      'SELECT id FROM moderation_queue WHERE comment_id = $1',
      [comment.comment_id]
    );
    if (existing.rows.length > 0) { skipped++; continue; }

    // Classify
    const classification = await classifyComment(comment.text);

    if (classification.action === 'hide') {
      flagged++;
      await sendApprovalEmail(comment, classification);
      logger.info(`[Moderation] Flagged ${comment.platform} comment ${comment.comment_id} (score=${classification.score})`);
    }

    await new Promise(r => setTimeout(r, 100));
  }

  return { total: allComments.length, flagged, skipped };
}

module.exports = {
  runModerationScan,
  hideAndBlockComment,
  ensureModerationTable,
  sendApprovalEmail,
};
