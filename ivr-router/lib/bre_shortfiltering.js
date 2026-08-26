/**
 * Daily Base Shortlisting Engine
 * Pulls ~50,000 records daily from Supabase SME Circle database
 * Applies lender-wise Business Rule Engine (BRE) filters and pincode targeting
 *
 * Architecture:
 * - Runs as scheduled job (typically 2-4 AM daily)
 * - Pulls from customers_sme table (4M+ users with bureau/banking/GST data)
 * - Applies lender-specific BRE rules (Poonawalla, Hero, HDFC, Bajaj)
 * - Filters by pincode serviceable lists
 * - Creates daily campaign shortlists
 * - Logs metrics for monitoring
 *
 * Usage:
 *   const shortlistEngine = new BREShortlistingEngine();
 *   await shortlistEngine.runDailyShortlist({
 *     targetDate: '2024-01-15',
 *     dailyLimit: 50000,
 *     lenders: ['poonawalla', 'hero_fincorp'],
 *     pincodes: ['110001', '110002', ...],
 *   });
 */

import { createClient } from '@supabase/supabase-js';
import logger from './logging.js';

class BREShortlistingEngine {
  constructor() {
    this.supabaseUrl = process.env.SUPABASE_URL;
    this.supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    this.supabase = createClient(this.supabaseUrl, this.supabaseServiceRoleKey);

    // BRE Rules per lender (can be moved to database)
    this.breRules = {
      poonawalla: {
        minAge: 24,
        maxAge: 55,
        minIncome: 250000, // ₹2.5L
        maxLoanAmount: 2500000, // ₹25L
        minCibilScore: 720,
        minHunterScore: 820,
        maxLiveLoans: 3,
        maxDpdLatest6m: 0,
        maxDpdLatest12m: 0,
        maxEnquiries6m: 2,
        derogReject: true,
        mobileInBureauRequired: true,
        panInBureauRequired: true,
      },
      hero_fincorp: {
        minAge: 24,
        maxAge: 55,
        minIncome: 150000, // ₹1.5L
        maxLoanAmount: 2000000, // ₹20L
        minCibilScore: 700,
        minHunterScore: 810,
        maxLiveLoans: 3,
        maxDpdLatest6m: 0,
        maxDpdLatest12m: 0,
        maxEnquiries6m: 2,
        derogReject: true,
        mobileInBureauRequired: true,
        panInBureauRequired: true,
      },
      hdfc_bank: {
        minAge: 25,
        maxAge: 50,
        minIncome: 500000, // ₹5L (premium)
        maxLoanAmount: 5000000, // ₹50L (premium)
        minCibilScore: 750,
        minHunterScore: 850,
        maxLiveLoans: 2,
        maxDpdLatest6m: 0,
        maxDpdLatest12m: 0,
        maxEnquiries6m: 1,
        derogReject: true,
        mobileInBureauRequired: true,
        panInBureauRequired: true,
      },
      bajaj_finserv: {
        minAge: 24,
        maxAge: 55,
        minIncome: 200000, // ₹2L
        maxLoanAmount: 3000000, // ₹30L
        minCibilScore: 700,
        minHunterScore: 810,
        maxLiveLoans: 3,
        maxDpdLatest6m: 0,
        maxDpdLatest12m: 0,
        maxEnquiries6m: 2,
        derogReject: true,
        mobileInBureauRequired: true,
        panInBureauRequired: true,
      },
    };
  }

