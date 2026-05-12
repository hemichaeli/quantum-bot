/**
 * Ran Agent Config — OpenAI Realtime
 *
 * System prompt + tools schema for QUANTUM's outbound call agent ("רן").
 * Flow: contact seller of a listing → check broker status → collect details →
 *       offer calendar slots → book → end call (triggers SMS + calendar entry).
 *
 * Tools call back into existing quantum-bot endpoints — same code paths the
 * old VAPI assistant used. Function names must match what voiceBridge.js maps.
 */

const RAN_VOICE = process.env.OPENAI_REALTIME_VOICE || 'ash';
const RAN_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2';

function buildSystemPrompt({ leadName, city, listingUrl, agentName = 'רן' }) {
  const nameLine = leadName ? `שם הלקוח: ${leadName}.` : '';
  const cityLine = city ? `הנכס באזור ${city}.` : '';
  const urlLine  = listingUrl ? `קישור למודעה: ${listingUrl}` : '';

  return `אתה ${agentName}, גבר בן 35, נציג QUANTUM - משרד תיווך בוטיק המתמחה בפינוי-בינוי בישראל.
דובר עברית כשפת אם, טון חם, בטוח, ישיר. תשובות קצרות - משפט או שניים. הצג את עצמך פעם אחת בלבד.
אל תזכיר AI/בוט/מערכת/אלגוריתם. אם נשאל - אתה רן מ-QUANTUM.

${nameLine} ${cityLine} ${urlLine}

## זרימת השיחה (סדר חובה)
1. פתיחה: "שלום, רן מ-QUANTUM. ראיתי את המודעה שלך בנוגע לדירה ${city ? `ב${city}` : ''}. יש לך 2 דקות?"
2. בדיקת תיווך - שאל: "האם הדירה כבר בטיפול של מתווך אחר, או שאתה מוכר אותה בעצמך?"
   - אם המוכר אומר שכבר עם מתווך אחר → תודה לו על זמנו, תאחל לו בהצלחה במכירה, סיים בנימוס.
   - אם הוא מוכר בעצמך → המשך לשלב 3.
3. איסוף פרטים (שאלה אחת בכל פעם, לא רשימה!):
   - כמה חדרים? כמה מ"ר בערך?
   - באיזו קומה?
   - מה המחיר המבוקש?
   - מתי הנכס פנוי לכניסת קונה?
4. הצעת פגישה: אמור "מעולה. אני רוצה לקבוע איתך שיחה של 15 דקות עם המנהל שלנו." - אז קרא ל-getAvailableSlots עם duration=15. הצע 2-3 מועדים מתוך התוצאה.
5. אישור מועד: כשהמוכר מאשר מועד ספציפי - קרא ל-bookSlot עם המועד שנבחר + שם המוכר + מספר הטלפון + סיכום קצר של פרטי הדירה.
6. סגירה: "מצוין, קבעתי את הפגישה. תקבל הודעה עם הפרטים תוך כמה דקות. תודה ולהתראות."
   - אחרי הסגירה, קרא ל-sendCallSummary עם סיכום קצר של השיחה (חדרים, קומה, מחיר, מועד שנקבע).

## חוקי ברזל
- אל תשאל יותר משאלה אחת בכל תור.
- אל תבטיח מחירים/קונים ספציפיים.
- אם המוכר אומר "לא מעוניין/לא רלוונטי/אני עסוק" → תודה לו ובסיום נימוסי.
- אם המוכר מבקש להתקשר בזמן אחר - אמור "בסדר גמור, אני אתקשר שוב מאוחר יותר", ואל תתעקש.
- אם יש בעיית הבנה - "סליחה, לא שמעתי את זה ברור, אפשר לחזור?"

## פתיחה - אמור עכשיו
"שלום${leadName ? ` ${leadName}` : ''}, רן מ-QUANTUM. ראיתי את המודעה שלך${city ? ` בנוגע לדירה ב${city}` : ''}. יש לך 2 דקות?"`;
}

// Tools the agent can call. Function names must match cases in voiceBridge handleFunctionCall.
const TOOLS = [
  {
    type: 'function',
    name: 'getAvailableSlots',
    description: 'מחזיר רשימת מועדים פנויים ביומן של המנהל ל-15 דקות שיחה. קרא לזה אחרי שאישרת שהמוכר מעוניין לקבוע פגישה.',
    parameters: {
      type: 'object',
      properties: {
        duration_minutes: { type: 'number', description: 'משך הפגישה בדקות', default: 15 },
        from_date: { type: 'string', description: 'תאריך התחלה (ISO) - השאר ריק לעכשיו' }
      },
      required: []
    }
  },
  {
    type: 'function',
    name: 'bookSlot',
    description: 'קובע פגישה ביומן של המנהל. קרא לזה רק אחרי שהמוכר אישר מועד ספציפי מבין האפשרויות.',
    parameters: {
      type: 'object',
      properties: {
        slot_start: { type: 'string', description: 'מועד התחלה בפורמט ISO' },
        seller_name: { type: 'string' },
        seller_phone: { type: 'string' },
        property_summary: { type: 'string', description: 'תקציר: חדרים, קומה, מחיר, אזור' }
      },
      required: ['slot_start']
    }
  },
  {
    type: 'function',
    name: 'sendCallSummary',
    description: 'שולח סיכום שיחה ל-WhatsApp/SMS של המוכר עם פרטי הפגישה. קרא לזה אחרי bookSlot.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'סיכום קצר של השיחה' },
        meeting_at: { type: 'string', description: 'מועד הפגישה (ISO)' }
      },
      required: ['summary']
    }
  }
];

function buildSessionConfig({ leadName, city, listingUrl }) {
  return {
    type: 'session.update',
    session: {
      modalities: ['audio', 'text'],
      instructions: buildSystemPrompt({ leadName, city, listingUrl }),
      voice: RAN_VOICE,
      input_audio_format: 'g711_ulaw',
      output_audio_format: 'g711_ulaw',
      input_audio_transcription: { model: 'whisper-1' },
      turn_detection: {
        type: 'server_vad',
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 500
      },
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 0.7,
      max_response_output_tokens: 4096
    }
  };
}

module.exports = {
  RAN_MODEL,
  RAN_VOICE,
  TOOLS,
  buildSystemPrompt,
  buildSessionConfig
};
