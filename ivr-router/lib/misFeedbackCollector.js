/**
 * Lender MIS Feedback Loop
 * Ingests daily lender MIS reports (specifically rejection reasons and codes)
 * from Poonawalla and Hero FinCorp
 * Logs rejection data back to customer profile for continuous BRE optimization
 *
 * Architecture:
 * - Webhook endpoint for lender MIS callbacks
 * - Processes rejection codes and reasons
 * - Updates customer metadata with rejection history
 * - Aggregates rejection patterns for BRE tuning
 * - Generates daily feedback reports
 *
 * Usage:
 *   const collector = new MISFeedbackCollector();
 *
 *   // Handle webhook from lender
 *   await collector.processMISReport({
 *     source: 'poonawalla',
 *     reportDate: '2024-01-15',
 *     records: [{
 *       phone: '919876543210',
 *       applicationId: 'poo_123',
 *       status: 'rejected',
 *       rejectionCode: 'CIBIL_LOW',
 *       rejectionReason: 'CIBIL score below minimum',
 *     }]
 *   });
 *
 *   // Generate optimization report
 *   const report = await collector.generateBREOptimizationReport('2024-01-15');
 */

import { createClient } from '@supabase/supabase-js';
import logger from './logging.js';

class MISFeedbackCollector {
  constructor() {
    this.supabaseUrl = process.env.SUPABASE_URL;
    this.supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    this.supabase = createClient(this.supabaseUrl, this.supabaseServiceRoleKey);

    // Common rejection codes across lenders
    this.rejectionCodeCategories = {
      // Credit-related rejections
      CIBIL_LOW: { category: 'credit_score', weight: 25, action: 'increase_min_cibil' },
      HUNTER_LOW: { category: 'credit_score', weight: 25, action: 'increase_min_hunter' },
      DEROG_FLAGS: { category: 'bureau_derogatory', weight: 30, action: 'hard_reject_derog' },
      CURRENT_OVERDUE: { category: 'default_risk', weight: 35, action: 'hard_reject_overdue' },
      DPD_VIOLATION: { category: 'payment_history', weight: 28, action: 'tighten_dpd_rules' },
      TOO_MANY_ENQUIRIES: { category: 'credit_seeking', weight: 20, action: 'tighten_enquiry_rules' },

      // Income-related rejections
      INCOME_LOW: { category: 'income', weight: 22, action: 'increase_min_income' },
      INCOME_UNVERIFIED: { category: 'income', weight: 20, action: 'increase_verification_requirement' },

      // Loan-related rejections
      TOO_MANY_LIVE_LOANS: { category: 'loan_portfolio', weight: 18, action: 'reduce_max_live_loans' },
      LOAN_AMOUNT_EXCESSIVE: { category: 'loan_amount', weight: 15, action: 'reduce_max_loan_amount' },

      // Bureau data rejections
      MOBILE_NOT_IN_BUREAU: { category: 'bureau_data', weight: 10, action: 'require_mobile_in_bureau' },
      PAN_NOT_IN_BUREAU: { category: 'bureau_data', weight: 10, action: 'require_pan_in_bureau' },
      DUAL_PAN: { category: 'bureau_data', weight: 12, action: 'hard_reject_dual_pan' },

      // Age/Demographics
      AGE_OUT_OF_RANGE: { category: 'demographics', weight: 5, action: 'adjust_age_range' },

      // Other rejections
      BUREAU_TIMEOUT: { category: 'technical', weight: 2, action: 'retry_later' },
      INVALID_DATA: { category: 'data_quality', weight: 3, action: 'improve_data_validation' },
      UNKNOWN: { category: 'unknown', weight: 1, action: 'escalate_for_review' },
    };

    // Lender-specific mappings
    this.lenderMappings = {
      poonawalla: {
        name: 'Poonawalla Fincorp',
        webhookSecret: process.env.POONAWALLA_MIS_SECRET,
        maxRetries: 3,
      },
      hero_fincorp: {
        name: 'Hero FinCorp',
        webhookSecret: process.env.HERO_FINCORP_MIS_SECRET,
        maxRetries: 3,
      },
    };
  }

