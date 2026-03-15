const express = require('express');
const router = express.Router();
const { logger } = require('../services/logger');

let inforuService;
let quantumTemplates;
try {
  inforuService = require('../services/inforuService');
  quantumTemplates = require('../services/quantumWhatsAppTemplates');
} catch (err) {
  logger.warn('INFORU or QUANTUM templates service not available', { error: err.message });
}

// ==================== QUANTUM TEMPLATES MANAGEMENT ====================

// Get status of all QUANTUM templates
router.get('/quantum/templates/status', async (req, res) => {
  try {
    if (!quantumTemplates) {
      return res.status(503).json({ error: 'QUANTUM templates service not available' });
    }

    const status = await quantumTemplates.getQuantumTemplateStatus();
    res.json({
      ...status,
      timestamp: new Date().toISOString(),
      note: 'QUANTUM-specific templates for real estate communication'
    });
  } catch (err) {
    logger.error('Failed to get QUANTUM template status', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Create all QUANTUM templates
router.post('/quantum/templates/create-all', async (req, res) => {
  try {
    if (!quantumTemplates) {
      return res.status(503).json({ error: 'QUANTUM templates service not available' });
    }

    logger.info('Starting creation of all QUANTUM WhatsApp templates');
    res.json({ 
      message: 'Creating all QUANTUM templates...', 
      note: 'This will take several minutes due to rate limiting',
      templates: Object.keys(quantumTemplates.QUANTUM_PENDING_TEMPLATES)
    });

    // Run in background
    quantumTemplates.createAllQuantumTemplates()
      .then(result => {
        logger.info('QUANTUM templates creation completed', result);
      })
      .catch(err => {
        logger.error('QUANTUM templates creation failed', { error: err.message });
      });

  } catch (err) {
    logger.error('Failed to create QUANTUM templates', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Create specific QUANTUM template
router.post('/quantum/templates/create/:templateKey', async (req, res) => {
  try {
    if (!quantumTemplates) {
      return res.status(503).json({ error: 'QUANTUM templates service not available' });
    }

    const { templateKey } = req.params;
    if (!quantumTemplates.QUANTUM_PENDING_TEMPLATES[templateKey]) {
      return res.status(404).json({ error: `Template ${templateKey} not found` });
    }

    const result = await quantumTemplates.createWhatsAppTemplate(templateKey);
    res.json(result);
  } catch (err) {
    logger.error('Failed to create QUANTUM template', { error: err.message, templateKey: req.params.templateKey });
    res.status(500).json({ error: err.message });
  }
});

// ==================== CAMPAIGN MANAGEMENT ====================

// Get all campaign types and their triggers
router.get('/quantum/campaigns', (req, res) => {
  try {
    if (!quantumTemplates) {
      return res.status(503).json({ error: 'QUANTUM templates service not available' });
    }

    res.json({
      campaigns: quantumTemplates.QUANTUM_CAMPAIGN_TRIGGERS,
      templates: quantumTemplates.QUANTUM_PENDING_TEMPLATES,
      note: 'Automated campaigns based on QUANTUM algorithms (SSI/IAI)'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test campaign previews with sample data
router.get('/quantum/campaigns/test', (req, res) => {
  try {
    if (!quantumTemplates) {
      return res.status(503).json({ error: 'QUANTUM templates service not available' });
    }

    const previews = quantumTemplates.testAllCampaigns();
    res.json({
      previews,
      note: 'Campaign previews with sample data',
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate specific campaign preview
router.post('/quantum/campaigns/:campaignType/preview', (req, res) => {
  try {
    if (!quantumTemplates) {
      return res.status(503).json({ error: 'QUANTUM templates service not available' });
    }

    const { campaignType } = req.params;
    const sampleData = req.body;
    
    const preview = quantumTemplates.generateCampaignPreview(campaignType, sampleData);
    res.json(preview);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== ENHANCED WHATSAPP SENDING ====================

// Send WhatsApp with QUANTUM template (enhanced version)
router.post('/quantum/send', async (req, res) => {
  try {
    if (!inforuService || !quantumTemplates) {
      return res.status(503).json({ error: 'Services not available' });
    }

    const { phone, template, variables, options } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number required' });
    if (!template) return res.status(400).json({ error: 'Template key required' });

    // Check if it's a QUANTUM template that needs approval
    if (quantumTemplates.QUANTUM_PENDING_TEMPLATES[template]) {
      const templateStatus = await quantumTemplates.getQuantumTemplateStatus();
      const tmplStatus = templateStatus.quantumTemplates[template];
      
      if (!tmplStatus.approved) {
        return res.status(400).json({ 
          error: 'Template not approved yet',
          template,
          status: tmplStatus.status,
          note: 'Use existing templates until QUANTUM templates are approved by Meta'
        });
      }
    }

    // Send using enhanced QUANTUM logic
    const result = await inforuService.sendWhatsApp(phone, template, variables || {}, {
      listingId: req.body.listingId,
      complexId: req.body.complexId,
      campaignType: options?.campaignType,
      source: 'quantum_api',
      ...options
    });

    res.json({
      ...result,
      quantum: {
        templateType: quantumTemplates.QUANTUM_PENDING_TEMPLATES[template] ? 'quantum' : 'standard',
        campaignTriggered: !!options?.campaignType
      }
    });
  } catch (err) {
    logger.error('QUANTUM WhatsApp send failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ==================== AUTOMATED CAMPAIGN EXECUTION ====================

// Trigger automated campaigns based on conditions
router.post('/quantum/campaigns/trigger', async (req, res) => {
  try {
    if (!inforuService || !quantumTemplates) {
      return res.status(503).json({ error: 'Services not available' });
    }

    const { campaignType, targets, dryRun = false } = req.body;
    
    if (!quantumTemplates.QUANTUM_CAMPAIGN_TRIGGERS[campaignType]) {
      return res.status(404).json({ error: `Campaign type ${campaignType} not found` });
    }

    if (!targets || !Array.isArray(targets) || targets.length === 0) {
      return res.status(400).json({ error: 'Targets array required' });
    }

    const trigger = quantumTemplates.QUANTUM_CAMPAIGN_TRIGGERS[campaignType];
    const results = {
      campaignType,
      templateKey: trigger.template,
      priority: trigger.priority,
      dryRun,
      targets: targets.length,
      sent: 0,
      failed: 0,
      details: []
    };

    logger.info(`Starting ${dryRun ? 'DRY RUN' : 'LIVE'} campaign: ${campaignType}`, {
      targets: targets.length,
      template: trigger.template
    });

    for (const target of targets) {
      try {
        if (dryRun) {
          // Just preview, don't actually send
          const preview = quantumTemplates.generateCampaignPreview(campaignType, target.variables);
          results.details.push({
            phone: target.phone,
            success: true,
            preview: preview.preview,
            dryRun: true
          });
          results.sent++;
        } else {
          // Actually send
          const sendResult = await inforuService.sendWhatsApp(
            target.phone, 
            trigger.template, 
            target.variables || {},
            {
              campaignType,
              priority: trigger.priority,
              listingId: target.listingId,
              complexId: target.complexId
            }
          );
          
          results.details.push({
            phone: target.phone,
            ...sendResult
          });

          if (sendResult.success) results.sent++;
          else results.failed++;

          // Apply campaign delay
          if (trigger.delay_hours > 0) {
            const delayMs = Math.min(trigger.delay_hours * 3600000, 300000); // Max 5 minutes for API
            await new Promise(resolve => setTimeout(resolve, delayMs / 100)); // Scaled down for testing
          }
        }
      } catch (err) {
        results.details.push({
          phone: target.phone,
          success: false,
          error: err.message
        });
        results.failed++;
      }
    }

    logger.info(`Campaign ${campaignType} completed`, results);
    res.json(results);
  } catch (err) {
    logger.error('Campaign execution failed', { error: err.message, campaignType: req.body.campaignType });
    res.status(500).json({ error: err.message });
  }
});

// ==================== ANALYTICS & INSIGHTS ====================

// Get WhatsApp campaign analytics
router.get('/quantum/analytics', async (req, res) => {
  try {
    if (!inforuService) {
      return res.status(503).json({ error: 'INFORU service not available' });
    }

    const stats = await inforuService.getStats();
    const whatsappStats = stats.find(s => s.channel === 'whatsapp') || {
      total_sent: 0,
      successful: 0,
      failed: 0,
      unique_recipients: 0
    };

    // Get recent activity (last 7 days)
    const pool = require('../db/pool');
    const recentActivity = await pool.query(`
      SELECT 
        template_key,
        COUNT(*) as messages,
        COUNT(CASE WHEN status = 'sent' THEN 1 END) as successful,
        COUNT(DISTINCT phone) as unique_recipients
      FROM sent_messages 
      WHERE channel = 'whatsapp' 
        AND created_at >= NOW() - INTERVAL '7 days'
      GROUP BY template_key
      ORDER BY messages DESC
    `);

    res.json({
      summary: {
        totalSent: parseInt(whatsappStats.total_sent),
        successful: parseInt(whatsappStats.successful), 
        failed: parseInt(whatsappStats.failed),
        successRate: whatsappStats.total_sent > 0 
          ? ((whatsappStats.successful / whatsappStats.total_sent) * 100).toFixed(1)
          : 0,
        uniqueRecipients: parseInt(whatsappStats.unique_recipients)
      },
      recentActivity: recentActivity.rows,
      quantum: {
        templatesCreated: quantumTemplates ? Object.keys(quantumTemplates.QUANTUM_PENDING_TEMPLATES).length : 0,
        campaignTypes: quantumTemplates ? Object.keys(quantumTemplates.QUANTUM_CAMPAIGN_TRIGGERS).length : 0
      },
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    logger.error('Failed to get WhatsApp analytics', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ==================== SMART TRIGGERS FROM QUANTUM DATA ====================

// Get potential campaign targets based on QUANTUM algorithms
router.get('/quantum/targets/:campaignType', async (req, res) => {
  try {
    const { campaignType } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    
    if (!quantumTemplates.QUANTUM_CAMPAIGN_TRIGGERS[campaignType]) {
      return res.status(404).json({ error: `Campaign type ${campaignType} not found` });
    }

    const pool = require('../db/pool');
    const trigger = quantumTemplates.QUANTUM_CAMPAIGN_TRIGGERS[campaignType];
    
    let targets = [];
    
    // Different queries based on campaign type
    switch (campaignType) {
      case 'high_ssi_seller':
        const ssiQuery = await pool.query(`
          SELECT DISTINCT l.phone, l.contact_name, l.address, l.city, c.ssi_score
          FROM listings l
          JOIN complexes c ON c.city = l.city
          WHERE l.phone IS NOT NULL 
            AND c.ssi_score > 80
            AND l.message_status != 'נשלח'
          ORDER BY c.ssi_score DESC
          LIMIT $1
        `, [limit]);
        
        targets = ssiQuery.rows.map(row => ({
          phone: row.phone,
          variables: {
            name: row.contact_name || 'חבר',
            address: row.address,
            city: row.city
          },
          metadata: { ssi_score: row.ssi_score }
        }));
        break;

      case 'high_iai_investment':
        const iaiQuery = await pool.query(`
          SELECT DISTINCT c.name, c.city, c.iai_score, c.status
          FROM complexes c
          WHERE c.iai_score > 85
            AND c.status NOT LIKE '%בוטל%'
          ORDER BY c.iai_score DESC  
          LIMIT $1
        `, [limit]);
        
        targets = iaiQuery.rows.map(row => ({
          phone: '0522377712', // Default for testing
          variables: {
            name: 'משקיע מתעניין',
            complex_name: row.name,
            city: row.city,
            multiplier: '1.8',
            status: row.status
          },
          metadata: { iai_score: row.iai_score }
        }));
        break;

      case 'new_committee_approval':
        const committeeQuery = await pool.query(`
          SELECT DISTINCT c.name, c.city, c.last_committee_date
          FROM complexes c
          WHERE c.last_committee_decision LIKE '%אושר%'
            AND c.last_committee_date >= NOW() - INTERVAL '7 days'
          ORDER BY c.last_committee_date DESC
          LIMIT $1
        `, [limit]);
        
        targets = committeeQuery.rows.map(row => ({
          phone: '0522377712',
          variables: {
            complex_name: row.name,
            city: row.city
          },
          metadata: { approval_date: row.last_committee_date }
        }));
        break;

      default:
        targets = [{
          phone: '0522377712',
          variables: { name: 'Test', city: 'Tel Aviv' },
          metadata: { note: 'Sample target for testing' }
        }];
    }

    res.json({
      campaignType,
      condition: trigger.condition,
      priority: trigger.priority,
      targetsFound: targets.length,
      targets,
      note: targets.length === 0 ? 'No targets match the campaign conditions' : undefined
    });
    
  } catch (err) {
    logger.error('Failed to get campaign targets', { error: err.message, campaignType: req.params.campaignType });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
