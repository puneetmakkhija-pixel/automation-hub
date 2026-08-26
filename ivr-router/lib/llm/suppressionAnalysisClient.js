import supabase from '../clients/supabaseClient.js';
import Anthropic from '@anthropic-ai/sdk';
import rejectionTrackingClient from './rejectionTrackingClient.js';

const client = new Anthropic();

class SuppressionAnalysisClient {
  constructor() {
    this.claudeModel = process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022';
  }

  async analyzeRejectionPatternsForRecalibration(timeWindowHours = 24, lenderIds = []) {
    try {
      const startTime = new Date(Date.now() - timeWindowHours * 60 * 60 * 1000).toISOString();

      let query = supabase
        .from('rejection_logs')
        .select('*')
        .gte('rejected_at', startTime);

      if (lenderIds.length > 0) {
        query = query.in('lender_id', lenderIds);
      }

      const { data: rejections, error } = await query;

      if (error) {
        console.error('[SuppressionAnalysis] Query error:', error.message);
        return { success: false, error: error.message };
      }

      if (!rejections || rejections.length === 0) {
        console.log('[SuppressionAnalysis] No rejections in timeframe');
        return {
          success: true,
          recommendation: null,
          message: 'Insufficient rejection data for analysis'
        };
      }

      // Analyze patterns using Phase 3.5c analyzer
      const analysis = rejectionTrackingClient.analyzeRejectionPatterns(rejections);

      console.log(`[SuppressionAnalysis] Analyzed ${rejections.length} rejections in ${timeWindowHours}h window`);

      // Get current rules for context
      const { data: currentRules, error: rulesError } = await supabase
        .from('eligibility_rules')
        .select('*')
        .eq('active', true)
        .order('created_at', { ascending: false })
        .limit(1);

      if (rulesError) {
        console.error('[SuppressionAnalysis] Rules fetch error:', rulesError.message);
      }

      const baseRules = currentRules?.[0] || this.getDefaultRules();

      // Call Claude to analyze and recommend changes
      const recommendation = await this.generateRuleRecommendation(
        analysis,
        rejections,
        baseRules
      );

      if (!recommendation.success) {
        return recommendation;
      }

      // Calculate impact (how many previously rejected users would now be eligible)
      const impact = await this.calculateRuleImpact(recommendation.suggested_rules, rejections);

      recommendation.impact = impact;

      // Store recommendation in history
      const { error: storeError } = await supabase
        .from('rule_recommendations')
        .insert({
          analysis_window_hours: timeWindowHours,
          rejection_count: rejections.length,
          analysis_data: analysis,
          current_rules: baseRules,
          recommended_rules: recommendation.suggested_rules,
          confidence_score: recommendation.confidence,
          estimated_reengagement_count: impact.estimated_newly_eligible,
          status: 'pending_review',
          created_at: new Date().toISOString()
        });

      if (storeError) {
        console.warn('[SuppressionAnalysis] Recommendation storage warning:', storeError.message);
      }

      return {
        success: true,
        recommendation,
        analysis
      };
    } catch (error) {
      console.error('[SuppressionAnalysis] Analysis error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async generateRuleRecommendation(analysis, rejections, currentRules) {
    try {
      // Build analysis summary for Claude
      const summaryForClaude = this.buildAnalysisSummary(analysis, rejections, currentRules);

      const prompt = `You are a credit risk analyst reviewing loan rejection patterns to identify over-suppressed eligibility rules.

CURRENT REJECTION ANALYSIS (Last 24-72 hours):
${summaryForClaude}

CURRENT ELIGIBILITY RULES:
${JSON.stringify(currentRules, null, 2)}

YOUR TASK:
Analyze the rejection patterns above and recommend adjustments to eligibility rules that would:
1. Expand the eligible pool by re-including currently over-suppressed segments
2. Maintain credit quality (approvals should still exceed 60% approval rate per lender)
3. Prioritize changes that would re-engage the largest segments

RESPOND WITH ONLY valid JSON (no markdown, no code blocks):
{
  "suggested_rules": {
    "cibil_minimum_score": <number or null if no change>,
    "age_minimum": <number or null>,
    "age_maximum": <number or null>,
    "income_minimum": <number or null>,
    "income_maximum": <number or null>,
    "business_age_minimum_months": <number or null>,
    "loan_amount_minimum": <number or null>,
    "loan_amount_maximum": <number or null>,
    "pincode_blocklist": <array or null>
  },
  "rationale": {
    "cibil_minimum_score": "<explanation if changed, null otherwise>",
    "age_minimum": "<explanation>",
    "age_maximum": "<explanation>",
    "income_minimum": "<explanation>",
    "income_maximum": "<explanation>",
    "business_age_minimum_months": "<explanation>",
    "loan_amount_minimum": "<explanation>",
    "loan_amount_maximum": "<explanation>",
    "pincode_blocklist": "<explanation>"
  },
  "confidence": <0.0-1.0 confidence score>,
  "estimated_additional_eligible_users": <estimated count based on analysis>,
  "key_insights": [
    "<insight 1: which rejection reason is causing most loss>",
    "<insight 2>",
    "<insight 3>"
  ]
}`;

      const message = await client.messages.create({
        model: this.claudeModel,
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      });

      const responseText = message.content[0].type === 'text' ? message.content[0].text : '';

      // Parse JSON response
      const recommendation = JSON.parse(responseText);

      console.log('[SuppressionAnalysis] Claude recommendation generated, confidence:', recommendation.confidence);

      return {
        success: true,
        suggested_rules: recommendation.suggested_rules,
        rationale: recommendation.rationale,
        confidence: recommendation.confidence,
        estimated_additional_eligible_users: recommendation.estimated_additional_eligible_users,
        key_insights: recommendation.key_insights
      };
    } catch (error) {
      console.error('[SuppressionAnalysis] Claude call error:', error.message);
      return { success: false, error: error.message };
    }
  }

  buildAnalysisSummary(analysis, rejections, currentRules) {
    const summary = {
      total_rejections: analysis.total_rejections,
      time_period: '24 hours',
      top_rejection_reasons: analysis.top_rejection_reasons,
      rejection_by_category: analysis.rejection_by_category,
      most_common_variables: {
        bureau_variables: Object.entries(analysis.bureau_vars_frequency || {})
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([k, v]) => `${k} (${v} times)`),
        demographic_variables: Object.entries(analysis.demographic_vars_frequency || {})
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([k, v]) => `${k} (${v} times)`)
      },
      approval_rate_by_lender: this.calculateApprovalRates(rejections),
      current_rule_context: {
        cibil_min: currentRules.cibil_minimum_score,
        age_range: `${currentRules.age_minimum}-${currentRules.age_maximum}`,
        income_range: `₹${currentRules.income_minimum}-₹${currentRules.income_maximum}`,
        loan_range: `₹${currentRules.loan_amount_minimum}-₹${currentRules.loan_amount_maximum}`
      }
    };

    return JSON.stringify(summary, null, 2);
  }

