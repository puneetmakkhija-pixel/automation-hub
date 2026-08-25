import { createClient } from "@supabase/supabase-js";
import OBDApiClient from "./obdApiClient.js";
import AnantaApiClient from "./anantaApiClient.js";
import PincodeGatingClient from "./pincodeGatingClient.js";
import ElevenLabsClient from "./elevenLabsClient.js";

class PoonawalaaCampaignOrchestrator {
  constructor() {
    this.supabaseUrl = process.env.SUPABASE_URL;
    this.supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    this.supabase = createClient(this.supabaseUrl, this.supabaseServiceRoleKey);
    this.obdClient = new OBDApiClient(
      process.env.OBD_BASE_URL,
      process.env.OBD_USERNAME,
      process.env.OBD_PASSWORD
    );
    this.anantaClient = new AnantaApiClient();
    this.gatingClient = new PincodeGatingClient();
    this.ttsClient = new ElevenLabsClient();

    this.campaignConfig = {
      lenderType: "poonawala",
      campaignName: "Poonawala STPL - Targeted Loan Offer",
      targetAge: { min: 24, max: 35 },
      minCibilScore: 720,
      dailyVolume: 50000,
      campaignDuration: 100, // days
      voiceRetryCount: 2,
      whatsappRetryCount: 1,
    };
  }

  async querySMECircleBase(filters = {}) {
    try {
      const { minAge = 24, maxAge = 35, minCibilScore = 720, limit = 1000, offset = 0 } = filters;

      const query = this.supabase
        .from("customers_sme")
        .select("phone,name,age,email,state,pincode,cibil_score,income,metadata", { count: "exact" });

      if (minAge && maxAge) {
        query.gte("age", minAge).lte("age", maxAge);
      }

      if (minCibilScore) {
        query.gte("cibil_score", minCibilScore);
      }

      const { data, error, count } = await query.range(offset, offset + limit - 1);

      if (error) throw error;

      return {
        customers: data || [],
        totalCount: count || 0,
        hasMore: count > offset + limit,
      };
    } catch (error) {
      throw new Error(`SME Circle query failed: ${error.message}`);
    }
  }

  async checkPoonawalaEligibility(customer) {
    try {
      const eligibilityData = {
        phone: customer.phone,
        pincode: customer.pincode,
        age: customer.age,
        income: customer.income || 0,
        cibilScore: customer.cibil_score,
        hunterScore: customer.metadata?.hunterScore || 0,
        dpdData: customer.metadata?.dpdData || { dpdLatest6m: 0, dpdLatest12m: 0 },
        bureauVintage: customer.metadata?.bureauVintage || 0,
        derogFlags: customer.metadata?.derogFlags || [],
        currentOverdue: customer.metadata?.currentOverdue || false,
        liveLoans: customer.metadata?.liveLoans || 0,
        enquiriesCount: customer.metadata?.enquiriesCount || 0,
        mfiStatus: customer.metadata?.mfiStatus || "none",
        mobileInBureau: customer.metadata?.mobileInBureau || true,
        panInBureau: customer.metadata?.panInBureau || true,
        dualPan: customer.metadata?.dualPan || false,
      };

      const eligibility = await this.gatingClient.checkEligibility(eligibilityData, "poonawala");
      return eligibility;
    } catch (error) {
      console.error(`Eligibility check failed for ${customer.phone}:`, error);
      return { eligible: false, reason: error.message };
    }
  }

  async generatePersonalizedGreeting(customer, loanAmount = 50000) {
    try {
      const greetingText = `Hello ${customer.name}. We have a special secured personal loan offer for you. Loan amount up to ${loanAmount} rupees. Press 1 to learn more or press 2 to speak with an agent.`;

      const audioResponse = await this.ttsClient.textToSpeech({
        text: greetingText,
        voiceId: "EXAVITQu4vr4xnSDxMaL", // Rachel voice
        stability: 0.5,
        similarityBoost: 0.75,
      });

      return {
        text: greetingText,
        audioUrl: audioResponse.audioUrl || null,
        audioBuffer: audioResponse.audio,
      };
    } catch (error) {
      console.error(`TTS generation failed for ${customer.name}:`, error);
      return { text: "Hello! We have a special loan offer for you. Press 1 to learn more." };
    }
  }

  async createCampaignBatch(customers, batchNumber = 1) {
    try {
      const campaign = {
        campaign_name: `${this.campaignConfig.campaignName} - Batch ${batchNumber}`,
        campaign_id: `poonawala_stpl_batch_${Date.now()}_${batchNumber}`,
        campaign_type: "combined",
        channel: "voice+whatsapp",
        status: "pending",
        metadata: {
          targetSegment: "Age 24-35, CIBIL 720+",
          batchNumber,
          batchSize: customers.length,
          createdAt: new Date().toISOString(),
          expectedConversion: Math.round(customers.length * 0.15), // 15% conversion assumption
        },
      };

      const { data, error } = await this.supabase.from("campaigns").insert(campaign);

      if (error) throw error;

      return {
        campaignId: campaign.campaign_id,
        campaignName: campaign.campaign_name,
        customerCount: customers.length,
      };
    } catch (error) {
      throw new Error(`Campaign creation failed: ${error.message}`);
    }
  }

