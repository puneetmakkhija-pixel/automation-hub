import supabase from '../clients/supabaseClient.js';
import axios from 'axios';

class RejectionTrackingClient {
  constructor() {
    this.slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
  }

  // Rejection reason mappings
  static REJECTION_REASONS = {
    // Bureau-based rejections
    'cibil_low': { category: 'bureau', display: 'CIBIL Score Below Threshold' },
    'hunter_score_failed': { category: 'bureau', display: 'Hunter Score Failed' },
    'dpd_detected': { category: 'bureau', display: 'Payment Defaults Detected' },
    'bureau_vintage_low': { category: 'bureau', display: 'Bureau History Too Short' },
    'enquiry_limit_exceeded': { category: 'bureau', display: 'Too Many Recent Enquiries' },
    'high_nbfc_exposure': { category: 'bureau', display: 'High NBFC Exposure' },

    // Demographic rejections
    'age_out_of_range': { category: 'demographic', display: 'Age Out of Range' },
    'income_below_minimum': { category: 'demographic', display: 'Income Below Minimum' },
    'income_above_maximum': { category: 'demographic', display: 'Income Above Maximum' },
    'pincode_not_serviceable': { category: 'demographic', display: 'Pincode Not Serviceable' },
    'state_not_serviceable': { category: 'demographic', display: 'State Not Serviceable' },
    'kyc_incomplete': { category: 'demographic', display: 'KYC Verification Failed' },

    // Business rejections
    'business_age_too_low': { category: 'business', display: 'Business Too New' },
    'industry_not_approved': { category: 'business', display: 'Industry Not Approved' },
    'leverage_too_high': { category: 'business', display: 'Debt Leverage Too High' },
    'revenue_below_threshold': { category: 'business', display: 'Revenue Below Threshold' },
    'business_type_not_approved': { category: 'business', display: 'Business Type Not Approved' },

    // Soft rejections
    'duplicate_application': { category: 'soft', display: 'Duplicate Application' },
    'application_incomplete': { category: 'soft', display: 'Application Incomplete' },
    'document_quality_low': { category: 'soft', display: 'Document Quality Issues' },
    'manual_review_required': { category: 'soft', display: 'Manual Review Required' },
    'compliance_check_failed': { category: 'soft', display: 'Compliance Check Failed' }
  };

