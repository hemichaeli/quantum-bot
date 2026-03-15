const axios = require('axios');
const { logger } = require('./logger');

/**
 * QUANTUM WhatsApp Templates - Custom templates for Meta approval
 * These templates are designed specifically for QUANTUM's real estate use cases
 */

// QUANTUM-specific WhatsApp templates (to be submitted to Meta for approval)
const QUANTUM_PENDING_TEMPLATES = {
  quantum_seller_initial: {
    name: 'QUANTUM - פנייה ראשונית למוכר',
    category: 'MARKETING',
    language: 'he',
    body: 'שלום {{1}}, ראיתי שיש לך נכס למכירה ב{{2}}, {{3}}. אני מ-QUANTUM, משרד תיווך המתמחה בפינוי-בינוי. יש לנו קונים רציניים לאזור שלך. אשמח לשוחח.',
    footer: 'QUANTUM Real Estate',
    buttons: [
      { type: 'PHONE_NUMBER', text: 'התקשר', phone_number: '+972522377712' },
      { type: 'URL', text: 'מידע נוסף', url: 'https://quantum-dashboard-production.up.railway.app' }
    ],
    params: ['name', 'address', 'city'],
    sample_params: ['יוסי', 'הרצל 10', 'תל אביב']
  },
  quantum_buyer_opportunity: {
    name: 'QUANTUM - הזדמנות השקעה',
    category: 'MARKETING', 
    language: 'he',
    body: 'שלום {{1}}, יש לנו הזדמנות השקעה חדשה: {{2}}, {{3}}. מכפיל: x{{4}} | סטטוס: {{5}}. מתאים לפרופיל שלך.',
    footer: 'QUANTUM - המומחים בפינוי-בינוי',
    buttons: [
      { type: 'PHONE_NUMBER', text: 'התקשר עכשיו', phone_number: '+972522377712' },
      { type: 'QUICK_REPLY', text: 'מעוניין' },
      { type: 'QUICK_REPLY', text: 'לא מתאים' }
    ],
    params: ['name', 'complex_name', 'city', 'multiplier', 'status'],
    sample_params: ['משה', 'פרויקט הדר', 'חולון', '1.8', 'אושר ועדה']
  },
  quantum_kones_inquiry: {
    name: 'QUANTUM - פנייה לכונס נכסים',
    category: 'UTILITY',
    language: 'he', 
    body: 'לכבוד עו״ד {{1}}, בנוגע לנכס בכינוס ב{{2}}, {{3}}. אנו מ-QUANTUM, משרד תיווך המתמחה בפינוי-בינוי. יש לנו קונים פוטנציאליים מיידיים לנכס.',
    footer: 'QUANTUM Real Estate - רישיון 12345',
    buttons: [
      { type: 'PHONE_NUMBER', text: 'התקשר', phone_number: '+972522377712' }
    ],
    params: ['lawyer_name', 'address', 'city'],
    sample_params: ['כהן', 'בן גוריון 15', 'ראשון לציון']
  },
  quantum_price_alert: {
    name: 'QUANTUM - התראת מחיר',
    category: 'UTILITY',
    language: 'he',
    body: 'התראה! {{1}}, {{2}} - ירידת מחיר של {{3}}%. המחיר החדש: {{4}} ₪. הזדמנות מצוינת להשקעה!',
    footer: 'QUANTUM Intelligence',
    buttons: [
      { type: 'PHONE_NUMBER', text: 'התקשר מיד', phone_number: '+972522377712' },
      { type: 'QUICK_REPLY', text: 'מעוניין' }
    ],
    params: ['complex_name', 'city', 'price_drop', 'new_price'],
    sample_params: ['מתחם הדר', 'חולון', '15', '2,850,000']
  },
  quantum_committee_approval: {
    name: 'QUANTUM - אישור ועדה',
    category: 'UTILITY',
    language: 'he',
    body: 'חדשות מצוינות! {{1}}, {{2}} קיבל אישור ועדה סופי! זה הזמן להשקיע לפני שהמחירים יעלו. נשמח לעדכן אותך.',
    footer: 'QUANTUM - ראשונים עם החדשות',
    buttons: [
      { type: 'PHONE_NUMBER', text: 'התקשר עכשיו', phone_number: '+972522377712' },
      { type: 'URL', text: 'פרטים מלאים', url: 'https://quantum-dashboard-production.up.railway.app' }
    ],
    params: ['complex_name', 'city'],
    sample_params: ['פרויקט נווה זדק', 'תל אביב']
  },
  quantum_followup: {
    name: 'QUANTUM - מעקב אישי',
    category: 'MARKETING',
    language: 'he',
    body: 'שלום {{1}}, ממשיכים לעקוב אחרי {{2}} עבורך. יש התפתחות חדשה שחשוב שתדע: {{3}}. נשמח לעדכן אותך.',
    footer: 'QUANTUM - מעקב אישי',
    buttons: [
      { type: 'PHONE_NUMBER', text: 'התקשר', phone_number: '+972522377712' },
      { type: 'QUICK_REPLY', text: 'תודה' }
    ],
    params: ['name', 'complex_name', 'update'],
    sample_params: ['דני', 'פרויקט הדר', 'הוגשה בקשה לתוספת יחידות']
  }
};

