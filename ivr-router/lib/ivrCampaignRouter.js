/**
 * Dual IVR Routing & Campaign Dispatcher
 * Routes Press '1' (intent shown) into two distinct campaign paths:
 *   - Path A (Document Journey): Ori Voice Bot + Ananta WhatsApp → Document Collection → CRM Handoff
 *   - Path B (DIY Journey): Ananta WhatsApp with Lender UTM Links → Direct Application at Lender
 *
 * Tracks ~2% Press 1 conversion rate from connected calls
 * Manages fallback logic when lender rejects (e.g., Poonawalla → Hero FinCorp)
 *
 * Architecture:
 * - Listens to voice call disposition webhooks (DTMF input)
 * - Routes Press 1 to appropriate journey based on campaign type
 * - Coordinates multi-channel engagement (voice + WhatsApp)
 * - Logs all routing decisions and channel interactions
 * - Tracks conversion metrics
 *
 * Usage:
 *   const router = new IVRCampaignRouter();
 *   await router.handleVoiceDisposition({
 *     phone: '919876543210',
 *     callSid: 'call_xyz',
 *     dtmf: '1',
 *     campaignId: 'camp_123',
 *     campaignType: 'path_a' // 'path_a' or 'path_b'
 *   });
 */

import { createClient } from '@supabase/supabase-js';
import OBDApiClient from './obdApiClient.js';
import AnantaApiClient from './anantaApiClient.js';
import OriserveVoiceClient from './oriserveVoiceClient.js';
import logger from './logging.js';

class IVRCampaignRouter {
  constructor() {
    this.supabaseUrl = process.env.SUPABASE_URL;
    this.supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    this.supabase = createClient(this.supabaseUrl, this.supabaseServiceRoleKey);

    // Initialize API clients
    this.obdClient = new OBDApiClient(
      process.env.OBD_BASE_URL,
      process.env.OBD_USERNAME,
      process.env.OBD_PASSWORD
    );
    this.anantaClient = new AnantaApiClient();
    this.oriserveClient = new OriserveVoiceClient();

    // Campaign configuration
    this.campaignConfig = {
      expectedPress1Rate: 0.02, // ~2% of connected calls
      documentJourneyTimeout: 7 * 24 * 60 * 60 * 1000, // 7 days
      diyJourneyLenders: ['poonawalla', 'hero_fincorp'], // Supported DIY lenders
    };

    // Lender UTM mappings for Path B (DIY Journey)
    this.lenderUTMs = {
      poonawalla: {
        name: 'Poonawalla Fincorp',
        baseUrl: 'https://app.poonawalla.co/loan-app',
        utmSource: 'automation-hub',
        utmMedium: 'whatsapp-diy',
        utmCampaign: 'direct-apply',
      },
      hero_fincorp: {
        name: 'Hero FinCorp',
        baseUrl: 'https://app.herofinancorp.com/loan-app',
        utmSource: 'automation-hub',
        utmMedium: 'whatsapp-diy',
        utmCampaign: 'direct-apply',
      },
    };
  }

  /**
   * Handle incoming voice disposition (DTMF input from call)
   */
  async handleVoiceDisposition(data) {
    const {
      phone,
      name,
      callSid,
      dtmf,
      campaignId,
      campaignType,
      lenderId,
    } = data;

    const routingId = `route_${Date.now()}_${phone}`;

    try {
      // Log incoming disposition
      logger.log('info', 'IVR_DISPOSITION_RECEIVED', `DTMF ${dtmf} received`, {
        routingId,
        phone,
        dtmf,
        callSid,
        campaignId,
        campaignType,
        type: 'voice_event',
      });

      // If user pressed 1 (interested)
      if (dtmf === '1') {
        await this._routePress1(
          {
            phone,
            name,
            callSid,
            campaignId,
            campaignType,
            lenderId,
          },
          routingId
        );
      } else {
        // Log non-press1 responses
        logger.log('info', 'IVR_NON_INTERESTED', `User pressed ${dtmf} (not interested)`, {
          routingId,
          phone,
          dtmf,
          campaignId,
          type: 'voice_event',
        });
      }

      return {
        success: true,
        routingId,
        phone,
        dtmf,
      };
    } catch (error) {
      logger.log('error', 'IVR_DISPOSITION_ERROR', `Error handling disposition: ${error.message}`, {
        routingId,
        phone,
        error: error.message,
        type: 'routing_error',
      });

      throw error;
    }
  }

