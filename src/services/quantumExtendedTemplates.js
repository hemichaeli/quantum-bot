const axios = require('axios');
const { logger } = require('./logger');

/**
 * QUANTUM WhatsApp Templates - Extended Collection
 * Additional templates for comprehensive real estate communication
 */

// ADDITIONAL QUANTUM TEMPLATES (Phase 2)
const QUANTUM_EXTENDED_TEMPLATES = {
  // ===== FOLLOW-UP SEQUENCES =====
  quantum_seller_followup_2: {
    name: 'QUANTUM - מעקב למוכר שני',
    category: 'MARKETING',
    language: 'he',
    body: 'שלום {{1}}, רק רציתי לוודא שקיבלת את ההודעה שלי לגבי הנכס ב{{2}}. יש לנו עדכון חשוב - קונה רציני מחפש בדיוק באזור שלך עם תקציב של {{3}} מיליון.',
    footer: 'QUANTUM - תמיד כאן בשבילך',
    buttons: [
      { type: 'PHONE_NUMBER', text: 'בוא נדבר', phone_number: '+972522377712' },
      { type: 'QUICK_REPLY', text: 'מעוניין לשמוע' },
      { type: 'QUICK_REPLY', text: 'לא מתאים' }
    ],
    params: ['name', 'address', 'budget'],
    sample_params: ['דני', 'רוטשילד 25', '4.5']
  },

  quantum_buyer_urgency: {
    name: 'QUANTUM - דחיפות לקונה',
    category: 'MARKETING',
    language: 'he',
    body: '🔥 {{1}}, יש לי משהו דחוף! זה עתה נפתח נכס ב{{2}} - בדיוק מה שחיפשת. המוכר מוכן לסגור מהר במחיר מעולה. זמין לשיחה עכשיו?',
    footer: 'QUANTUM - הזדמנויות חמות',
    buttons: [
      { type: 'PHONE_NUMBER', text: 'התקשר עכשיו!', phone_number: '+972522377712' },
      { type: 'QUICK_REPLY', text: 'כן! מעוניין' },
      { type: 'QUICK_REPLY', text: 'תשלח פרטים' }
    ],
    params: ['name', 'location'],
    sample_params: ['רונית', 'גבעתיים המבוקשת']
  },

  // ===== INFORMATION DELIVERY =====
  quantum_market_update: {
    name: 'QUANTUM - עדכון שוק',
    category: 'UTILITY',
    language: 'he',
    body: 'עדכון שוק חשוב עבור {{1}}: בעיר {{2}} נרשמה עליה של {{3}}% במחירי הפינוי-בינוי ברבעון האחרון. זה הזמן הנכון {{4}}!',
    footer: 'QUANTUM Market Intelligence',
    buttons: [
      { type: 'URL', text: 'דוח מלא', url: 'https://quantum-dashboard-production.up.railway.app' },
      { type: 'PHONE_NUMBER', text: 'יעוץ אישי', phone_number: '+972522377712' }
    ],
    params: ['name', 'city', 'price_change', 'action'],
    sample_params: ['איתי', 'חולון', '8.5', 'להשקיע']
  },

  quantum_document_ready: {
    name: 'QUANTUM - מסמכים מוכנים',
    category: 'UTILITY',
    language: 'he',
    body: 'שלום {{1}}, המסמכים של {{2}} מוכנים! הכנתי לך חבילת מידע מלאה עם כל הפרטים הטכניים, הכספיים והחוקיים. תוכל לקבל בוואטסאפ או במייל.',
    footer: 'QUANTUM - מקצועיות ברמה אחרת',
    buttons: [
      { type: 'QUICK_REPLY', text: 'שלח בוואטסאפ' },
      { type: 'QUICK_REPLY', text: 'שלח במייל' },
      { type: 'PHONE_NUMBER', text: 'בוא נעבור יחד', phone_number: '+972522377712' }
    ],
    params: ['name', 'project_name'],
    sample_params: ['מיכל', 'פרויקט הדר חולון']
  },

  // ===== APPOINTMENT SCHEDULING =====
  quantum_meeting_invite: {
    name: 'QUANTUM - הזמנה לפגישה',
    category: 'UTILITY',
    language: 'he',
    body: 'היי {{1}}, בעקבות השיחה שלנו - אשמח לקבוע פגישה איתך {{2}} כדי להציג לך את {{3}}. יש לי חלון פנוי {{4}} או {{5}}. מה מתאים לך?',
    footer: 'QUANTUM - Time is Money',
    buttons: [
      { type: 'QUICK_REPLY', text: 'מתאים לי ביום ראשון' },
      { type: 'QUICK_REPLY', text: 'מעדיף ביום שני' },
      { type: 'PHONE_NUMBER', text: 'בוא נתאמן בטלפון', phone_number: '+972522377712' }
    ],
    params: ['name', 'meeting_type', 'subject', 'option1', 'option2'],
    sample_params: ['עמית', 'בבית הקפה', 'הזדמנויות החדשות בבת ים', 'יום ראשון 16:00', 'יום שני 10:00']
  },

  // ===== SPECIAL OCCASIONS =====
  quantum_holiday_greeting: {
    name: 'QUANTUM - ברכת חג',
    category: 'MARKETING',
    language: 'he',
    body: 'שנה טובה {{1}}! 🎉 אני מאחל לך ולמשפחה שנה מלאת הצלחות והשקעות חכמות. גם השנה אני כאן בשבילך לכל שאלה או הזדמנות חדשה.',
    footer: 'QUANTUM - שותפים להצלחה',
    buttons: [
      { type: 'QUICK_REPLY', text: 'תודה רבה!' },
      { type: 'URL', text: 'סקירת שנה', url: 'https://quantum-dashboard-production.up.railway.app' }
    ],
    params: ['name'],
    sample_params: ['יעקב']
  },

  quantum_birthday_special: {
    name: 'QUANTUM - יום הולדת מיוחד',
    category: 'MARKETING',
    language: 'he',
    body: 'יום הולדת שמח {{1}}! 🎂 לכבוד יום ההולדת שלך, הכנתי לך דוח השקעות אישי עם ההזדמנויות הטובות ביותר לשנה הקרובה. מתנה ממני!',
    footer: 'QUANTUM - חוגגים יחד',
    buttons: [
      { type: 'QUICK_REPLY', text: 'מעוניין בדוח' },
      { type: 'PHONE_NUMBER', text: 'תודה! בוא נדבר', phone_number: '+972522377712' }
    ],
    params: ['name'],
    sample_params: ['שרון']
  },

  // ===== CRISIS MANAGEMENT =====
  quantum_crisis_support: {
    name: 'QUANTUM - תמיכה במשבר',
    category: 'UTILITY',
    language: 'he',
    body: 'שלום {{1}}, שמעתי על המצב הקשה. אני יודע שזה לא הזמן הקל ביותר, אבל חשוב לי שתדע שאני כאן לעזור. יש לי פתרונות מהירים ודיסקרטיים שיכולים לעזור.',
    footer: 'QUANTUM - תמיד לצדכם',
    buttons: [
      { type: 'PHONE_NUMBER', text: 'שיחה דחופה', phone_number: '+972522377712' },
      { type: 'QUICK_REPLY', text: 'תודה, אחזור אליך' }
    ],
    params: ['name'],
    sample_params: ['גדי']
  },

  // ===== POST-SALE FOLLOW-UP =====
  quantum_deal_completed: {
    name: 'QUANTUM - עסקה הושלמה',
    category: 'UTILITY',
    language: 'he',
    body: 'מזל טוב {{1}}! 🎉 העסקה ב{{2}} הושלמה בהצלחה! תודה שבחרת ב-QUANTUM. אני כאן לכל שאלה או עזרה עתידית. הצלחה עם ההשקעה החדשה!',
    footer: 'QUANTUM - מלווים עד הסוף',
    buttons: [
      { type: 'QUICK_REPLY', text: 'תודה רבה!' },
      { type: 'URL', text: 'המלצה על QUANTUM', url: 'https://quantum-dashboard-production.up.railway.app' }
    ],
    params: ['name', 'address'],
    sample_params: ['אורי', 'הרצל 15, חולון']
  }
};