// Enhanced automated campaign triggers based on QUANTUM algorithms
const QUANTUM_CAMPAIGN_TRIGGERS = {
  high_ssi_seller: {
    template: 'quantum_seller_initial',
    condition: 'ssi_score > 80',
    description: 'מוכר במצוקה - SSI גבוה',
    priority: 'high',
    delay_hours: 0 // Send immediately
  },
  new_committee_approval: {
    template: 'quantum_committee_approval', 
    condition: 'committee_status = "approved" AND days_since_approval <= 1',
    description: 'אישור ועדה חדש',
    priority: 'urgent',
    delay_hours: 0
  },
  price_drop_opportunity: {
    template: 'quantum_price_alert',
    condition: 'price_change_percent < -10',
    description: 'ירידת מחיר משמעותית',
    priority: 'high', 
    delay_hours: 2 // Small delay to verify
  },
  high_iai_investment: {
    template: 'quantum_buyer_opportunity',
    condition: 'iai_score > 85',
    description: 'הזדמנות השקעה מעולה',
    priority: 'high',
    delay_hours: 4 // Allow for additional analysis
  },
  new_kones_listing: {
    template: 'quantum_kones_inquiry',
    condition: 'is_receivership = true AND days_since_discovery <= 3',
    description: 'נכס חדש בכינוס',
    priority: 'medium',
    delay_hours: 24 // Professional delay for legal contacts
  }
};

/**
 * Create WhatsApp template through INFORU API
 * @param {string} templateKey - Key from QUANTUM_PENDING_TEMPLATES
 * @param {object} options - Additional options
 */
async function createWhatsAppTemplate(templateKey, options = {}) {
  const tmpl = QUANTUM_PENDING_TEMPLATES[templateKey];
  if (!tmpl) throw new Error(`Template ${templateKey} not found`);

  const getBasicAuth = () => {
    const username = process.env.INFORU_USERNAME;
    const password = process.env.INFORU_PASSWORD;
    if (!username || !password) throw new Error('INFORU credentials not configured');
    return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  };

  const templateData = {
    Data: {
      TemplateName: tmpl.name,
      TemplateCategory: tmpl.category,
      TemplateLanguage: tmpl.language,
      TemplateBody: tmpl.body,
      ...(tmpl.footer ? { TemplateFooter: tmpl.footer } : {}),
      ...(tmpl.buttons && tmpl.buttons.length > 0 ? { 
        TemplateButtons: tmpl.buttons.map(btn => ({
          ButtonType: btn.type,
          ButtonText: btn.text,
          ...(btn.phone_number ? { PhoneNumber: btn.phone_number } : {}),
          ...(btn.url ? { Url: btn.url } : {})
        }))
      } : {})
    }
  };

  try {
    const response = await axios.post(
      'https://capi.inforu.co.il/api/v2/WhatsApp/CreateTemplate',
      templateData,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': getBasicAuth()
        },
        timeout: 30000
      }
    );

    const result = {
      success: response.data.StatusId === 1,
      status: response.data.StatusId,
      description: response.data.StatusDescription,
      templateId: response.data.Data?.TemplateId || null,
      templateKey,
      templateName: tmpl.name,
      timestamp: new Date().toISOString()
    };

    logger.info(`WhatsApp template creation result:`, { 
      templateKey, 
      success: result.success, 
      templateId: result.templateId,
      description: result.description
    });

    return result;
  } catch (err) {
    logger.error('WhatsApp template creation failed', { 
      error: err.message, 
      templateKey 
    });
    throw err;
  }
}

/**
 * Create all QUANTUM templates
 */
