/**
 * QUANTUM Campaign Vapi Service
 * רן מ-QUANTUM — תסריט קולי חופף ל-WA Bot
 */

const axios = require('axios');

const VAPI_BASE = 'https://api.vapi.ai';

// ─── תסריטים לפי סוג ─────────────────────────────────────────────────────────

function buildSystemPrompt(scriptType, leadName, leadCity) {
  const name = leadName ? `, ${leadName}` : '';
  const cityHint = leadCity ? ` הלקוח מ${leadCity}.` : '';

  const base = `אתה רן, נציג QUANTUM — משרד תיווך בוטיק המתמחה בפינוי-בינוי בישראל.${cityHint}

## אישיות
- חכם, חם, ישיר — לא רובוטי
- מציג את עצמך פעם אחת בלבד בפתיחה
- שואל שאלה אחת בכל פעם — לא פוצח ברשימות
- עברית טבעית, לא פורמלית
- קצר — 1-2 משפטים בכל תור

## מטרת השיחה
לזהות מי הלקוח ולקבוע פגישה/שיחת המשך עם מומחה.

## מה לאסוף
- שם (אם לא ידוע)
- קונה או מוכר?
- מוכר: עיר, סוג נכס, כמה חדרים
- קונה: אזור, תקציב, מתי מתכנן
- זמינות לפגישה

## חוקי ברזל
❌ לעולם אל תציג את עצמך שוב אחרי הפתיחה
❌ אל תבטיח מחירים ספציפיים
❌ אל תשאל 2 שאלות ביחד
✓ אם לא ענו — אמור: "אולי זה לא הרגע הנוח? אני אשמח לחזור אליך מאוחר יותר"
✓ אם הלקוח לא מעוניין — "בסדר גמור, שמור את המספר לכשתצטרך"`;

  const scriptParts = {
    seller: `\n\n## תסריט — מוכר
פתיחה: "שלום${name}, אני רן מ-QUANTUM. פנינו אליך כי ראינו שיש לך נכס שיכול להיות רלוונטי לפינוי-בינוי. יש לך דקה?"
זרימה:
1. אישור שיש נכס למכירה
2. איפה הנכס (עיר + רחוב בערך)
3. כמה חדרים
4. למה שוקל למכור
5. מוכר אם יש היתה מחיר טוב — מה מחיר מינימום?
6. קביעת שיחה עם מומחה QUANTUM`,

    buyer: `\n\n## תסריט — קונה
פתיחה: "שלום${name}, אני רן מ-QUANTUM. ראיתי שהתעניינת — רציתי להבין מה אתה מחפש."
זרימה:
1. מה מחפש (דירה למגורים / השקעה)
2. אזור מועדף
3. תקציב בערך
4. לוח זמנים
5. יש לו מתווך כרגע?
6. קביעת פגישה`,

    pinuy_binuy: `\n\n## תסריט — פינוי-בינוי
פתיחה: "שלום${name}, אני רן מ-QUANTUM. אנחנו מתמחים בפינוי-בינוי ויש לנו מידע על מתחמים באזור שלך. יש לך רגע?"
זרימה:
1. האם בעל נכס במתחם?
2. מה הנכס ואיפה?
3. כבר פנו אליו יזמים?
4. מה חשוב לו בתהליך?
5. הסבר קצר על היתרון של QUANTUM
6. קביעת פגישה`,

    general: `\n\n## תסריט — כללי
פתיחה: "שלום${name}, אני רן מ-QUANTUM. פנינו אליך — יש לך רגע לשיחה קצרה?"
זרימה:
1. האם קונה או מוכר?
2. עיר ואזור
3. מה מחפש / מה יש למכור
4. לוח זמנים
5. קביעת שיחה עם מומחה`
  };

  return base + (scriptParts[scriptType] || scriptParts.general);
}