  async triggerVoiceCall(customer, campaignId) {
    try {
      const greeting = await this.generatePersonalizedGreeting(customer, 50000);

      const callData = {
        mobile: customer.phone,
        campaign_id: campaignId,
        call_type: "voice_ivr",
        greeting_text: greeting.text,
        greeting_audio: greeting.audioUrl,
        ivr_options: {
          1: "learn_more",
          2: "agent_connect",
          3: "callback_later",
        },
        callback_url: `${process.env.BASE_URL || "http://localhost:3000"}/webhooks/poonawala/voice`,
        metadata: {
          customerName: customer.name,
          customerAge: customer.age,
          customerIncome: customer.income,
          cibilScore: customer.cibil_score,
        },
      };

      const result = await this.obdClient.composeCampaign(callData);

      return {
        success: true,
        callId: result.data?.call_id,
        phone: customer.phone,
        status: "initiated",
      };
    } catch (error) {
      console.error(`Voice call trigger failed for ${customer.phone}:`, error);
      return {
        success: false,
        phone: customer.phone,
        error: error.message,
      };
    }
  }

  async triggerWhatsAppFollowUp(customer, campaignId, callResult = {}) {
    try {
      const whatsappData = {
        phone: customer.phone,
        campaign_id: campaignId,
        template_id: "poonawala_stpl_offer",
        template_params: {
          name: customer.name,
          loanAmount: "50,000",
          interestRate: "12-18%",
          tenure: "12-60 months",
          approvalTime: "24 hours",
        },
        action_buttons: {
          button1: { text: "Apply Now", action: "open_url", url: "https://buddyloan.com/poonawala" },
          button2: { text: "Call Us", action: "call", phone: customer.phone },
        },
        metadata: {
          callAttempted: callResult.success || false,
          callId: callResult.callId || null,
          followUpDelay: callResult.success ? "2_hours" : "30_minutes",
        },
      };

      const result = await this.anantaClient.sendWhatsAppMessage(whatsappData);

      return {
        success: true,
        messageId: result.data?.message_id,
        phone: customer.phone,
        status: "sent",
      };
    } catch (error) {
      console.error(`WhatsApp follow-up failed for ${customer.phone}:`, error);
      return {
        success: false,
        phone: customer.phone,
        error: error.message,
      };
    }
  }

