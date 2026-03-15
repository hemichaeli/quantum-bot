// autoFirstContactService.js
// Issue #3 — שליחת הודעת WhatsApp ראשונה אוטומטית לכל מפרסם חדש
// Issue #5 — כינוסי נכסים: פנייה אוטומטית, סינון קווי ארץ
// P0 - דחוף ביותר

const pool = require('../db/pool');
const axios = require('axios');

const INFORU_USERNAME = process.env.INFORU_USERNAME || 'hemichaeli';
const INFORU_TOKEN = process.env.INFORU_TOKEN || '95452ace-07cf-48be-8671-a197c15d3c17';
const INFORU_BUSINESS_LINE = process.env.INFORU_BUSINESS_LINE || '037572229';
const INFORU_API_URL = 'https://capi.inforu.co.il/api/v2/WhatsApp/SendWhatsAppChat';

// בדוק אם מספר הוא נייד ישראלי (05x)
function isMobilePhone(phone) {
    if (!phone) return false;
    const clean = phone.replace(/[^0-9]/g, '');
    // Israeli mobile: 05x... (10 digits starting with 05)
    // Or 9725x... (international format)
    return /^05\d{8}$/.test(clean) || /^9725\d{8}$/.test(clean);
}

// נקה מספר טלפון לפורמט בינלאומי
function normalizePhone(phone) {
    if (!phone) return null;
    let clean = phone.replace(/[^0-9]/g, '');
    if (clean.startsWith('0')) clean = '972' + clean.substring(1);
    if (!clean.startsWith('972')) clean = '972' + clean;
    return clean;
}

// בנה הודעה ראשונה לפי סוג מקור וכתובת הנכס
function buildFirstMessage(listing, source) {
    const location = listing.address || listing.city || 'האזור שלך';
    const city = listing.city || '';

    if (source === 'facebook') {
        return `שלום! ראינו את המודעה שלך ב-${location}${city ? ` (${city})` : ''}.

אנחנו QUANTUM – משרד תיווך המתמחה בפינוי-בינוי ויש לנו קונים רציניים שמחפשים נכסים בדיוק באזור שלך.

האם תרצה לשמוע יותר? אנחנו מטפלים בהכל ובצורה מקצועית.`;
    }

    if (source === 'kones') {
        return `שלום, ראינו שיש נכס בכינוס נכסים ב${location}${city ? `, ${city}` : ''}.

אנחנו QUANTUM ומתמחים בפינוי-בינוי ויש לנו קונים מעוניינים. האם תרצה לשוחח?`;
    }

    // יד2 default
    return `שלום! ראינו את המודעה שלך ביד2 ב${location}${city ? `, ${city}` : ''}.

אנחנו QUANTUM – משרד תיווך המתמחה בעסקאות פינוי-בינוי. יש לנו קונים מאומתים שמחפשים נכסים בדיוק באזור זה.

האם תרצה לשמוע על האפשרויות? נשמח לסייע.`;
}