  /**
   * Route Press 1 to appropriate journey
   */
  async _routePress1(data, routingId) {
    const { phone, name, callSid, campaignId, campaignType, lenderId } = data;

    // Save routing decision to database
    await this._logRoutingDecision({
      routingId,
      phone,
      campaignId,
      campaignType,
      callSid,
      dtmf: '1',
      status: 'routed',
    });

    if (campaignType === 'path_a') {
      // Document Journey: Voice Bot + WhatsApp Bot → Document Collection
      await this._launchDocumentJourney(
        { phone, name, callSid, campaignId, lenderId },
        routingId
      );
    } else if (campaignType === 'path_b') {
      // DIY Journey: WhatsApp with Lender UTM Link
      await this._launchDIYJourney(
        { phone, name, callSid, campaignId, lenderId },
        routingId
      );
    } else {
      logger.log('warn', 'IVR_UNKNOWN_CAMPAIGN_TYPE', `Unknown campaign type: ${campaignType}`, {
        routingId,
        phone,
        campaignType,
        type: 'configuration_warning',
      });
    }
  }

  /**
   * PATH A: Document Journey
   * Triggers Ori Voice Bot + Ananta WhatsApp simultaneously
   * Goal: Collect documents, sync to Chatsense CRM for human agent
   */
  async _launchDocumentJourney(data, routingId) {
    const { phone, name, callSid, campaignId, lenderId } = data;

    try {
      logger.log('info', 'DOCUMENT_JOURNEY_START', 'Starting document collection journey', {
        routingId,
        phone,
        campaignId,
        lenderId,
        type: 'journey_start',
      });

      // Step 1: Launch Ori Voice Bot (simultaneous)
      const voiceBotPromise = this._launchOriserveVoiceBot(
        { phone, name, callSid, campaignId, lenderId },
        routingId
      );

      // Step 2: Launch Ananta WhatsApp Bot (simultaneous)
      const whatsappBotPromise = this._launchAnantaWhatsAppBot(
        { phone, name, campaignId, lenderId },
        routingId,
        'document_collection'
      );

      // Wait for both to complete
      const [voiceBotResult, whatsappBotResult] = await Promise.allSettled([
        voiceBotPromise,
        whatsappBotPromise,
      ]);

      // Log results
      if (voiceBotResult.status === 'fulfilled') {
        logger.log('info', 'VOICE_BOT_LAUNCHED', 'Ori voice bot launched successfully', {
          routingId,
          phone,
          botId: voiceBotResult.value.botId,
          type: 'voice_bot_launch',
        });
      } else {
        logger.log('error', 'VOICE_BOT_FAILED', `Voice bot launch failed: ${voiceBotResult.reason}`, {
          routingId,
          phone,
          error: voiceBotResult.reason?.message,
          type: 'voice_bot_error',
        });
      }

      if (whatsappBotResult.status === 'fulfilled') {
        logger.log('info', 'WHATSAPP_BOT_LAUNCHED', 'Ananta WhatsApp bot launched successfully', {
          routingId,
          phone,
          messageId: whatsappBotResult.value.messageId,
          type: 'whatsapp_launch',
        });
      } else {
        logger.log('error', 'WHATSAPP_BOT_FAILED', `WhatsApp bot launch failed: ${whatsappBotResult.reason}`, {
          routingId,
          phone,
          error: whatsappBotResult.reason?.message,
          type: 'whatsapp_error',
        });
      }

      // Step 3: Update customer profile with journey tracking
      await this._updateCustomerJourneyStatus(
        { phone, journeyType: 'document_collection', campaignId },
        routingId
      );

      return {
        success: true,
        journeyType: 'document_collection',
        voiceBotStatus: voiceBotResult.status,
        whatsappBotStatus: whatsappBotResult.status,
      };
    } catch (error) {
      logger.log('error', 'DOCUMENT_JOURNEY_ERROR', `Document journey failed: ${error.message}`, {
        routingId,
        phone,
        error: error.message,
        type: 'journey_error',
      });

      throw error;
    }
  }