  calculateApprovalRates(rejections) {
    const lenderStats = {};

    rejections.forEach(r => {
      if (!lenderStats[r.lender_id]) {
        lenderStats[r.lender_id] = {
          rejections: 0,
          total_applications: 0
        };
      }
      lenderStats[r.lender_id].rejections++;
    });

    // Estimate total applications (rejections / estimated rejection rate of 30-40%)
    const rates = {};
    Object.entries(lenderStats).forEach(([lenderId, stats]) => {
      const estimatedApprovalRate = 1 - (stats.rejections / (stats.rejections / 0.35));
      rates[lenderId] = {
        rejections: stats.rejections,
        estimated_approval_rate: Math.max(0, Math.min(1, estimatedApprovalRate))
      };
    });

    return rates;
  }

  async calculateRuleImpact(suggestedRules, rejections) {
    try {
      let reengagementCount = 0;

      // Analyze which previously-rejected users would now be eligible
      rejections.forEach(rejection => {
        const bureauVars = rejection.rejected_bureau_vars || {};
        const demographicVars = rejection.rejected_demographic_vars || {};

        let wouldBeEligible = true;

        // Check against suggested rules
        if (suggestedRules.cibil_minimum_score && bureauVars.cibil_score) {
          if (bureauVars.cibil_score < suggestedRules.cibil_minimum_score) {
            wouldBeEligible = false;
          }
        }

        if (suggestedRules.age_minimum && demographicVars.age) {
          if (demographicVars.age < suggestedRules.age_minimum) {
            wouldBeEligible = false;
          }
        }

        if (suggestedRules.age_maximum && demographicVars.age) {
          if (demographicVars.age > suggestedRules.age_maximum) {
            wouldBeEligible = false;
          }
        }

        if (suggestedRules.income_minimum && demographicVars.annual_income) {
          if (demographicVars.annual_income < suggestedRules.income_minimum) {
            wouldBeEligible = false;
          }
        }

        if (wouldBeEligible) {
          reengagementCount++;
        }
      });

      return {
        estimated_newly_eligible: reengagementCount,
        percentage_of_rejected: ((reengagementCount / rejections.length) * 100).toFixed(1) + '%'
      };
    } catch (error) {
      console.error('[SuppressionAnalysis] Impact calculation error:', error.message);
      return { estimated_newly_eligible: 0, percentage_of_rejected: '0%' };
    }
  }