async function createAllQuantumTemplates() {
  const results = [];
  const delay = 5000; // 5 second delay between requests

  for (const [templateKey, template] of Object.entries(QUANTUM_PENDING_TEMPLATES)) {
    try {
      logger.info(`Creating template: ${templateKey} - ${template.name}`);
      const result = await createWhatsAppTemplate(templateKey);
      results.push({ templateKey, ...result });
      
      // Delay before next template (to avoid rate limiting)
      if (Object.keys(QUANTUM_PENDING_TEMPLATES).indexOf(templateKey) < Object.keys(QUANTUM_PENDING_TEMPLATES).length - 1) {
        logger.info(`Waiting ${delay/1000}s before next template...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    } catch (err) {
      results.push({ 
        templateKey, 
        success: false, 
        error: err.message,
        templateName: template.name 
      });
    }
  }

  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  logger.info(`Template creation summary: ${successful} successful, ${failed} failed`);
  return {
    total: results.length,
    successful,
    failed,
    results
  };
}

/**
 * Check which templates are approved and ready to use
 */
async function getQuantumTemplateStatus() {
  try {
    const inforuService = require('./inforuService');
    const templatesResponse = await inforuService.getWhatsAppTemplates();
    
    if (!templatesResponse.Data?.List) return { error: 'No templates returned' };
    
    const quantumTemplates = templatesResponse.Data.List.filter(t => 
      t.TemplateName && t.TemplateName.includes('QUANTUM')
    );

    const templateStatus = {};
    for (const [key, template] of Object.entries(QUANTUM_PENDING_TEMPLATES)) {
      const inforuTemplate = quantumTemplates.find(t => 
        t.TemplateName === template.name
      );
      
      templateStatus[key] = {
        name: template.name,
        created: !!inforuTemplate,
        templateId: inforuTemplate?.TemplateId || null,
        status: inforuTemplate?.ApprovalStatusDescription || 'Not Created',
        approved: inforuTemplate?.ApprovalStatusDescription === 'APPROVED'
      };
    }

    return {
      quantumTemplates: templateStatus,
      totalQuantumTemplates: quantumTemplates.length,
      approved: Object.values(templateStatus).filter(t => t.approved).length,
      pending: Object.values(templateStatus).filter(t => t.created && !t.approved).length,
      notCreated: Object.values(templateStatus).filter(t => !t.created).length
    };
  } catch (err) {
    logger.error('Failed to get QUANTUM template status', { error: err.message });
    throw err;
  }
}

/**
 * Generate campaign preview for specific triggers
 */
function generateCampaignPreview(campaignType, sampleData = {}) {
  const trigger = QUANTUM_CAMPAIGN_TRIGGERS[campaignType];
  if (!trigger) throw new Error(`Campaign type ${campaignType} not found`);

  const template = QUANTUM_PENDING_TEMPLATES[trigger.template];
  if (!template) throw new Error(`Template ${trigger.template} not found`);

  // Fill template with sample data
  let preview = template.body;
  template.params.forEach((param, idx) => {
    const value = sampleData[param] || template.sample_params[idx] || `{${param}}`;
    preview = preview.replace(`{{${idx + 1}}}`, value);
  });

  return {
    campaignType,
    templateKey: trigger.template,
    templateName: template.name,
    condition: trigger.condition,
    priority: trigger.priority,
    delayHours: trigger.delay_hours,
    preview,
    footer: template.footer,
    buttons: template.buttons?.map(b => ({ type: b.type, text: b.text })) || []
  };
}

/**
 * Test campaign with sample data
 */
function testAllCampaigns() {
  const previews = {};
  
  // Sample data for different scenarios
  const sampleScenarios = {
    high_ssi_seller: {
      name: 'דוד כהן',
      address: 'הרצל 25',
      city: 'חולון'
    },
    new_committee_approval: {
      complex_name: 'פרויקט נווה זדק',
      city: 'תל אביב'
    },
    price_drop_opportunity: {
      complex_name: 'מתחם הדר',
      city: 'חולון', 
      price_drop: '18',
      new_price: '2,650,000'
    },
    high_iai_investment: {
      name: 'משה לוי',
      complex_name: 'פרויקט הדר',
      city: 'חולון',
      multiplier: '1.9',
      status: 'אושר ועדה'
    },
    new_kones_listing: {
      lawyer_name: 'עדי כהן',
      address: 'בן גוריון 15', 
      city: 'ראשון לציון'
    }
  };

  for (const [campaignType, sampleData] of Object.entries(sampleScenarios)) {
    try {
      previews[campaignType] = generateCampaignPreview(campaignType, sampleData);
    } catch (err) {
      previews[campaignType] = { error: err.message };
    }
  }

  return previews;
}

module.exports = {
  QUANTUM_PENDING_TEMPLATES,
  QUANTUM_CAMPAIGN_TRIGGERS,
  createWhatsAppTemplate,
  createAllQuantumTemplates,
  getQuantumTemplateStatus,
  generateCampaignPreview,
  testAllCampaigns
};