  async orchestrateCampaign(batchNumber = 1, limit = 50000) {
    try {
      console.log(`[Campaign Orchestrator] Starting batch ${batchNumber} - Max ${limit} customers`);

      const offset = (batchNumber - 1) * limit;
      const baseQuery = await this.querySMECircleBase({
        minAge: this.campaignConfig.targetAge.min,
        maxAge: this.campaignConfig.targetAge.max,
        minCibilScore: this.campaignConfig.minCibilScore,
        limit,
        offset,
      });

      console.log(`[Campaign Orchestrator] Found ${baseQuery.customers.length} candidates`);

      // Filter by Poonawala gating criteria
      const eligibleCustomers = [];
      const ineligibleReasons = {};

      for (const customer of baseQuery.customers) {
        const eligibility = await this.checkPoonawalaEligibility(customer);

        if (eligibility.eligible) {
          eligibleCustomers.push(customer);
        } else {
          const reason = eligibility.hardRejects[0] || eligibility.reason || "Unknown";
          ineligibleReasons[reason] = (ineligibleReasons[reason] || 0) + 1;
        }
      }

      console.log(`[Campaign Orchestrator] Eligible customers: ${eligibleCustomers.length}`);
      console.log(`[Campaign Orchestrator] Ineligibility breakdown:`, ineligibleReasons);

      // Create campaign
      const campaign = await this.createCampaignBatch(eligibleCustomers, batchNumber);

      // Trigger voice calls and track results
      const voiceResults = [];
      const callSuccessCount = 0;

      for (let i = 0; i < eligibleCustomers.length; i++) {
        const customer = eligibleCustomers[i];

        // Rate limiting: 50K per day = ~35 calls/second
        // Using 100ms delay between calls for safety
        if (i > 0 && i % 100 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        const voiceResult = await this.triggerVoiceCall(customer, campaign.campaignId);
        voiceResults.push(voiceResult);

        if (voiceResult.success) {
          callSuccessCount++;

          // Schedule WhatsApp follow-up (2 hours after call for successful calls, 30 min if no call)
          setTimeout(async () => {
            await this.triggerWhatsAppFollowUp(customer, campaign.campaignId, voiceResult);
          }, voiceResult.success ? 2 * 60 * 60 * 1000 : 30 * 60 * 1000);
        }
      }

      const successRate = (voiceResults.filter((r) => r.success).length / voiceResults.length) * 100;

      return {
        batchNumber,
        campaignId: campaign.campaignId,
        campaignName: campaign.campaignName,
        totalBaseCount: baseQuery.totalCount,
        candidatesQueried: baseQuery.customers.length,
        eligibleCount: eligibleCustomers.length,
        voiceCallsTriggered: voiceResults.length,
        voiceCallsSuccessful: voiceResults.filter((r) => r.success).length,
        voiceCallSuccess: successRate.toFixed(2) + "%",
        ineligibilityBreakdown: ineligibleReasons,
        nextBatchOffset: offset + limit,
        hasMoreCustomers: baseQuery.hasMore,
        estimatedConversion: Math.round(eligibleCustomers.length * 0.15),
        whatsappFollowUpScheduled: true,
      };
    } catch (error) {
      throw new Error(`Campaign orchestration failed: ${error.message}`);
    }
  }

  async getCampaignStatus(campaignId) {
    try {
      const { data: campaign, error: campaignError } = await this.supabase
        .from("campaigns")
        .select("*")
        .eq("campaign_id", campaignId)
        .single();

      if (campaignError) throw campaignError;

      const { data: results, error: resultsError } = await this.supabase
        .from("campaign_results")
        .select("*")
        .eq("campaign_id", campaignId);

      if (resultsError) throw resultsError;

      const voiceStats = {
        total: 0,
        delivered: 0,
        answered: 0,
        notAnswered: 0,
        failed: 0,
      };

      const whatsappStats = {
        total: 0,
        sent: 0,
        delivered: 0,
        read: 0,
        failed: 0,
      };

      for (const result of results) {
        if (result.channel === "obd" || result.channel === "voice") {
          voiceStats.total++;
          if (result.status === "delivered") voiceStats.delivered++;
          if (result.status === "answered") voiceStats.answered++;
          if (result.status === "not_answered") voiceStats.notAnswered++;
          if (result.status === "failed") voiceStats.failed++;
        } else if (result.channel === "ananta" || result.channel === "whatsapp") {
          whatsappStats.total++;
          if (result.status === "sent") whatsappStats.sent++;
          if (result.status === "delivered") whatsappStats.delivered++;
          if (result.status === "read") whatsappStats.read++;
          if (result.status === "failed") whatsappStats.failed++;
        }
      }

      return {
        campaignId,
        campaignName: campaign.campaign_name,
        status: campaign.status,
        createdAt: campaign.created_at,
        voiceStats,
        whatsappStats,
        totalContacts: results.length,
        overallDeliveryRate: (
          ((voiceStats.delivered + whatsappStats.delivered) / (voiceStats.total + whatsappStats.total)) *
          100
        ).toFixed(2) + "%",
      };
    } catch (error) {
      throw new Error(`Failed to get campaign status: ${error.message}`);
    }
  }

  async calculateCampaignROI(campaignId) {
    try {
      const { data: results } = await this.supabase.from("campaign_results").select("*").eq("campaign_id", campaignId);

      const uniqueContacts = new Set(results.map((r) => r.phone)).size;
      const conversions = results.filter((r) => r.result?.converted === true).length;
      const totalReachCost = uniqueContacts * 0.5; // ₹0.50 per reach (estimated)
      const costPerConversion = conversions > 0 ? totalReachCost / conversions : 0;
      const avgLoanAmount = 50000;
      const avgMargin = 0.03; // 3% margin on loan amount
      const revenuePerConversion = avgLoanAmount * avgMargin;

      return {
        campaignId,
        totalContacts: uniqueContacts,
        conversions,
        conversionRate: ((conversions / uniqueContacts) * 100).toFixed(2) + "%",
        totalReachCost: totalReachCost.toFixed(2),
        costPerConversion: costPerConversion.toFixed(2),
        revenuePerConversion: revenuePerConversion.toFixed(2),
        estimatedProfit: (conversions * revenuePerConversion - totalReachCost).toFixed(2),
        roi: (((conversions * revenuePerConversion - totalReachCost) / totalReachCost) * 100).toFixed(2) + "%",
      };
    } catch (error) {
      throw new Error(`ROI calculation failed: ${error.message}`);
    }
  }

  async healthCheck() {
    try {
      const { error: supabaseError } = await this.supabase.from("customers_sme").select("count()", { count: "exact" }).limit(1);

      if (supabaseError) throw supabaseError;

      return {
        success: true,
        status: "ready",
        components: {
          supabase: "connected",
          obd: "configured",
          ananta: "configured",
          gating: "configured",
          tts: "configured",
        },
      };
    } catch (error) {
      return {
        success: false,
        status: "error",
        error: error.message,
      };
    }
  }
}

export default PoonawalaaCampaignOrchestrator;