  /**
   * PATH B: DIY Journey
   * Sends WhatsApp with Lender UTM link for direct application
   * Fallback logic: If Poonawalla rejects, send Hero FinCorp link
   */
  async _launchDIYJourney(data, routingId) {
    const { phone, name, callSid, campaignId, lenderId } = data;

    try {
      logger.log('info', 'DIY_JOURNEY_START', 'Starting DIY lender application journey', {
        routingId,
        phone,
        campaignId,
        primaryLender: lenderId,
        type: 'journey_start',
      });

      // Get lender UTM configuration
      const lenderConfig = this.lenderUTMs[lenderId];
      if (!lenderConfig) {
        throw new Error(`No UTM config for lender: ${lenderId}`);
      }

      // Build UTM link
      const utmLink = this._buildLenderUTMLink(lenderId, {
        phone,
        campaignId,
        routingId,
      });

      // Send WhatsApp with UTM link
      const whatsappResult = await this._sendLenderUTMLink(
        { phone, name, lenderId, utmLink },
        routingId
      );

      // Log DIY journey initiation
      await this._logDIYJourneyInitiation({
        routingId,
        phone,
        campaignId,
        lenderId,
        utmLink,
        messageId: whatsappResult.messageId,
      });

      // Track this for fallback (if Poonawalla rejects, we know to send Hero link)
      await this._trackDIYAttempt({
        phone,
        campaignId,
        primaryLender: lenderId,
        fallbackLender: this._getNextLender(lenderId),
      });

      return {
        success: true,
        journeyType: 'diy_application',
        primaryLender: lenderId,
        messageId: whatsappResult.messageId,
        utmLink,
      };
    } catch (error) {
      logger.log('error', 'DIY_JOURNEY_ERROR', `DIY journey failed: ${error.message}`, {
        routingId,
        phone,
        error: error.message,
        type: 'journey_error',
      });

      throw error;
    }
  }

  /**
   * Launch Ori Voice Bot for document collection
   */
  async _launchOriserveVoiceBot(data, routingId) {
    const { phone, name, campaignId, lenderId } = data;

    try {
      const result = await this.oriserveClient.initiateCampaign({
        phone,
        name,
        campaignId,
        purpose: 'document_collection',
        metadata: {
          routingId,
          lenderId,
        },
      });

      return {
        success: true,
        botId: result.campaignId,
        phone,
        startTime: new Date().toISOString(),
      };
    } catch (error) {
      logger.log('error', 'VOICE_BOT_ERROR', `Failed to launch voice bot: ${error.message}`, {
        routingId,
        phone,
        error: error.message,
        type: 'voice_bot_error',
      });

      throw error;
    }
  }

  /**
   * Launch Ananta WhatsApp Bot
   */
  async _launchAnantaWhatsAppBot(data, routingId, purpose) {
    const { phone, name, campaignId, lenderId } = data;

    try {
      const templates = {
        document_collection: {
          templateName: 'doc_collection_start',
          variables: [name, lenderId],
        },
      };

      const template = templates[purpose];
      if (!template) {
        throw new Error(`Unknown WhatsApp template: ${purpose}`);
      }

      const result = await this.anantaClient.sendTemplate({
        phone,
        templateName: template.templateName,
        variables: template.variables,
        metadata: {
          routingId,
          campaignId,
          lenderId,
          purpose,
        },
      });

      return {
        success: true,
        messageId: result.messageId,
        phone,
        sentTime: new Date().toISOString(),
      };
    } catch (error) {
      logger.log('error', 'WHATSAPP_BOT_ERROR', `Failed to launch WhatsApp bot: ${error.message}`, {
        routingId,
        phone,
        error: error.message,
        type: 'whatsapp_error',
      });

      throw error;
    }
  }

