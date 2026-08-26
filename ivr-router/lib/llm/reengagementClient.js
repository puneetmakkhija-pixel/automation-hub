import supabase from '../clients/supabaseClient.js';
import Anthropic from '@anthropic-ai/sdk';
import anantaClient from '../clients/anantaClient.js';

const client = new Anthropic();

class ReengagementClient {
  constructor() {
    this.claudeModel = process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022';
  }

  async findNewlyEligibleUsers(timeWindowHours = 24) {
    try {
      // Get previous and current eligibility rules
      const { data: rulesHistory, error: rulesError } = await supabase
        .from('eligibility_rules')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(2);

      if (rulesError || !rulesHistory || rulesHistory.length < 2) {
        console.log('[Reengagement] Insufficient rule history for comparison');
        return {
          success: true,
          newly_eligible_users: [],
          message: 'No rule changes to process'
        };
      }

      const currentRules = rulesHistory[0];
      const previousRules = rulesHistory[1];

      // Find users who were rejected in the time window
      const startTime = new Date(Date.now() - timeWindowHours * 60 * 60 * 1000).toISOString();

      const { data: rejections, error: rejectError } = await supabase
        .from('rejection_logs')
        .select('phone_number, rejected_bureau_vars, rejected_demographic_vars, rejected_at')
        .gte('rejected_at', startTime)
        .eq('user_engaged_again', false);

      if (rejectError || !rejections) {
        return { success: false, error: rejectError.message };
      }

      // Filter: Would they be eligible under new rules but not old rules?
      const newlyEligible = [];

      for (const rejection of rejections) {
        const wouldFailOldRules = this.checkEligibility(
          rejection,
          previousRules
        );
        const wouldPassNewRules = !this.checkEligibility(
          rejection,
          currentRules
        );

        if (wouldFailOldRules && wouldPassNewRules) {
          newlyEligible.push({
            phone_number: rejection.phone_number,
            bureau_vars: rejection.rejected_bureau_vars,
            demographic_vars: rejection.rejected_demographic_vars,
            rejected_at: rejection.rejected_at
          });
        }
      }

      console.log(`[Reengagement] Found ${newlyEligible.length} newly-eligible users in ${timeWindowHours}h window`);

      return {
        success: true,
        newly_eligible_users: newlyEligible,
        count: newlyEligible.length,
        previous_rules_version: previousRules.version,
        current_rules_version: currentRules.version
      };
    } catch (error) {
      console.error('[Reengagement] Query error:', error.message);
      return { success: false, error: error.message };
    }
  }

  checkEligibility(rejection, rules) {
    // Returns true if INELIGIBLE (failed check), false if eligible
    const bureau = rejection.rejected_bureau_vars || {};
    const demographic = rejection.rejected_demographic_vars || {};

    if (bureau.cibil_score && bureau.cibil_score < rules.cibil_minimum_score) {
      return true;  // Ineligible
    }
    if (demographic.age && demographic.age < rules.age_minimum) {
      return true;
    }
    if (demographic.age && demographic.age > rules.age_maximum) {
      return true;
    }
    if (demographic.annual_income && demographic.annual_income < rules.income_minimum) {
      return true;
    }
    if (demographic.annual_income && demographic.annual_income > rules.income_maximum) {
      return true;
    }

    return false;  // Eligible
  }

  async generateReengagementMessage(phoneNumber, userProfile) {
    try {
      const prompt = `You are a loan origination specialist crafting a re-engagement message for a user who was previously rejected but is NOW NEWLY ELIGIBLE under updated lending rules.

USER PROFILE:
${JSON.stringify(userProfile, null, 2)}

CONTEXT:
- This user previously applied and was rejected
- New rules now allow their profile (we relaxed CIBIL/age/income thresholds based on market data)
- We want to re-engage them with confidence and personalization
- Message should be 1-2 sentences max, conversational, WhatsApp-friendly

CRAFT A MESSAGE (return ONLY the message text, no JSON):`;

      const message = await client.messages.create({
        model: this.claudeModel,
        max_tokens: 150,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      });

      const messageText = message.content[0].type === 'text' ? message.content[0].text : '';
      return messageText.trim();
    } catch (error) {
      console.error('[Reengagement] Message generation error:', error.message);
      // Fallback message
      return `Great news! Based on updated eligibility criteria, you now qualify for a loan. Would you like to restart your application?`;
    }
  }