  /**
   * Main entry point for daily shortlist generation
   */
  async runDailyShortlist(options = {}) {
    const startTime = Date.now();
    const {
      targetDate = new Date().toISOString().split('T')[0],
      dailyLimit = 50000,
      lenders = ['poonawalla', 'hero_fincorp'],
      pincodes = [],
      offset = 0,
    } = options;

    const jobId = `shortlist_${targetDate}_${Date.now()}`;

    try {
      logger.log('info', 'BRE_SHORTLIST_START', `Starting daily shortlist for ${targetDate}`, {
        jobId,
        targetDate,
        dailyLimit,
        lenders,
        pincodesCount: pincodes.length,
        type: 'batch_job',
      });

      // Step 1: Fetch raw base from Supabase
      const rawBase = await this._fetchSMECircleBase({
        limit: dailyLimit,
        offset,
        pincodes,
      });

      if (rawBase.customers.length === 0) {
        logger.log('warn', 'BRE_SHORTLIST_EMPTY', `No customers found for shortlist`, {
          jobId,
          targetDate,
          type: 'batch_job',
        });

        return {
          success: true,
          jobId,
          targetDate,
          shortlistMetrics: {
            totalFetched: 0,
            shortlistedTotal: 0,
            byLender: {},
            rejectionReasons: {},
          },
          durationMs: Date.now() - startTime,
        };
      }

      // Step 2: Apply BRE filters per lender
      const shortlistByLender = await this._applyBREFilters(
        rawBase.customers,
        lenders
      );

      // Step 3: Store shortlist in database
      await this._storeShortlist({
        jobId,
        targetDate,
        shortlistData: shortlistByLender,
      });

      // Step 4: Calculate metrics
      const metrics = this._calculateMetrics(shortlistByLender, rawBase.customers.length);

      logger.log('info', 'BRE_SHORTLIST_COMPLETE', `Shortlist complete for ${targetDate}`, {
        jobId,
        targetDate,
        totalFetched: rawBase.customers.length,
        shortlistedTotal: Object.values(shortlistByLender).flat().length,
        byLender: metrics.byLender,
        durationMs: Date.now() - startTime,
        type: 'batch_job',
      });

      return {
        success: true,
        jobId,
        targetDate,
        shortlistMetrics: metrics,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      logger.log('error', 'BRE_SHORTLIST_ERROR', `Shortlist failed: ${error.message}`, {
        jobId,
        targetDate,
        error: error.message,
        stack: error.stack,
        type: 'batch_job_error',
      });

      throw error;
    }
  }

  /**
   * Fetch raw customer base from SME Circle
   */
  async _fetchSMECircleBase({ limit = 50000, offset = 0, pincodes = [] }) {
    try {
      let query = this.supabase
        .from('customers_sme')
        .select(
          'id,phone,name,age,email,state,pincode,cibil_score,hunter_score,income,gst_status,banking_data,metadata',
          { count: 'exact' }
        );

      // Apply pincode filter if provided
      if (pincodes && pincodes.length > 0) {
        query = query.in('pincode', pincodes);
      }

      // Fetch data with pagination
      const { data, error, count } = await query
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        throw new Error(`Supabase fetch failed: ${error.message}`);
      }

      return {
        customers: data || [],
        totalCount: count || 0,
        hasMore: count > offset + limit,
      };
    } catch (error) {
      logger.log('error', 'BRE_FETCH_ERROR', `Failed to fetch SME Circle base: ${error.message}`, {
        error: error.message,
        type: 'database_error',
      });
      throw error;
    }
  }

  /**
   * Apply BRE filters to customer base per lender
   */
  async _applyBREFilters(customers, lenders) {
    const shortlistByLender = {};

    for (const lender of lenders) {
      shortlistByLender[lender] = [];
      const rules = this.breRules[lender];

      if (!rules) {
        logger.log('warn', 'BRE_RULES_MISSING', `No BRE rules found for lender: ${lender}`, {
          lender,
          type: 'configuration_warning',
        });
        continue;
      }

      for (const customer of customers) {
        const evaluation = this._evaluateCustomer(customer, rules, lender);

        if (evaluation.eligible) {
          shortlistByLender[lender].push({
            phone: customer.phone,
            name: customer.name,
            customerId: customer.id,
            lender,
            eligibilityScore: evaluation.score,
            metadata: {
              age: customer.age,
              income: customer.income,
              cibilScore: customer.cibil_score,
              hunterScore: customer.hunter_score,
              pincode: customer.pincode,
              state: customer.state,
              gstStatus: customer.gst_status,
            },
            evaluationDetails: evaluation.details,
          });
        }
      }
    }

    return shortlistByLender;
  }

  /**
   * Evaluate single customer against BRE rules
   */
  _evaluateCustomer(customer, rules, lender) {
    const details = {
      checks: [],
      passes: 0,
      failures: 0,
    };
    let score = 100; // Start with perfect score

    // Age check
    if (customer.age < rules.minAge || customer.age > rules.maxAge) {
      details.checks.push(`Age ${customer.age} outside range ${rules.minAge}-${rules.maxAge}`);
      details.failures++;
      score -= 20;
    } else {
      details.passes++;
    }

    // Income check
    if (!customer.income || customer.income < rules.minIncome) {
      details.checks.push(`Income ₹${customer.income || 0} below minimum ₹${rules.minIncome}`);
      details.failures++;
      score -= 15;
    } else {
      details.passes++;
    }

    // CIBIL score check
    if (!customer.cibil_score || customer.cibil_score < rules.minCibilScore) {
      details.checks.push(`CIBIL ${customer.cibil_score || 0} below minimum ${rules.minCibilScore}`);
      details.failures++;
      score -= 25;
    } else {
      details.passes++;
    }

    // Hunter score check
    const hunterScore = customer.metadata?.hunterScore || customer.hunter_score || 0;
    if (hunterScore < rules.minHunterScore) {
      details.checks.push(`Hunter ${hunterScore} below minimum ${rules.minHunterScore}`);
      details.failures++;
      score -= 20;
    } else {
      details.passes++;
    }

    // Live loans check
    const liveLoans = customer.metadata?.liveLoans || 0;
    if (liveLoans > rules.maxLiveLoans) {
      details.checks.push(`Live loans ${liveLoans} exceeds limit ${rules.maxLiveLoans}`);
      details.failures++;
      score -= 15;
    } else {
      details.passes++;
    }

    // DPD checks
    const dpdLatest6m = customer.metadata?.dpdData?.dpdLatest6m || 0;
    if (dpdLatest6m > rules.maxDpdLatest6m) {
      details.checks.push(`DPD(6M) ${dpdLatest6m} exceeds limit`);
      details.failures++;
      score = 0; // Hard reject
    }

    // Current overdue check (hard reject)
    if (customer.metadata?.currentOverdue) {
      details.checks.push('Current overdue found');
      details.failures++;
      score = 0; // Hard reject
    }

    // Bureau data checks
    if (rules.mobileInBureauRequired && !customer.metadata?.mobileInBureau) {
      details.checks.push('Mobile not in bureau');
      details.failures++;
      score -= 10;
    }

    if (rules.panInBureauRequired && !customer.metadata?.panInBureau) {
      details.checks.push('PAN not in bureau');
      details.failures++;
      score -= 10;
    }

    // Derog check
    if (rules.derogReject && customer.metadata?.derogFlags?.length > 0) {
      details.checks.push(`Derog flags present: ${customer.metadata.derogFlags.join(', ')}`);
      details.failures++;
      score = 0; // Hard reject
    }

    const eligible = score >= 50 && details.failures === 0; // Require pass all checks AND score >= 50

    return {
      eligible,
      score: Math.max(0, score),
      details,
    };
  }