// שלח הודעת WhatsApp דרך INFORU CAPI
async function sendWhatsApp(phone, message) {
    try {
        const cleanPhone = normalizePhone(phone);
        if (!cleanPhone) return { success: false, error: 'Invalid phone number' };

        const payload = {
            Data: { Message: message, Recipients: [{ Phone: cleanPhone }] },
            Settings: { BusinessLine: INFORU_BUSINESS_LINE },
            Authentication: { Username: INFORU_USERNAME, ApiToken: INFORU_TOKEN }
        };

        const response = await axios.post(INFORU_API_URL, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
        });

        return { success: response.data?.Status === 'SUCCESS' || response.status === 200, data: response.data };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// שמור הודעה יוצאת ב-DB
async function saveOutgoingMessage(phone, message, listingId) {
    try {
        await pool.query(
            `INSERT INTO whatsapp_messages (phone, message, direction, message_type, created_at)
             VALUES ($1, $2, 'outgoing', 'text', NOW()) ON CONFLICT DO NOTHING`,
            [phone, message]
        ).catch(() => null);

        if (listingId) {
            await pool.query(
                `INSERT INTO listing_messages (listing_id, message_text, direction, status, created_at)
                 VALUES ($1, $2, 'outgoing', 'sent', NOW())`,
                [listingId, message]
            ).catch(() => null);
        }

        await pool.query(
            `INSERT INTO whatsapp_conversations (phone, status, updated_at)
             VALUES ($1, 'active', NOW())
             ON CONFLICT (phone) DO UPDATE SET updated_at = NOW()`,
            [phone]
        ).catch(() => null);
    } catch (err) {
        console.warn('[AutoFirstContact] saveOutgoingMessage error:', err.message);
    }
}

// עבד מודעות יד2 חדשות שלא פנינו אליהן
async function processYad2() {
    let contacted = 0, failed = 0, skipped = 0;
    try {
        const result = await pool.query(`
            SELECT id, phone, address, city, contact_name
            FROM listings
            WHERE contact_status IS NULL
              AND phone IS NOT NULL AND phone != ''
              AND is_active = TRUE
              AND created_at > NOW() - INTERVAL '2 hours'
            LIMIT 20
        `);

        for (const listing of result.rows) {
            try {
                // Skip landlines
                if (!isMobilePhone(listing.phone)) {
                    await pool.query(
                        `UPDATE listings SET contact_status = 'landline', updated_at = NOW() WHERE id = $1`,
                        [listing.id]
                    ).catch(() => null);
                    skipped++;
                    console.log(`[AutoFirstContact] SKIP landline: ${listing.phone}`);
                    continue;
                }

                const message = buildFirstMessage(listing, 'yad2');
                const res = await sendWhatsApp(listing.phone, message);

                if (res.success) {
                    await pool.query(
                        `UPDATE listings SET contact_status = 'contacted',
                         contact_attempts = COALESCE(contact_attempts, 0) + 1,
                         last_contact_at = NOW(), message_status = 'sent'
                         WHERE id = $1`,
                        [listing.id]
                    );
                    await saveOutgoingMessage(listing.phone, message, listing.id);
                    contacted++;
                    console.log(`[AutoFirstContact] OK Yad2: ${listing.phone} (${listing.address})`);
                } else {
                    await pool.query(
                        `UPDATE listings SET contact_attempts = COALESCE(contact_attempts, 0) + 1,
                         last_contact_at = NOW() WHERE id = $1`,
                        [listing.id]
                    );
                    failed++;
                    console.warn(`[AutoFirstContact] FAIL Yad2: ${listing.phone} — ${res.error}`);
                }

                await new Promise(r => setTimeout(r, 3000));
            } catch (e) {
                failed++;
                console.warn(`[AutoFirstContact] Error listing ${listing.id}:`, e.message);
            }
        }
    } catch (e) {
        console.error('[AutoFirstContact] processYad2 error:', e.message);
    }
    return { contacted, failed, skipped };
}

// עבד מודעות פייסבוק חדשות שלא פנינו אליהן
async function processFacebook() {
    let contacted = 0, failed = 0, skipped = 0;
    try {
        const tableCheck = await pool.query(
            `SELECT table_name FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'facebook_ads'`
        );
        if (!tableCheck.rows.length) return { contacted: 0, failed: 0, skipped: 0 };

        const result = await pool.query(`
            SELECT id, phone, address, city, contact_name
            FROM facebook_ads
            WHERE contact_status IS NULL
              AND phone IS NOT NULL AND phone != ''
              AND created_at > NOW() - INTERVAL '2 hours'
            LIMIT 20
        `).catch(() => ({ rows: [] }));

        for (const ad of result.rows) {
            try {
                if (!isMobilePhone(ad.phone)) {
                    await pool.query(
                        `UPDATE facebook_ads SET contact_status = 'landline', updated_at = NOW() WHERE id = $1`,
                        [ad.id]
                    ).catch(() => null);
                    skipped++;
                    continue;
                }

                const message = buildFirstMessage(ad, 'facebook');
                const res = await sendWhatsApp(ad.phone, message);
                if (res.success) {
                    await pool.query(
                        `UPDATE facebook_ads SET contact_status = 'contacted',
                         contact_attempts = COALESCE(contact_attempts, 0) + 1,
                         last_contact_at = NOW() WHERE id = $1`,
                        [ad.id]
                    );
                    await saveOutgoingMessage(ad.phone, message, null);
                    contacted++;
                } else {
                    failed++;
                }
                await new Promise(r => setTimeout(r, 3000));
            } catch (e) { failed++; }
        }
    } catch (e) {
        console.error('[AutoFirstContact] processFacebook error:', e.message);
    }
    return { contacted, failed, skipped };
}

// פנייה אוטומטית לכינוסי נכסים חדשים - רק מספרי נייד
async function runKonesAutoContact() {
    let contacted = 0, failed = 0, skipped_landline = 0, skipped_no_phone = 0;
    try {
        // Get all uncontacted active kones listings
        const result = await pool.query(`
            SELECT id, phone, address, city, contact_person
            FROM kones_listings
            WHERE contact_status IS NULL
              AND is_active = TRUE
            LIMIT 50
        `).catch(() => ({ rows: [] }));

        console.log(`[KonesContact] Found ${result.rows.length} uncontacted listings`);

        for (const k of result.rows) {
            try {
                // No phone at all
                if (!k.phone || k.phone.trim() === '') {
                    await pool.query(
                        `UPDATE kones_listings SET contact_status = 'no_phone', updated_at = NOW() WHERE id = $1`,
                        [k.id]
                    ).catch(() => null);
                    skipped_no_phone++;
                    continue;
                }

                // Landline - skip WhatsApp but note it for phone follow-up
                if (!isMobilePhone(k.phone)) {
                    await pool.query(
                        `UPDATE kones_listings SET contact_status = 'landline',
                         updated_at = NOW() WHERE id = $1`,
                        [k.id]
                    ).catch(() => null);
                    skipped_landline++;
                    console.log(`[KonesContact] LANDLINE (phone call needed): ${k.phone} — ${k.city} ${k.address}`);
                    continue;
                }

                // Mobile number - send WhatsApp
                const message = buildFirstMessage(k, 'kones');
                const res = await sendWhatsApp(k.phone, message);
                if (res.success) {
                    await pool.query(
                        `UPDATE kones_listings SET contact_status = 'contacted',
                         contact_attempts = COALESCE(contact_attempts, 0) + 1,
                         last_contact_at = NOW(), updated_at = NOW() WHERE id = $1`,
                        [k.id]
                    );
                    await saveOutgoingMessage(k.phone, message, null);
                    contacted++;
                    console.log(`[KonesContact] OK: ${k.phone} (${k.address}, ${k.city})`);
                } else {
                    await pool.query(
                        `UPDATE kones_listings SET contact_status = 'failed',
                         contact_attempts = COALESCE(contact_attempts, 0) + 1,
                         last_contact_at = NOW(), updated_at = NOW() WHERE id = $1`,
                        [k.id]
                    ).catch(() => null);
                    failed++;
                    console.warn(`[KonesContact] FAIL: ${k.phone} — ${res.error}`);
                }
                await new Promise(r => setTimeout(r, 3000));
            } catch (e) {
                failed++;
                console.warn(`[KonesContact] Error id=${k.id}:`, e.message);
            }
        }
    } catch (e) {
        console.error('[KonesContact] error:', e.message);
    }
    const summary = { contacted, failed, skipped_landline, skipped_no_phone };
    console.log(`[KonesContact] Done:`, summary);
    return summary;
}

// הפעל את כל הפניות הראשונות (יד2 + פייסבוק)
async function runAutoFirstContact() {
    console.log('[AutoFirstContact] Starting run...');
    const yad2 = await processYad2();
    const fb = await processFacebook();
    const total = {
        contacted: yad2.contacted + fb.contacted,
        failed: yad2.failed + fb.failed,
        skipped: (yad2.skipped || 0) + (fb.skipped || 0)
    };
    console.log(`[AutoFirstContact] Done — contacted: ${total.contacted}, failed: ${total.failed}, skipped(landlines): ${total.skipped}`);
    return total;
}

// סטטיסטיקות לדשבורד
async function getContactStats() {
    try {
        const [pending, contacted, total] = await Promise.all([
            pool.query(`SELECT COUNT(*) FROM listings WHERE contact_status IS NULL AND phone IS NOT NULL AND phone != '' AND is_active = TRUE`),
            pool.query(`SELECT COUNT(*) FROM listings WHERE contact_status = 'contacted'`),
            pool.query(`SELECT COUNT(*) FROM listings WHERE phone IS NOT NULL AND phone != '' AND is_active = TRUE`)
        ]);
        return {
            pending: parseInt(pending.rows[0].count) || 0,
            contacted: parseInt(contacted.rows[0].count) || 0,
            total: parseInt(total.rows[0].count) || 0
        };
    } catch (e) {
        return { pending: 0, contacted: 0, total: 0 };
    }
}

// סטטיסטיקות כינוסים
async function getKonesContactStats() {
    try {
        const result = await pool.query(`
            SELECT
                contact_status,
                COUNT(*) as count
            FROM kones_listings
            WHERE is_active = TRUE
            GROUP BY contact_status
            ORDER BY count DESC
        `).catch(() => ({ rows: [] }));

        const stats = {
            total: 0,
            contacted: 0,
            landline: 0,
            no_phone: 0,
            failed: 0,
            pending: 0
        };

        for (const row of result.rows) {
            const status = row.contact_status || 'pending';
            const count = parseInt(row.count);
            stats[status] = count;
            stats.total += count;
        }

        return stats;
    } catch (e) {
        return { total: 0, contacted: 0, landline: 0, no_phone: 0, failed: 0, pending: 0 };
    }
}

// אתחול — נקרא מ-index.js בהפעלה
async function initialize() {
    console.log('[AutoFirstContact] Service initialized');
    return true;
}

module.exports = { initialize, runAutoFirstContact, runKonesAutoContact, getContactStats, getKonesContactStats, isMobilePhone };