  async sendReengagementCampaign(newlyEligibleUsers, personaSegmentation = true) {
    try {
      if (!newlyEligibleUsers || newlyEligibleUsers.length === 0) {
        return { success: true, message: 'No users to re-engage', sent: 0 };
      }

      const results = {
        total: newlyEligibleUsers.length,
        sent: 0,
        failed: 0,
        channels: {
          whatsapp: 0
        },
        details: []
      };

      for (const user of newlyEligibleUsers) {
        try {
          // Fetch full user profile
          const { data: userProfile, error: profileError } = await supabase
            .from('users')
            .select('*')
            .eq('phone_number', user.phone_number)
            .single();

          if (profileError || !userProfile) {
            results.failed++;
            continue;
          }

          // Generate personalized message
          const personalizedMessage = await this.generateReengagementMessage(
            user.phone_number,
            userProfile
          );

          // Send WhatsApp
          const whatsappResult = await this.sendWhatsAppReengagement(
            user.phone_number,
            personalizedMessage,
            userProfile
          );

          if (whatsappResult.success) {
            results.channels.whatsapp++;
          }

          // Log campaign event
          await this.trackReengagementCampaign(
            user.phone_number,
            'campaign_sent',
            {
              message: personalizedMessage,
              whatsapp_sent: whatsappResult.success
            }
          );

          results.sent++;
          results.details.push({
            phone_number: user.phone_number,
            whatsapp_message_id: whatsappResult.message_id,
            timestamp: new Date().toISOString()
          });
        } catch (error) {
          console.error(`[Reengagement] Campaign error for ${user.phone_number}:`, error.message);
          results.failed++;
        }
      }

      return {
        success: true,
        message: `Re-engagement campaign sent`,
        results
      };
    } catch (error) {
      console.error('[Reengagement] Campaign error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async sendWhatsAppReengagement(phoneNumber, personalizedMessage, userProfile) {
    try {
      const message = `Hi ${userProfile.name || 'there'}! ${personalizedMessage}\n\nTap to restart: https://wa.link/automation-hub/restart/${phoneNumber}`;

      const result = await anantaClient.sendTextMessage(phoneNumber, message);

      if (result.success) {
        console.log(`[Reengagement] WhatsApp sent to ${phoneNumber}`);
        return {
          success: true,
          message_id: result.data?.msg_id
        };
      } else {
        return { success: false, error: result.error };
      }
    } catch (error) {
      console.error('[Reengagement] WhatsApp error:', error.message);
      return { success: false, error: error.message };
    }
  }

async trackReengagementCampaign(phoneNumber, eventType, metadata) {
    try {
      const { error } = await supabase
        .from('reengagement_events')
        .insert({
          phone_number: phoneNumber,
          event_type: eventType,  // campaign_sent, email_clicked, whatsapp_opened, application_started
          metadata,
          created_at: new Date().toISOString()
        });

      if (error) {
        console.warn('[Reengagement] Event tracking warning:', error.message);
      }
    } catch (error) {
      console.error('[Reengagement] Event tracking error:', error.message);
    }
  }

  async trackReengagementResponse(phoneNumber, responseOutcome) {
    try {
      // Call Phase 3.5c method to mark user as engaged
      await supabase
        .from('rejection_logs')
        .update({
          reengagement_response_at: new Date().toISOString(),
          reengagement_response_outcome: responseOutcome
        })
        .eq('phone_number', phoneNumber)
        .eq('reengagement_sent_at', { not: { is: null } })
        .order('reengagement_sent_at', { ascending: false })
        .limit(1);

      await this.trackReengagementCampaign(phoneNumber, 'response_recorded', {
        outcome: responseOutcome
      });

      console.log(`[Reengagement] Response tracked for ${phoneNumber}: ${responseOutcome}`);
      return { success: true };
    } catch (error) {
      console.error('[Reengagement] Response tracking error:', error.message);
      return { success: false, error: error.message };
    }
  }

formatLoanAmount(amount) {
    if (!amount) return '50,000-50,00,000';
    if (amount >= 1000000) {
      return (amount / 1000000).toFixed(0) + 'L';
    } else if (amount >= 100000) {
      return (amount / 100000).toFixed(0) + 'K';
    }
    return amount.toString();
  }

  getApplicableRate() {
    return '10.5';  // Default rate, can be personalized per user
  }

  async getReengagementMetrics(timeWindowHours = 24) {
    try {
      const startTime = new Date(Date.now() - timeWindowHours * 60 * 60 * 1000).toISOString();

      // Campaign sent events
      const { data: campaigns, error: campaignError } = await supabase
        .from('reengagement_events')
        .select('*')
        .eq('event_type', 'campaign_sent')
        .gte('created_at', startTime);

      // Response events
      const { data: responses, error: responseError } = await supabase
        .from('reengagement_events')
        .select('*')
        .eq('event_type', 'response_recorded')
        .gte('created_at', startTime);

      if (campaignError || responseError) {
        return { success: false, error: 'Metrics query failed' };
      }

      const conversionRate = campaigns.length > 0
        ? ((responses.length / campaigns.length) * 100).toFixed(1)
        : '0.0';

      return {
        success: true,
        metrics: {
          campaigns_sent: campaigns.length,
          responses_received: responses.length,
          conversion_rate: parseFloat(conversionRate),
          time_window_hours: timeWindowHours
        }
      };
    } catch (error) {
      console.error('[Reengagement] Metrics error:', error.message);
      return { success: false, error: error.message };
    }
  }
}

export default new ReengagementClient();