  /**
   * Process MIS report from lender
   */
  async processMISReport(data) {
    const { source, reportDate, records } = data;
    const reportId = `mis_${source}_${reportDate}_${Date.now()}`;

    try {
      if (!this.lenderMappings[source]) {
        throw new Error(`Unknown lender source: ${source}`);
      }

      if (!records || !Array.isArray(records) || records.length === 0) {
        logger.log('warn', 'MIS_EMPTY_REPORT', `Empty MIS report from ${source}`, {
          reportId,
          source,
          reportDate,
          type: 'data_warning',
        });

        return {
          success: true,
          reportId,
          processed: 0,
          message: 'Empty report',
        };
      }

      logger.log('info', 'MIS_PROCESSING_START', `Processing ${records.length} MIS records from ${source}`, {
        reportId,
        source,
        reportDate,
        recordCount: records.length,
        type: 'batch_job',
      });

      // Step 1: Validate and normalize records
      const validRecords = await this._validateMISRecords(records, source);

      // Step 2: Process each record
      const processedCount = await this._processMISRecords(validRecords, source, reportId);

      // Step 3: Log MIS report metadata
      await this._logMISReportMetadata({
        reportId,
        source,
        reportDate,
        totalRecords: records.length,
        validRecords: validRecords.length,
        processedRecords: processedCount,
      });

      // Step 4: Generate rejection pattern analysis
      const patterns = await this._analyzeRejectionPatterns(validRecords);

      logger.log('info', 'MIS_PROCESSING_COMPLETE', `Processed ${processedCount} MIS records from ${source}`, {
        reportId,
        source,
        reportDate,
        processedCount,
        patterns,
        type: 'batch_job',
      });

      return {
        success: true,
        reportId,
        source,
        reportDate,
        processed: processedCount,
        patterns,
      };
    } catch (error) {
      logger.log('error', 'MIS_PROCESSING_ERROR', `MIS processing failed: ${error.message}`, {
        reportId,
        source,
        error: error.message,
        stack: error.stack,
        type: 'batch_job_error',
      });

      throw error;
    }
  }

  /**
   * Validate and normalize MIS records
   */
  async _validateMISRecords(records, source) {
    const validRecords = [];

    for (const record of records) {
      // Check required fields
      if (!record.phone || !record.applicationId || !record.status) {
        logger.log('warn', 'MIS_INVALID_RECORD', `Invalid MIS record: missing required fields`, {
          source,
          record,
          type: 'data_validation',
        });
        continue;
      }

      // Normalize phone number
      const normalizedPhone = this._normalizePhone(record.phone);

      // Map rejection code
      const rejectionCode = record.rejectionCode || 'UNKNOWN';
      const rejectionCodeInfo = this.rejectionCodeCategories[rejectionCode] || {
        category: 'unknown',
        weight: 1,
        action: 'escalate_for_review',
      };

      validRecords.push({
        phone: normalizedPhone,
        applicationId: record.applicationId,
        status: record.status,
        rejectionCode,
        rejectionReason: record.rejectionReason || 'No reason provided',
        rejectionCodeInfo,
        source,
        reportDate: record.reportDate || new Date().toISOString(),
      });
    }

    return validRecords;
  }

  /**
   * Process individual MIS records
   */
  async _processMISRecords(records, source, reportId) {
    let processedCount = 0;

    for (const record of records) {
      try {
        // Skip approvals (only track rejections for optimization)
        if (record.status === 'approved') {
          processedCount++;
          continue;
        }

        if (record.status !== 'rejected') {
          continue;
        }

        // Update customer profile with rejection info
        await this._updateCustomerRejectionProfile(record, reportId);

        // Log rejection event for audit trail
        await this._logRejectionEvent(record, reportId);

        processedCount++;
      } catch (error) {
        logger.log('error', 'MIS_RECORD_ERROR', `Failed to process MIS record: ${error.message}`, {
          reportId,
          phone: record.phone,
          error: error.message,
          type: 'record_processing_error',
        });
      }
    }

    return processedCount;
  }

  /**
   * Update customer rejection profile
   */
  async _updateCustomerRejectionProfile(record, reportId) {
    try {
      // Get existing customer profile
      const { data: customer, error: fetchError } = await this.supabase
        .from('customer_rejection_history')
        .select('*')
        .eq('phone', record.phone)
        .single();

      let rejectionHistory = [];
      if (customer && customer.rejection_history) {
        rejectionHistory = Array.isArray(customer.rejection_history)
          ? customer.rejection_history
          : JSON.parse(customer.rejection_history);
      }

      // Append new rejection
      rejectionHistory.push({
        lender: record.source,
        rejectionCode: record.rejectionCode,
        rejectionReason: record.rejectionReason,
        timestamp: new Date().toISOString(),
        reportId,
      });

      // Keep only last 10 rejections
      if (rejectionHistory.length > 10) {
        rejectionHistory = rejectionHistory.slice(-10);
      }

      // Update or insert customer record
      const { error: upsertError } = await this.supabase
        .from('customer_rejection_history')
        .upsert(
          {
            phone: record.phone,
            rejection_count: (customer?.rejection_count || 0) + 1,
            last_rejection_date: new Date().toISOString(),
            last_rejected_by: record.source,
            rejection_history: rejectionHistory,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'phone' }
        );

      if (upsertError) {
        throw new Error(`Failed to update customer: ${upsertError.message}`);
      }
    } catch (error) {
      logger.log('error', 'CUSTOMER_UPDATE_ERROR', `Failed to update customer rejection profile: ${error.message}`, {
        phone: record.phone,
        error: error.message,
        type: 'database_error',
      });

      throw error;
    }
  }