  async captureRejection(rejectionData) {
    try {
      const {
        phone_number,
        application_id,
        lender_id,
        rejection_reason,
        rejection_message,
        rejected_bureau_vars = {},
        rejected_demographic_vars = {}
      } = rejectionData;

      if (!phone_number || !lender_id || !rejection_reason) {
        return {
          success: false,
          error: 'Missing required fields: phone_number, lender_id, rejection_reason'
        };
      }

      // Validate rejection reason
      if (!RejectionTrackingClient.REJECTION_REASONS[rejection_reason]) {
        console.warn(`[RejectionTracking] Unknown rejection reason: ${rejection_reason}`);
      }

      const reasonData = RejectionTrackingClient.REJECTION_REASONS[rejection_reason] || {
        category: 'unknown',
        display: rejection_reason
      };

      // Store rejection in Supabase
      const { data, error } = await supabase
        .from('rejection_logs')
        .insert({
          phone_number,
          application_id,
          lender_id,
          rejection_reason,
          rejection_category: reasonData.category,
          rejection_message,
          rejected_bureau_vars: Object.keys(rejected_bureau_vars).length > 0 ? rejected_bureau_vars : null,
          rejected_demographic_vars: Object.keys(rejected_demographic_vars).length > 0 ? rejected_demographic_vars : null,
          rejected_at: new Date().toISOString(),
          user_engaged_again: false
        });

      if (error) {
        console.error('[RejectionTracking] Storage error:', error.message);
        return { success: false, error: error.message };
      }

      console.log(`[RejectionTracking] Rejection captured: ${phone_number} → ${lender_id} (${rejection_reason})`);

      // Alert ops team via Slack
      await this.alertRejectionViaSlack(phone_number, lender_id, reasonData, rejected_bureau_vars, rejected_demographic_vars);

      return {
        success: true,
        data,
        message: `Rejection tracked: ${reasonData.display}`
      };
    } catch (error) {
      console.error('[RejectionTracking] Capture error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async alertRejectionViaSlack(phoneNumber, lenderId, reasonData, bureauVars, demographicVars) {
    try {
      if (!this.slackWebhookUrl) {
        return { success: false, error: 'Slack webhook not configured' };
      }

      const rejectionColor = this.getCategoryColor(reasonData.category);

      const payload = {
        channel: '#rejection-tracking',
        username: 'Rejection Tracker',
        icon_emoji: ':x:',
        attachments: [
          {
            fallback: `Rejection: ${phoneNumber} by ${lenderId}`,
            color: rejectionColor,
            title: `❌ Application Rejected`,
            fields: [
              {
                title: 'Phone',
                value: phoneNumber,
                short: true
              },
              {
                title: 'Lender',
                value: lenderId,
                short: true
              },
              {
                title: 'Reason',
                value: reasonData.display,
                short: true
              },
              {
                title: 'Category',
                value: reasonData.category.toUpperCase(),
                short: true
              }
            ],
            footer: 'Rejection Tracking Engine',
            ts: Math.floor(Date.now() / 1000)
          }
        ]
      };

      // Add bureau variables if present
      if (Object.keys(bureauVars).length > 0) {
        payload.attachments[0].fields.push({
          title: 'Bureau Variables',
          value: JSON.stringify(bureauVars),
          short: false
        });
      }

      // Add demographic variables if present
      if (Object.keys(demographicVars).length > 0) {
        payload.attachments[0].fields.push({
          title: 'Demographic Variables',
          value: JSON.stringify(demographicVars),
          short: false
        });
      }

      const response = await axios.post(this.slackWebhookUrl, payload);

      return {
        success: response.status === 200,
        message: 'Slack alert sent'
      };
    } catch (error) {
      console.warn('[RejectionTracking] Slack alert failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getRejectionsByLender(lenderId, hours = 24) {
    try {
      const startTime = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

      const { data, error } = await supabase
        .from('rejection_logs')
        .select('*')
        .eq('lender_id', lenderId)
        .gte('rejected_at', startTime)
        .order('rejected_at', { ascending: false });

      if (error) {
        console.error('[RejectionTracking] Query error:', error.message);
        return { success: false, error: error.message };
      }

      // Analyze rejection patterns
      const analysis = this.analyzeRejectionPatterns(data);

      return {
        success: true,
        total_rejections: data.length,
        rejections: data,
        analysis
      };
    } catch (error) {
      console.error('[RejectionTracking] Retrieval error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getRejectionsByCategory(category, hours = 24) {
    try {
      const startTime = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

      const { data, error } = await supabase
        .from('rejection_logs')
        .select('*')
        .eq('rejection_category', category)
        .gte('rejected_at', startTime)
        .order('rejected_at', { ascending: false });

      if (error) {
        console.error('[RejectionTracking] Query error:', error.message);
        return { success: false, error: error.message };
      }

      return {
        success: true,
        total_rejections: data.length,
        rejections: data
      };
    } catch (error) {
      console.error('[RejectionTracking] Retrieval error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getRejectionsByReason(rejectionReason, hours = 24) {
    try {
      const startTime = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

      const { data, error } = await supabase
        .from('rejection_logs')
        .select('*')
        .eq('rejection_reason', rejectionReason)
        .gte('rejected_at', startTime)
        .order('rejected_at', { ascending: false });

      if (error) {
        console.error('[RejectionTracking] Query error:', error.message);
        return { success: false, error: error.message };
      }

      return {
        success: true,
        total_rejections: data.length,
        rejections: data
      };
    } catch (error) {
      console.error('[RejectionTracking] Retrieval error:', error.message);
      return { success: false, error: error.message };
    }
  }

  analyzeRejectionPatterns(rejections) {
    if (!rejections || rejections.length === 0) {
      return { pattern: 'insufficient_data' };
    }

    // Count by reason
    const byReason = {};
    const byCategory = {};
    const bureauVarFrequency = {};
    const demographicVarFrequency = {};

    rejections.forEach(rejection => {
      // Count by reason
      byReason[rejection.rejection_reason] = (byReason[rejection.rejection_reason] || 0) + 1;

      // Count by category
      byCategory[rejection.rejection_category] = (byCategory[rejection.rejection_category] || 0) + 1;

      // Track bureau variables
      if (rejection.rejected_bureau_vars) {
        Object.keys(rejection.rejected_bureau_vars).forEach(key => {
          bureauVarFrequency[key] = (bureauVarFrequency[key] || 0) + 1;
        });
      }

      // Track demographic variables
      if (rejection.rejected_demographic_vars) {
        Object.keys(rejection.rejected_demographic_vars).forEach(key => {
          demographicVarFrequency[key] = (demographicVarFrequency[key] || 0) + 1;
        });
      }
    });

    // Calculate rejection rates
    const totalRejections = rejections.length;
    const topReasons = Object.entries(byReason)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason, count]) => ({
        reason,
        count,
        rate: (count / totalRejections * 100).toFixed(1) + '%'
      }));

    const topCategories = Object.entries(byCategory)
      .map(([category, count]) => ({
        category,
        count,
        rate: (count / totalRejections * 100).toFixed(1) + '%'
      }));

    return {
      total_rejections: totalRejections,
      top_rejection_reasons: topReasons,
      rejection_by_category: topCategories,
      bureau_vars_frequency: bureauVarFrequency,
      demographic_vars_frequency: demographicVarFrequency,
      pattern: topReasons[0] ? topReasons[0].reason : 'mixed'
    };
  }

  async markUserEngagedAgain(phoneNumber, reengagementChannel = 'whatsapp') {
    try {
      const { data, error } = await supabase
        .from('rejection_logs')
        .update({
          user_engaged_again: true,
          reengagement_channel: reengagementChannel,
          reengagement_sent_at: new Date().toISOString()
        })
        .eq('phone_number', phoneNumber)
        .eq('user_engaged_again', false)
        .order('rejected_at', { ascending: false })
        .limit(1);

      if (error) {
        console.error('[RejectionTracking] Update error:', error.message);
        return { success: false, error: error.message };
      }

      return { success: true, data };
    } catch (error) {
      console.error('[RejectionTracking] Mark re-engaged error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async recordReengagementResponse(phoneNumber, responseOutcome = 'started_application') {
    try {
      const { data, error } = await supabase
        .from('rejection_logs')
        .update({
          reengagement_response_at: new Date().toISOString()
        })
        .eq('phone_number', phoneNumber)
        .eq('reengagement_sent_at', { notNull: true })
        .order('reengagement_sent_at', { ascending: false })
        .limit(1);

      if (error) {
        console.error('[RejectionTracking] Response tracking error:', error.message);
        return { success: false, error: error.message };
      }

      return {
        success: true,
        outcome: responseOutcome,
        message: 'Re-engagement response tracked'
      };
    } catch (error) {
      console.error('[RejectionTracking] Response tracking error:', error.message);
      return { success: false, error: error.message };
    }
  }

  getCategoryColor(category) {
    const colors = {
      'bureau': '#FF6B6B',      // Red - hard to fix
      'demographic': '#FFA500',  // Orange - may expand later
      'business': '#FFD700',     // Gold - medium difficulty
      'soft': '#4CAF50',         // Green - easy to fix
      'unknown': '#808080'       // Gray
    };
    return colors[category] || '#808080';
  }

  getReasonForDisplay(reason) {
    return RejectionTrackingClient.REJECTION_REASONS[reason]?.display || reason;
  }
}

export default new RejectionTrackingClient();
