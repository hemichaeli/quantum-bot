/**
 * QUANTUM Moderation Bot — Routes
 *
 * POST /api/moderation/scan             — run moderation scan (FB + IG)
 * GET  /api/moderation/queue            — list pending approvals
 * GET  /api/moderation/approve/:token   — approve (hide + block) via email link
 * GET  /api/moderation/ignore/:token    — ignore via email link
 * GET  /api/moderation/stats            — moderation stats
 */

const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const { logger } = require('../services/logger');
const { runModerationScan, hideAndBlockComment, ensureModerationTable } = require('../services/moderationService');

// ── POST /api/moderation/scan ─────────────────────────────────────────────────

router.post('/scan', async (req, res) => {
  try {
    const result = await runModerationScan();
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('[Moderation] scan error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/moderation/queue ─────────────────────────────────────────────────

router.get('/queue', async (req, res) => {
  try {
    await ensureModerationTable();
    const { rows } = await pool.query(`
      SELECT * FROM moderation_queue
      WHERE status = 'pending_approval'
      ORDER BY created_at DESC
      LIMIT 50
    `);
    res.json({ success: true, total: rows.length, queue: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/moderation/approve/:token ───────────────────────────────────────
// Called from email approval link — hides comment and blocks user

router.get('/approve/:token', async (req, res) => {
  try {
    await ensureModerationTable();
    const { rows } = await pool.query(
      `SELECT * FROM moderation_queue WHERE approval_token = $1 AND status = 'pending_approval'`,
      [req.params.token]
    );

    if (!rows.length) {
      return res.send(`
        <html><body dir="rtl" style="font-family:Arial;text-align:center;padding:40px;">
          <h2>❌ לא נמצא — ייתכן שכבר טופל</h2>
        </body></html>
      `);
    }

    const item = rows[0];
    const result = await hideAndBlockComment(item.comment_id, item.platform, item.user_id);

    await pool.query(
      `UPDATE moderation_queue SET status = 'actioned', actioned_at = NOW() WHERE id = $1`,
      [item.id]
    );

    const platformLabel = item.platform === 'facebook' ? 'פייסבוק' : 'אינסטגרם';
    logger.info(`[Moderation] Approved: ${item.comment_id} hidden=${result.hidden} blocked=${result.blocked}`);

    res.send(`
      <html><body dir="rtl" style="font-family:Arial;text-align:center;padding:40px;background:#f8f9fa;">
        <div style="max-width:500px;margin:0 auto;background:white;padding:30px;border-radius:10px;box-shadow:0 2px 10px rgba(0,0,0,0.1);">
          <h2 style="color:#27ae60;">✅ בוצע בהצלחה</h2>
          <p><strong>פלטפורמה:</strong> ${platformLabel}</p>
          <p><strong>משתמש:</strong> ${item.user_name || 'לא ידוע'}</p>
          <p><strong>תגובה:</strong> "${item.comment_text}"</p>
          <hr/>
          <p>הוסתרה: ${result.hidden ? '✅' : '❌'}</p>
          <p>נחסם: ${result.blocked ? '✅' : '❌ (לא זמין לפלטפורמה זו)'}</p>
        </div>
      </body></html>
    `);
  } catch (err) {
    logger.error('[Moderation] approve error:', err.message);
    res.status(500).send(`<html><body dir="rtl" style="font-family:Arial;text-align:center;padding:40px;"><h2>שגיאה: ${err.message}</h2></body></html>`);
  }
});

// ── GET /api/moderation/ignore/:token ────────────────────────────────────────

router.get('/ignore/:token', async (req, res) => {
  try {
    await ensureModerationTable();
    const result = await pool.query(
      `UPDATE moderation_queue SET status = 'ignored', actioned_at = NOW()
       WHERE approval_token = $1 AND status = 'pending_approval'
       RETURNING id`,
      [req.params.token]
    );

    if (!result.rows.length) {
      return res.send(`
        <html><body dir="rtl" style="font-family:Arial;text-align:center;padding:40px;">
          <h2>❌ לא נמצא — ייתכן שכבר טופל</h2>
        </body></html>
      `);
    }

    res.send(`
      <html><body dir="rtl" style="font-family:Arial;text-align:center;padding:40px;background:#f8f9fa;">
        <div style="max-width:500px;margin:0 auto;background:white;padding:30px;border-radius:10px;box-shadow:0 2px 10px rgba(0,0,0,0.1);">
          <h2 style="color:#7f8c8d;">✓ התגובה סומנה כ"התעלם"</h2>
          <p>לא בוצעה פעולה על התגובה.</p>
        </div>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send(`<html><body dir="rtl"><h2>שגיאה: ${err.message}</h2></body></html>`);
  }
});

// ── GET /api/moderation/stats ─────────────────────────────────────────────────

router.get('/stats', async (req, res) => {
  try {
    await ensureModerationTable();
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)                                                    AS total_scanned,
        COUNT(*) FILTER (WHERE status = 'pending_approval')        AS pending,
        COUNT(*) FILTER (WHERE status = 'actioned')                AS actioned,
        COUNT(*) FILTER (WHERE status = 'ignored')                 AS ignored,
        COUNT(*) FILTER (WHERE platform = 'facebook')              AS facebook,
        COUNT(*) FILTER (WHERE platform = 'instagram')             AS instagram,
        ROUND(AVG(ai_score)::numeric, 2)                           AS avg_ai_score
      FROM moderation_queue
    `);
    res.json({ success: true, stats: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