  /**
   * Build UTM link for lender direct application
   */
  _buildLenderUTMLink(lenderId, params) {
    const config = this.lenderUTMs[lenderId];
    if (!config) {
      throw new Error(`Unknown lender: ${lenderId}`);
    }

    const url = new URL(config.baseUrl);
    url.searchParams.append('utm_source', config.utmSource);
    url.searchParams.append('utm_medium', config.utmMedium);
    url.searchParams.append('utm_campaign', config.utmCampaign);
    url.searchParams.append('phone', params.phone);
    url.searchParams.append('campaign_id', params.campaignId);
    url.searchParams.append('routing_id', params.routingId);

    return url.toString();
  }

  /**
   * Send WhatsApp with lender UTM link
   */
  async _sendLenderUTMLink(data, routingId) {
    const { phone, name, lenderId, utmLink } = data;

    try {
      const lenderConfig = this.lenderUTMs[lenderId];

      const message = `Hi ${name}! 👋\n\nYou're just one click away from applying for a loan with ${lenderConfig.name}.\n\n🔗 Apply Now: ${utmLink}\n\nQuick, easy, and secure application.\n\nThanks,\nBuddyLoan`;

      const result = await this.anantaClient.sendMessage({
        phone,
        message,
        messageType: 'text',
        metadata: {
          routingId,
          lenderId,
          type: 'diy_application_link',
        },
      });

      return {
        success: true,
        messageId: result.messageId,
        phone,
        sentTime: new Date().toISOString(),
      };
    } catch (error) {
      logger.log('error', 'LENDER_LINK_SEND_ERROR', `Failed to send lender link: ${error.message}`, {
        routingId,
        phone,
        lenderId,
        error: error.message,
        type: 'messaging_error',
      });

      throw error;
    }
  }

  /**
   * Log routing decision to database
   */
  async _logRoutingDecision(data) {
    try {
      const { error } = await this.supabase
        .from('ivr_routing_decisions')
        .insert({
          routing_id: data.routingId,
          phone: data.phone,
          campaign_id: data.campaignId,
          campaign_type: data.campaignType,
          call_sid: data.callSid,
          dtmf_input: data.dtmf,
          routing_status: data.status,
          created_at: new Date().toISOString(),
        });

      if (error) {
        throw new Error(`Failed to log routing: ${error.message}`);
      }
    } catch (error) {
      logger.log('error', 'ROUTING_LOG_ERROR', `Failed to log routing decision: ${error.message}`, {
        phone: data.phone,
        error: error.message,
        type: 'database_error',
      });
    }
  }

  /**
   * Update customer journey status
   */
  async _updateCustomerJourneyStatus(data, routingId) {
    try {
      const { error } = await this.supabase
        .from('customer_journey_status')
        .upsert(
          {
            phone: data.phone,
            journey_type: data.journeyType,
            campaign_id: data.campaignId,
            status: 'active',
            started_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'phone' }
        );

      if (error) {
        throw new Error(`Failed to update journey status: ${error.message}`);
      }
    } catch (error) {
      logger.log('error', 'JOURNEY_STATUS_ERROR', `Failed to update journey status: ${error.message}`, {
        routingId,
        error: error.message,
        type: 'database_error',
      });
    }
  }

  /**
   * Log DIY journey initiation (for MIS tracking)
   */
  async _logDIYJourneyInitiation(data) {
    try {
      const { error } = await this.supabase
        .from('diy_journey_log')
        .insert({
          routing_id: data.routingId,
          phone: data.phone,
          campaign_id: data.campaignId,
          lender_id: data.lenderId,
          utm_link: data.utmLink,
          message_id: data.messageId,
          status: 'initiated',
          created_at: new Date().toISOString(),
        });

      if (error) {
        throw new Error(`Failed to log DIY journey: ${error.message}`);
      }
    } catch (error) {
      logger.log('warn', 'DIY_LOG_ERROR', `Failed to log DIY journey: ${error.message}`, {
        phone: data.phone,
        error: error.message,
        type: 'database_warning',
      });
    }
  }