  /**
   * Log rejection event for compliance/audit
   */
  async _logRejectionEvent(record, reportId) {
    try {
      const { error } = await this.supabase
        .from('lender_rejection_events')
        .insert({
          report_id: reportId,
          phone: record.phone,
          application_id: record.applicationId,
          lender_id: record.source,
          rejection_code: record.rejectionCode,
          rejection_reason: record.rejectionReason,
          rejection_category: record.rejectionCodeInfo.category,
          rejection_weight: record.rejectionCodeInfo.weight,
          bre_action_required: record.rejectionCodeInfo.action,
          created_at: new Date().toISOString(),
        });

      if (error) {
        throw new Error(`Failed to log rejection event: ${error.message}`);
      }
    } catch (error) {
      logger.log('error', 'REJECTION_LOG_ERROR', `Failed to log rejection event: ${error.message}`, {
        phone: record.phone,
        error: error.message,
        type: 'database_error',
      });

      throw error;
    }
  }

  /**
   * Analyze rejection patterns for BRE optimization
   */
  async _analyzeRejectionPatterns(records) {
    const patterns = {
      topRejectionCodes: {},
      topRejectionReasons: {},
      byCategory: {},
      byLender: {},
    };

    for (const record of records) {
      // Count by rejection code
      patterns.topRejectionCodes[record.rejectionCode] =
        (patterns.topRejectionCodes[record.rejectionCode] || 0) + 1;

      // Count by reason
      patterns.topRejectionReasons[record.rejectionReason] =
        (patterns.topRejectionReasons[record.rejectionReason] || 0) + 1;

      // Count by category
      const category = record.rejectionCodeInfo.category;
      patterns.byCategory[category] = (patterns.byCategory[category] || 0) + 1;

      // Count by lender
      patterns.byLender[record.source] = (patterns.byLender[record.source] || 0) + 1;
    }

    return patterns;
  }

  /**
   * Log MIS report metadata
   */
  async _logMISReportMetadata(data) {
    try {
      const { error } = await this.supabase
        .from('mis_report_logs')
        .insert({
          report_id: data.reportId,
          source: data.source,
          report_date: data.reportDate,
          total_records: data.totalRecords,
          valid_records: data.validRecords,
          processed_records: data.processedRecords,
          created_at: new Date().toISOString(),
        });

      if (error) {
        throw new Error(`Failed to log MIS report: ${error.message}`);
      }
    } catch (error) {
      logger.log('warn', 'MIS_LOG_ERROR', `Failed to log MIS report metadata: ${error.message}`, {
        reportId: data.reportId,
        error: error.message,
        type: 'database_warning',
      });
    }
  }

  /**
   * Generate BRE optimization report based on rejection data
   */
  async generateBREOptimizationReport(reportDate) {
    const reportId = `bre_opt_${reportDate}_${Date.now()}`;

    try {
      logger.log('info', 'BRE_OPTIMIZATION_START', `Generating BRE optimization report for ${reportDate}`, {
        reportId,
        reportDate,
        type: 'analysis_job',
      });

      // Fetch rejection events from today
      const { data: rejections, error: fetchError } = await this.supabase
        .from('lender_rejection_events')
        .select('*')
        .gte('created_at', `${reportDate}T00:00:00Z`)
        .lt('created_at', `${reportDate}T23:59:59Z`);

      if (fetchError) {
        throw new Error(`Failed to fetch rejections: ${fetchError.message}`);
      }

      // Analyze patterns
      const analysis = this._analyzeRejectionPatterns(
        rejections.map(r => ({
          rejectionCode: r.rejection_code,
          rejectionReason: r.rejection_reason,
          rejectionCodeInfo: this.rejectionCodeCategories[r.rejection_code] || {
            category: 'unknown',
            weight: 1,
            action: 'escalate',
          },
          source: r.lender_id,
        }))
      );

      // Generate recommendations
      const recommendations = this._generateBRERecommendations(analysis);

      logger.log('info', 'BRE_OPTIMIZATION_COMPLETE', `BRE optimization report generated`, {
        reportId,
        reportDate,
        totalRejections: rejections.length,
        recommendations: recommendations.length,
        type: 'analysis_job',
      });

      return {
        success: true,
        reportId,
        reportDate,
        totalRejections: rejections.length,
        analysis,
        recommendations,
      };
    } catch (error) {
      logger.log('error', 'BRE_OPTIMIZATION_ERROR', `BRE optimization failed: ${error.message}`, {
        reportId,
        reportDate,
        error: error.message,
        type: 'analysis_job_error',
      });

      throw error;
    }
  }

