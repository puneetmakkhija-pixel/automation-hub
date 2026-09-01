/**
 * Supabase Database Client
 * Stores and retrieves customer data, campaign records, and webhook events
 *
 * Database Tables:
 *   customers - Customer profiles with demographics
 *   campaigns - Campaign records and metadata
 *   webhook_events - Log of all incoming webhooks
 *   campaign_results - Results and metrics from each campaign
 *
 * Environment Variables:
 *   SUPABASE_URL - Your Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY - Service role key for database access
 *
 * Usage:
 *   import SupabaseClient from './supabaseClient.js';
 *   const db = new SupabaseClient();
 *
 *   // Store customer
 *   await db.createCustomer({
 *     phone: '919876543210',
 *     name: 'John Doe',
 *     age: 30,
 *     state: 'Maharashtra'
 *   });
 *
 *   // Log webhook event
 *   await db.logWebhookEvent('ananta', {
 *     phone: '919876543210',
 *     status: 'delivered',
 *     messageId: 'msg_123'
 *   });
 */

import { createClient } from '@supabase/supabase-js';

class SupabaseError extends Error {
  constructor(message, statusCode, details) {
    super(message);
    this.name = 'SupabaseError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

class SupabaseClient {
  constructor(url, serviceRoleKey) {
    this.url = url || process.env.SUPABASE_URL;
    this.serviceRoleKey = serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!this.url || !this.serviceRoleKey) {
      throw new SupabaseError(
        'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY',
        null,
        null
      );
    }

    this.client = createClient(this.url, this.serviceRoleKey);
  }

  /**
   * Create or update a customer record
   */
  async createCustomer(customerData) {
    const { phone, name, email, age, gender, state, maritalStatus, metadata = {} } = customerData;

    if (!phone || !name) {
      throw new SupabaseError('phone and name are required', null, null);
    }

    try {
      const { data, error } = await this.client
        .from('customers')
        .upsert(
          {
            phone: this.formatPhone(phone),
            name,
            email,
            age,
            gender,
            state,
            marital_status: maritalStatus,
            metadata,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'phone' }
        )
        .select();

      if (error) {
        throw new SupabaseError(`Failed to create customer: ${error.message}`, null, error);
      }

      return {
        success: true,
        customer: data?.[0],
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Create customer error:', error.message);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Get customer by phone number
   */
  async getCustomer(phone) {
    if (!phone) {
      throw new SupabaseError('phone is required', null, null);
    }

    try {
      const { data, error } = await this.client
        .from('customers')
        .select('*')
        .eq('phone', this.formatPhone(phone))
        .single();

      if (error && error.code !== 'PGRST116') {
        throw new SupabaseError(`Failed to get customer: ${error.message}`, null, error);
      }

      return {
        success: true,
        customer: data || null,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Get customer error:', error.message);
      return {
        success: false,
        error: error.message,
        customer: null,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Search customers by criteria
   */
  async searchCustomers(filters = {}) {
    try {
      let query = this.client.from('customers').select('*');

      if (filters.state) {
        query = query.eq('state', filters.state);
      }
      if (filters.ageMin && filters.ageMax) {
        query = query.gte('age', filters.ageMin).lte('age', filters.ageMax);
      }
      if (filters.gender) {
        query = query.eq('gender', filters.gender);
      }
      if (filters.maritalStatus) {
        query = query.eq('marital_status', filters.maritalStatus);
      }

      const { data, error } = await query.limit(1000);

      if (error) {
        throw new SupabaseError(`Failed to search customers: ${error.message}`, null, error);
      }

      return {
        success: true,
        customers: data || [],
        count: data?.length || 0,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Search customers error:', error.message);
      return {
        success: false,
        error: error.message,
        customers: [],
        count: 0,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Log webhook event
   */
  async logWebhookEvent(source, eventData) {
    if (!source) {
      throw new SupabaseError('source is required', null, null);
    }

    try {
      const { data, error } = await this.client
        .from('webhook_events')
        .insert({
          source,
          event_data: eventData,
          received_at: new Date().toISOString(),
        })
        .select();

      if (error) {
        throw new SupabaseError(`Failed to log webhook: ${error.message}`, null, error);
      }

      return {
        success: true,
        event: data?.[0],
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Log webhook error:', error.message);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Create campaign record
   */
  async createCampaign(campaignData) {
    const { campaignName, campaignId, campaignType, channel, status, metadata = {} } = campaignData;

    if (!campaignName || !campaignType) {
      throw new SupabaseError('campaignName and campaignType are required', null, null);
    }

    try {
      const { data, error } = await this.client
        .from('campaigns')
        .insert({
          campaign_name: campaignName,
          campaign_id: campaignId || `campaign_${Date.now()}`,
          campaign_type: campaignType, // 'voice', 'whatsapp', 'combined'
          channel,
          status: status || 'active',
          metadata,
          created_at: new Date().toISOString(),
        })
        .select();

      if (error) {
        throw new SupabaseError(`Failed to create campaign: ${error.message}`, null, error);
      }

      return {
        success: true,
        campaign: data?.[0],
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Create campaign error:', error.message);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Log campaign result
   */
  async logCampaignResult(resultData) {
    const { campaignId, phone, channel, status, result, metadata = {} } = resultData;

    if (!campaignId || !phone || !channel) {
      throw new SupabaseError('campaignId, phone, and channel are required', null, null);
    }

    try {
      const { data, error } = await this.client
        .from('campaign_results')
        .insert({
          campaign_id: campaignId,
          phone: this.formatPhone(phone),
          channel,
          status,
          result,
          metadata,
          logged_at: new Date().toISOString(),
        })
        .select();

      if (error) {
        throw new SupabaseError(`Failed to log result: ${error.message}`, null, error);
      }

      return {
        success: true,
        result: data?.[0],
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Log campaign result error:', error.message);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Get campaign results
   */
  async getCampaignResults(campaignId) {
    if (!campaignId) {
      throw new SupabaseError('campaignId is required', null, null);
    }

    try {
      const { data, error } = await this.client
        .from('campaign_results')
        .select('*')
        .eq('campaign_id', campaignId);

      if (error) {
        throw new SupabaseError(`Failed to get results: ${error.message}`, null, error);
      }

      return {
        success: true,
        results: data || [],
        count: data?.length || 0,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Get campaign results error:', error.message);
      return {
        success: false,
        error: error.message,
        results: [],
        count: 0,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Get campaign statistics
   */
  async getCampaignStats(campaignId) {
    if (!campaignId) {
      throw new SupabaseError('campaignId is required', null, null);
    }

    try {
      const { data, error } = await this.client
        .from('campaign_results')
        .select('channel, status, count()')
        .eq('campaign_id', campaignId)
        .group_by('channel', 'status');

      if (error) {
        throw new SupabaseError(`Failed to get stats: ${error.message}`, null, error);
      }

      return {
        success: true,
        stats: data || [],
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Get campaign stats error:', error.message);
      return {
        success: false,
        error: error.message,
        stats: [],
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Bulk create customers
   */
  async bulkCreateCustomers(customers) {
    if (!Array.isArray(customers) || customers.length === 0) {
      throw new SupabaseError('customers array is required', null, null);
    }

    try {
      const formatted = customers.map((c) => ({
        phone: this.formatPhone(c.phone),
        name: c.name,
        email: c.email,
        age: c.age,
        gender: c.gender,
        state: c.state,
        marital_status: c.maritalStatus,
        metadata: c.metadata || {},
        updated_at: new Date().toISOString(),
      }));

      const { data, error } = await this.client
        .from('customers')
        .upsert(formatted, { onConflict: 'phone' })
        .select();

      if (error) {
        throw new SupabaseError(`Failed to bulk create: ${error.message}`, null, error);
      }

      return {
        success: true,
        created: data?.length || 0,
        customers: data || [],
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Bulk create customers error:', error.message);
      return {
        success: false,
        error: error.message,
        created: 0,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Format phone number to standard format
   */
  formatPhone(phone) {
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length === 10) {
      return `91${cleaned}`;
    }
    return cleaned;
  }

  /**
   * Health check
   */
  async healthCheck() {
    try {
      const { data, error } = await this.client.from('customers').select('count()', { count: 'exact' }).limit(1);

      if (error && error.code !== 'PGRST116') {
        throw error;
      }

      return {
        success: true,
        status: 'healthy',
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Health check error:', error.message);
      return {
        success: false,
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }
}

export default SupabaseClient;