  async applyRuleChanges(recommendationId, approve = true) {
    try {
      if (!approve) {
        // Mark recommendation as rejected
        const { error } = await supabase
          .from('rule_recommendations')
          .update({ status: 'rejected' })
          .eq('id', recommendationId);

        if (error) {
          return { success: false, error: error.message };
        }

        console.log('[SuppressionAnalysis] Recommendation rejected');
        return { success: true, message: 'Recommendation marked as rejected' };
      }

      // Fetch recommendation
      const { data: recommendation, error: fetchError } = await supabase
        .from('rule_recommendations')
        .select('*')
        .eq('id', recommendationId)
        .single();

      if (fetchError || !recommendation) {
        return { success: false, error: 'Recommendation not found' };
      }

      // Deactivate old rules
      await supabase
        .from('eligibility_rules')
        .update({ active: false })
        .eq('active', true);

      // Insert new rules
      const newRules = {
        ...recommendation.recommended_rules,
        active: true,
        version: (recommendation.current_rules.version || 1) + 1,
        recommendation_id: recommendationId,
        created_at: new Date().toISOString()
      };

      const { error: insertError } = await supabase
        .from('eligibility_rules')
        .insert(newRules);

      if (insertError) {
        return { success: false, error: insertError.message };
      }

      // Mark recommendation as applied
      await supabase
        .from('rule_recommendations')
        .update({ status: 'applied' })
        .eq('id', recommendationId);

      console.log('[SuppressionAnalysis] New rules applied, version:', newRules.version);

      return {
        success: true,
        message: 'Rules updated successfully',
        new_version: newRules.version
      };
    } catch (error) {
      console.error('[SuppressionAnalysis] Apply error:', error.message);
      return { success: false, error: error.message };
    }
  }

getDefaultRules() {
    return {
      version: 1,
      cibil_minimum_score: 700,
      age_minimum: 21,
      age_maximum: 65,
      income_minimum: 150000,
      income_maximum: 5000000,
      business_age_minimum_months: 12,
      loan_amount_minimum: 50000,
      loan_amount_maximum: 5000000,
      pincode_blocklist: [],
      active: true,
      created_at: new Date().toISOString()
    };
  }
}

export default new SuppressionAnalysisClient();