  /**
   * Generate BRE optimization recommendations
   */
  _generateBRERecommendations(analysis) {
    const recommendations = [];

    // Sort rejection codes by frequency
    const sortedCodes = Object.entries(analysis.topRejectionCodes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    for (const [code, count] of sortedCodes) {
      const codeInfo = this.rejectionCodeCategories[code];
      if (!codeInfo) continue;

      const percentage = Math.round((count / Object.values(analysis.topRejectionCodes).reduce((a, b) => a + b, 0)) * 100);

      recommendations.push({
        code,
        category: codeInfo.category,
        frequency: count,
        percentage,
        action: codeInfo.action,
        recommendation: this._getRecommendationText(codeInfo.action, percentage),
        priority: codeInfo.weight > 20 ? 'high' : codeInfo.weight > 10 ? 'medium' : 'low',
      });
    }

    return recommendations;
  }

  /**
   * Get recommendation text based on action
   */
  _getRecommendationText(action, percentage) {
    const texts = {
      increase_min_cibil: `Increase minimum CIBIL score threshold (${percentage}% rejections due to low CIBIL)`,
      increase_min_hunter: `Increase minimum Hunter score threshold (${percentage}% rejections due to low Hunter score)`,
      hard_reject_derog: `Add hard reject rule for derog flags (${percentage}% rejections)`,
      hard_reject_overdue: `Add hard reject rule for current overdue (${percentage}% rejections)`,
      tighten_dpd_rules: `Tighten DPD (Days Past Due) criteria (${percentage}% rejections)`,
      tighten_enquiry_rules: `Reduce max enquiries allowed (${percentage}% rejections)`,
      increase_min_income: `Increase minimum income requirement (${percentage}% rejections)`,
      increase_verification_requirement: `Enhance income verification checks (${percentage}% rejections)`,
      reduce_max_live_loans: `Reduce max live loans allowed (${percentage}% rejections)`,
      reduce_max_loan_amount: `Reduce max loan amount offered (${percentage}% rejections)`,
      require_mobile_in_bureau: `Require mobile number to be in bureau (${percentage}% rejections)`,
      require_pan_in_bureau: `Require PAN to be in bureau (${percentage}% rejections)`,
      hard_reject_dual_pan: `Add hard reject for dual PAN (${percentage}% rejections)`,
      adjust_age_range: `Adjust target age range (${percentage}% rejections)`,
      retry_later: `Retry technical failures later (${percentage}% rejections)`,
      improve_data_validation: `Improve data validation before submission (${percentage}% rejections)`,
      escalate_for_review: `Manual review required for unknown rejections (${percentage}%)`,
    };

    return texts[action] || `Review and adjust BRE rules (${percentage}% rejections due to ${action})`;
  }

  /**
   * Get customer rejection history
   */
  async getCustomerRejectionHistory(phone) {
    try {
      const { data, error } = await this.supabase
        .from('customer_rejection_history')
        .select('*')
        .eq('phone', phone)
        .single();

      if (error && error.code !== 'PGRST116') { // Not found is expected
        throw error;
      }

      return {
        success: true,
        phone,
        rejectionCount: data?.rejection_count || 0,
        lastRejectionDate: data?.last_rejection_date,
        lastRejectedBy: data?.last_rejected_by,
        history: data?.rejection_history || [],
      };
    } catch (error) {
      logger.log('error', 'CUSTOMER_HISTORY_ERROR', `Failed to fetch rejection history: ${error.message}`, {
        phone,
        error: error.message,
        type: 'database_error',
      });

      throw error;
    }
  }

  /**
   * Normalize phone number
   */
  _normalizePhone(phone) {
    if (!phone) return phone;

    // Remove spaces, dashes, parentheses
    let normalized = phone.replace(/[\s\-()]/g, '');

    // Ensure 10 digit format (Indian) or 12 digit with +91
    if (normalized.length === 10) {
      normalized = '91' + normalized;
    }

    if (!normalized.startsWith('91')) {
      normalized = '91' + normalized;
    }

    return normalized.slice(-12); // Ensure max 12 digits
  }
}

export default MISFeedbackCollector;