  /**
   * Store shortlist in database
   */
  async _storeShortlist({ jobId, targetDate, shortlistData }) {
    try {
      const shortlistRecords = [];

      for (const [lender, customers] of Object.entries(shortlistData)) {
        for (const customer of customers) {
          shortlistRecords.push({
            job_id: jobId,
            shortlist_date: targetDate,
            lender_id: lender,
            phone: customer.phone,
            name: customer.name,
            customer_id: customer.customerId,
            eligibility_score: customer.eligibilityScore,
            metadata: customer.metadata,
            evaluation_details: customer.evaluationDetails,
            campaign_status: 'pending', // Ready for campaign dispatch
            created_at: new Date().toISOString(),
          });
        }
      }

      if (shortlistRecords.length === 0) {
        return;
      }

      const { error } = await this.supabase
        .from('bre_shortlists')
        .insert(shortlistRecords);

      if (error) {
        throw new Error(`Failed to store shortlist: ${error.message}`);
      }

      logger.log('info', 'BRE_STORE_SUCCESS', `Stored ${shortlistRecords.length} shortlist records`, {
        jobId,
        recordsStored: shortlistRecords.length,
        type: 'database_operation',
      });
    } catch (error) {
      logger.log('error', 'BRE_STORE_ERROR', `Failed to store shortlist: ${error.message}`, {
        jobId,
        error: error.message,
        type: 'database_error',
      });
      throw error;
    }
  }

  /**
   * Calculate metrics from shortlist
   */
  _calculateMetrics(shortlistByLender, totalFetched) {
    const metrics = {
      totalFetched,
      shortlistedTotal: 0,
      byLender: {},
      conversionRate: 0,
      rejectionReasons: {},
    };

    for (const [lender, customers] of Object.entries(shortlistByLender)) {
      metrics.byLender[lender] = {
        shortlisted: customers.length,
        conversionRate: ((customers.length / totalFetched) * 100).toFixed(2) + '%',
      };
      metrics.shortlistedTotal += customers.length;
    }

    if (totalFetched > 0) {
      metrics.conversionRate = ((metrics.shortlistedTotal / totalFetched) * 100).toFixed(2) + '%';
    }

    return metrics;
  }

  /**
   * Get shortlist for campaign dispatch
   */
  async getShortlistForDispatch(lender, limit = 10000, status = 'pending') {
    try {
      const { data, error } = await this.supabase
        .from('bre_shortlists')
        .select('*')
        .eq('lender_id', lender)
        .eq('campaign_status', status)
        .limit(limit);

      if (error) {
        throw new Error(`Failed to fetch shortlist: ${error.message}`);
      }

      return {
        success: true,
        customers: data || [],
        count: data?.length || 0,
      };
    } catch (error) {
      logger.log('error', 'BRE_FETCH_DISPATCH_ERROR', `Failed to get shortlist: ${error.message}`, {
        lender,
        error: error.message,
        type: 'database_error',
      });
      throw error;
    }
  }

  /**
   * Mark shortlist records as dispatched (for campaign orchestration)
   */
  async markAsDispatched(phones, campaignId) {
    try {
      const { error } = await this.supabase
        .from('bre_shortlists')
        .update({
          campaign_status: 'dispatched',
          campaign_id: campaignId,
          dispatched_at: new Date().toISOString(),
        })
        .in('phone', phones);

      if (error) {
        throw new Error(`Failed to mark as dispatched: ${error.message}`);
      }

      return {
        success: true,
        updated: phones.length,
      };
    } catch (error) {
      logger.log('error', 'BRE_MARK_ERROR', `Failed to mark shortlist: ${error.message}`, {
        phonesCount: phones.length,
        error: error.message,
        type: 'database_error',
      });
      throw error;
    }
  }
}

export default BREShortlistingEngine;