  /**
   * Track DIY attempt for fallback logic
   */
  async _trackDIYAttempt(data) {
    try {
      const { error } = await this.supabase
        .from('diy_lender_tracking')
        .insert({
          phone: data.phone,
          campaign_id: data.campaignId,
          primary_lender: data.primaryLender,
          fallback_lender: data.fallbackLender,
          status: 'pending',
          created_at: new Date().toISOString(),
        });

      if (error) {
        throw new Error(`Failed to track DIY attempt: ${error.message}`);
      }
    } catch (error) {
      logger.log('warn', 'DIY_TRACK_ERROR', `Failed to track DIY attempt: ${error.message}`, {
        phone: data.phone,
        error: error.message,
        type: 'database_warning',
      });
    }
  }

  /**
   * Get next lender for fallback (e.g., Poonawalla → Hero)
   */
  _getNextLender(currentLender) {
    const lenderOrder = ['poonawalla', 'hero_fincorp'];
    const currentIndex = lenderOrder.indexOf(currentLender);

    if (currentIndex !== -1 && currentIndex < lenderOrder.length - 1) {
      return lenderOrder[currentIndex + 1];
    }

    return null; // No fallback available
  }

  /**
   * Handle lender rejection webhook
   * Triggers fallback to next lender (e.g., Poonawalla rejected → send Hero link)
   */
  async handleLenderRejection(data) {
    const { phone, campaignId, rejectedLender, rejectionCode, rejectionReason } = data;
    const rejectionId = `reject_${Date.now()}_${phone}`;

    try {
      logger.log('info', 'LENDER_REJECTION_RECEIVED', `${rejectedLender} rejected application`, {
        rejectionId,
        phone,
        rejectedLender,
        rejectionCode,
        rejectionReason,
        type: 'lender_webhook',
      });

      // Get fallback lender
      const fallbackLender = this._getNextLender(rejectedLender);
      if (!fallbackLender) {
        logger.log('info', 'NO_FALLBACK_AVAILABLE', 'No fallback lender available', {
          rejectionId,
          phone,
          rejectedLender,
          type: 'fallback_logic',
        });
        return {
          success: true,
          hasFallback: false,
          message: 'No fallback lender available',
        };
      }

      // Send fallback lender link
      logger.log('info', 'SENDING_FALLBACK', `Sending fallback to ${fallbackLender}`, {
        rejectionId,
        phone,
        fallbackLender,
        type: 'fallback_logic',
      });

      const utmLink = this._buildLenderUTMLink(fallbackLender, {
        phone,
        campaignId,
        routingId: rejectionId,
      });

      const result = await this._sendLenderUTMLink(
        { phone, name: 'Friend', lenderId: fallbackLender, utmLink },
        rejectionId
      );

      // Log fallback attempt
      await this._logFallbackAttempt({
        rejectionId,
        phone,
        campaignId,
        primaryLender: rejectedLender,
        fallbackLender,
        rejectionCode,
        rejectionReason,
        messageId: result.messageId,
      });

      return {
        success: true,
        hasFallback: true,
        fallbackLender,
        messageId: result.messageId,
      };
    } catch (error) {
      logger.log('error', 'FALLBACK_ERROR', `Fallback processing failed: ${error.message}`, {
        rejectionId,
        phone,
        error: error.message,
        type: 'fallback_error',
      });

      throw error;
    }
  }

  /**
   * Log fallback attempt
   */
  async _logFallbackAttempt(data) {
    try {
      const { error } = await this.supabase
        .from('diy_fallback_log')
        .insert({
          rejection_id: data.rejectionId,
          phone: data.phone,
          campaign_id: data.campaignId,
          primary_lender: data.primaryLender,
          fallback_lender: data.fallbackLender,
          rejection_code: data.rejectionCode,
          rejection_reason: data.rejectionReason,
          message_id: data.messageId,
          status: 'initiated',
          created_at: new Date().toISOString(),
        });

      if (error) {
        throw new Error(`Failed to log fallback: ${error.message}`);
      }
    } catch (error) {
      logger.log('warn', 'FALLBACK_LOG_ERROR', `Failed to log fallback: ${error.message}`, {
        phone: data.phone,
        error: error.message,
        type: 'database_warning',
      });
    }
  }
}

export default IVRCampaignRouter;