// ===== EXTENDED CAMPAIGN TRIGGERS =====
const QUANTUM_EXTENDED_CAMPAIGNS = {
  follow_up_sequence: {
    template: 'quantum_seller_followup_2',
    condition: 'last_message_sent_at > 48_hours AND no_response = true',
    description: 'מעקב שני למוכרים שלא השיבו',
    priority: 'medium',
    delay_hours: 48
  },
  urgent_opportunity: {
    template: 'quantum_buyer_urgency',
    condition: 'new_listing = true AND matches_buyer_criteria = true',
    description: 'הודעת דחיפות לקונים מתאימים',
    priority: 'urgent',
    delay_hours: 0.5
  },
  monthly_market_update: {
    template: 'quantum_market_update',
    condition: 'monthly_report_ready = true',
    description: 'עדכון שוק חודשי ללקוחות פעילים',
    priority: 'low',
    delay_hours: 24
  },
  document_delivery: {
    template: 'quantum_document_ready',
    condition: 'documents_prepared = true',
    description: 'הודעה כשמסמכים מוכנים',
    priority: 'medium',
    delay_hours: 2
  },
  meeting_scheduling: {
    template: 'quantum_meeting_invite',
    condition: 'phone_call_completed = true AND needs_meeting = true',
    description: 'הזמנה לפגישה אחרי שיחה',
    priority: 'high',
    delay_hours: 1
  },
  holiday_outreach: {
    template: 'quantum_holiday_greeting',
    condition: 'is_holiday = true',
    description: 'ברכות לחגים',
    priority: 'low',
    delay_hours: 0
  },
  birthday_campaign: {
    template: 'quantum_birthday_special',
    condition: 'is_birthday = true',
    description: 'ברכות יום הולדת עם הצעה מיוחדת',
    priority: 'medium',
    delay_hours: 0
  },
  crisis_outreach: {
    template: 'quantum_crisis_support',
    condition: 'client_in_crisis = true',
    description: 'תמיכה בזמני משבר',
    priority: 'urgent',
    delay_hours: 0
  },
  post_sale_thanks: {
    template: 'quantum_deal_completed',
    condition: 'deal_completed = true',
    description: 'הודיה והמשך קשר אחרי עסקה',
    priority: 'high',
    delay_hours: 1
  }
};

module.exports = {
  QUANTUM_EXTENDED_TEMPLATES,
  QUANTUM_EXTENDED_CAMPAIGNS
};
