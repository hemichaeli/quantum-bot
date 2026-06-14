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

// ── GET /api/moderation/dashboard ─────────────────────────────────────────────
// Human-readable view of handled comments (original + bot reply + status).
router.get('/dashboard', async (req, res) => {
  try {
    await ensureModerationTable();
    const { rows } = await pool.query(`
      SELECT created_at, platform, category, status, lang, comment_text, reply_text, user_name
      FROM moderation_queue ORDER BY created_at DESC LIMIT 200
    `);
    const c = (s) => rows.filter(r => r.status === s).length;
    const counts = { total: rows.length, replied: c('replied'), hidden: c('hidden'), draft: c('draft'), failed: c('reply_failed'), ignored: c('ignored') };
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    const badge = (st) => {
      const map = { replied: '#2e7d32', hidden: '#b71c1c', draft: '#b8860b', reply_failed: '#7f1d1d', ignored: '#555', hidden_failed: '#7f1d1d' };
      return `<span style="background:${map[st] || '#444'};color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;white-space:nowrap">${esc(st)}</span>`;
    };
    const catEmoji = { hostile: '😡', positive: '💚', spam: '🚫', neutral: '·' };
    const trs = rows.map(r => `
      <tr>
        <td class="muted nowrap">${esc(new Date(r.created_at).toLocaleString('he-IL'))}</td>
        <td class="nowrap">${r.platform === 'instagram' ? '📷 IG' : '📘 FB'}</td>
        <td class="nowrap">${catEmoji[r.category] || ''} ${esc(r.category || '')}</td>
        <td class="nowrap">${esc(r.lang || '')}</td>
        <td>${badge(r.status)}</td>
        <td class="cell">${esc((r.comment_text || '').slice(0, 320))}</td>
        <td class="cell reply">${esc(r.reply_text || '')}</td>
      </tr>`).join('');
    res.send(`<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="60">
<title>QUANTUM · ניהול תגובות</title>
<style>
  body{margin:0;background:#0f1115;color:#e8e8ea;font-family:Segoe UI,Arial,sans-serif}
  .wrap{max-width:1200px;margin:0 auto;padding:24px}
  h1{font-size:20px;margin:0 0 4px} .sub{color:#9aa0aa;font-size:13px;margin-bottom:18px}
  .cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px}
  .card{background:#171a21;border:1px solid #262b35;border-radius:12px;padding:14px 18px;min-width:110px}
  .card .n{font-size:26px;font-weight:700;color:#d4af37} .card .l{font-size:12px;color:#9aa0aa}
  table{width:100%;border-collapse:collapse;background:#171a21;border:1px solid #262b35;border-radius:12px;overflow:hidden}
  th,td{padding:10px 12px;text-align:right;border-bottom:1px solid #232833;font-size:13px;vertical-align:top}
  th{background:#1d212a;color:#9aa0aa;font-weight:600;position:sticky;top:0}
  .muted{color:#7f8694} .nowrap{white-space:nowrap} .cell{max-width:380px} .reply{color:#cfe8cf}
  tr:hover td{background:#1b1f27}
</style></head><body><div class="wrap">
  <h1>🛡️ QUANTUM · ניהול תגובות אוטומטי</h1>
  <div class="sub">מתרענן כל 60 שניות · drip 5/15 דק' · kill-switch: MODERATION_AUTOREPLY=off</div>
  <div class="cards">
    <div class="card"><div class="n">${counts.total}</div><div class="l">סה"כ</div></div>
    <div class="card"><div class="n" style="color:#5cd06a">${counts.replied}</div><div class="l">נענו</div></div>
    <div class="card"><div class="n" style="color:#e0726b">${counts.hidden}</div><div class="l">הוסתרו</div></div>
    <div class="card"><div class="n" style="color:#d8a73a">${counts.draft + counts.failed}</div><div class="l">ממתין/נכשל</div></div>
  </div>
  <table><thead><tr><th>זמן</th><th>פלטפורמה</th><th>סוג</th><th>שפה</th><th>סטטוס</th><th>תגובה מקורית</th><th>מענה הבוט</th></tr></thead>
  <tbody>${trs || '<tr><td colspan="7" class="muted" style="text-align:center;padding:30px">אין עדיין רשומות</td></tr>'}</tbody></table>
</div></body></html>`);
  } catch (err) {
    res.status(500).send(`<pre>dashboard error: ${err.message}</pre>`);
  }
});

module.exports = router;