function buildFirstMessage(scriptType, leadName) {
  const name = leadName ? `, ${leadName}` : '';
  const messages = {
    seller:      `שלום${name}, אני רן מ-QUANTUM. פנינו אליך כי ראינו שיש לך נכס שיכול להיות רלוונטי לפינוי-בינוי. יש לך דקה?`,
    buyer:       `שלום${name}, אני רן מ-QUANTUM. ראיתי שהתעניינת — רציתי להבין מה אתה מחפש.`,
    pinuy_binuy: `שלום${name}, אני רן מ-QUANTUM. אנחנו מתמחים בפינוי-בינוי ויש לי מידע על מתחמים רלוונטיים. יש לך רגע?`,
    general:     `שלום${name}, אני רן מ-QUANTUM. פנינו אליך — יש לך רגע לשיחה קצרה?`
  };
  return messages[scriptType] || messages.general;
}

// ─── שיחת Vapi ──────────────────────────────────────────────────────────────

async function placeVapiCall({ phone, leadName, leadCity, scriptType = 'general', campaignLeadId, campaignId }) {
  const apiKey     = process.env.VAPI_API_KEY;
  const phoneNumId = process.env.VAPI_PHONE_NUMBER_ID;

  if (!apiKey)     throw new Error('VAPI_API_KEY not set');
  if (!phoneNumId) throw new Error('VAPI_PHONE_NUMBER_ID not set');

  // Normalize phone to E.164
  const digits = phone.replace(/\D/g, '');
  const e164   = digits.startsWith('972') ? `+${digits}` :
                 digits.startsWith('0')   ? `+972${digits.slice(1)}` :
                 `+${digits}`;

  const systemPrompt = buildSystemPrompt(scriptType, leadName, leadCity);
  const firstMessage = buildFirstMessage(scriptType, leadName);

  const body = {
    phoneNumberId: phoneNumId,
    customer: {
      number: e164,
      name:   leadName || 'לקוח'
    },
    assistant: {
      name:           'רן',
      firstMessage,
      model: {
        provider: 'anthropic',
        model:    'claude-3-haiku-20240307',
        messages: [{ role: 'system', content: systemPrompt }],
        maxTokens: 200,
        temperature: 0.7
      },
      voice: {
        provider: 'azure',
        voiceId:  'he-IL-AvriNeural'
      },
      transcriber: {
        provider: 'deepgram',
        model:    'nova-3',
        language: 'he',
        keyterms: ['QUANTUM', 'פינוי-בינוי', 'קוונטום', 'רן', 'דירה', 'נכס', 'מתחם']
      },
      endCallPhrases: ['להתראות', 'ביי', 'שלום שלום', 'אני אחשוב על זה', 'לא מעוניין'],
      maxDurationSeconds: 300
    },
    metadata: {
      campaign_lead_id: campaignLeadId?.toString(),
      campaign_id:      campaignId?.toString(),
      quantum_source:   'campaign_manager'
    }
  };

  const response = await axios.post(`${VAPI_BASE}/call/phone`, body, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    timeout: 15000
  });

  return {
    callId:  response.data.id,
    status:  response.data.status,
    e164
  };
}

// ─── WA הודעה ראשונה מתואמת לתסריט ────────────────────────────────────────

function buildWaFirstMessage(scriptType, leadName) {
  const name = leadName ? ` ${leadName}` : '';
  const messages = {
    seller: `שלום${name}! אני רן מ-QUANTUM 👋\nראיתי שיש לך נכס שעשוי להיות רלוונטי לפינוי-בינוי — יש לנו מידע שיכול לעניין אותך.\nיש לך רגע?`,
    buyer:  `שלום${name}! אני רן מ-QUANTUM 👋\nהתעניינת בנכס — רציתי להבין מה אתה מחפש ולראות אם יש לי משהו שמתאים.\nמה מחפש?`,
    pinuy_binuy: `שלום${name}! אני רן מ-QUANTUM 👋\nאנחנו מתמחים בפינוי-בינוי ויש לי מידע על מתחמים רלוונטיים באזור שלך.\nיש לך רגע?`,
    general: `שלום${name}! אני רן מ-QUANTUM 👋\nרציתי להכיר — קונה, מוכר, או רק בשלב של בדיקה?`
  };
  return messages[scriptType] || messages.general;
}

module.exports = { placeVapiCall, buildWaFirstMessage, buildSystemPrompt, buildFirstMessage };
