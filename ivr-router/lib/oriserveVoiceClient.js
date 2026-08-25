/**
 * Oriserve Voice Agent API Client
 * Triggers voice agent campaigns for outbound calls
 *
 * API Documentation:
 * Base URL: https://api-voice-agent.oriserve.com/api/v1
 * Authentication: X-API-Key header
 *
 * Environment Variables:
 *   ORISERVE_API_KEY - Your Oriserve API key
 *   ORISERVE_BASE_URL - API base URL (optional, defaults to production)
 *   ORISERVE_WEBHOOK_URL - Your webhook URL for campaign callbacks
 *
 * Usage:
 *   import OriserveVoiceClient from './oriserveVoiceClient.js';
 *   const client = new OriserveVoiceClient();
 *   const result = await client.triggerCampaign({
 *     campaign_id: '6a54899dba2741b80ae58acd',
 *     mobile: '+919876543210',
 *     metadata: { customer_name: 'John Doe' }
 *   });
 */

import crypto from 'crypto';

class OriserveAPIError extends Error {
  constructor(message, statusCode, response) {
    super(message);
    this.name = 'OriserveAPIError';
    this.statusCode = statusCode;
    this.response = response;
  }
}

class OriserveVoiceClient {
  constructor(apiKey, baseUrl, webhookUrl, timeout = 30000) {
    this.apiKey = apiKey || process.env.ORISERVE_API_KEY;
    this.baseUrl = baseUrl || process.env.ORISERVE_BASE_URL || 'https://api-voice-agent.oriserve.com/api/v1';
    this.webhookUrl = webhookUrl || process.env.ORISERVE_WEBHOOK_URL;
    this.timeout = timeout;

    if (!this.apiKey) {
      throw new OriserveAPIError(
        'Missing ORISERVE_API_KEY environment variable',
        null,
        null
      );
    }
  }

  /**
   * Generate UUID for Idempotency-Key
   */
  generateIdempotencyKey() {
    return crypto.randomUUID();
  }

  /**
   * Validate phone number format
   */
  validatePhoneNumber(phoneNumber) {
    // Accept +91 format or 91 prefix
    const cleaned = phoneNumber.replace(/\D/g, '');
    const isValid = cleaned.length === 12 && cleaned.startsWith('91');
    const formatted = isValid ? `+${cleaned}` : phoneNumber;

    return {
      valid: isValid,
      formatted,
      error: !isValid ? 'Phone must be +91XXXXXXXXXX format (12 digits)' : null,
    };
  }

  /**
   * Make API request to Oriserve
   */
  async makeRequest(method, path, body = null) {
    const url = `${this.baseUrl}${path}`;
    const headers = {
      'X-API-Key': this.apiKey,
      'Content-Type': 'application/json',
      'Idempotency-Key': this.generateIdempotencyKey(),
      'User-Agent': 'automation-hub/1.0',
    };

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : null,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      let data;
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        data = await response.json();
      } else {
        data = { raw_text: await response.text() };
      }

      if (!response.ok) {
        throw new OriserveAPIError(
          `${method} ${path} failed with HTTP ${response.status}`,
          response.status,
          data
        );
      }

      return data;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new OriserveAPIError(
          `Request timeout after ${this.timeout}ms`,
          null,
          null
        );
      }
      if (error instanceof OriserveAPIError) {
        throw error;
      }
      throw new OriserveAPIError(
        `Network error: ${error.message}`,
        null,
        null
      );
    }
  }

  /**
   * Trigger a voice agent campaign
   *
   * @param {Object} options - Campaign options
   * @param {string} options.campaign_id - Oriserve campaign ID
   * @param {string} options.mobile - Customer phone number (+91XXXXXXXXXX)
   * @param {string} options.notification_webhook_url - Webhook URL for callbacks (optional)
   * @param {Object} options.metadata - Custom metadata (customer_name, account_id, etc.)
   * @returns {Promise<Object>} Campaign trigger response
   */
  async triggerCampaign(options) {
    const { campaign_id, mobile, notification_webhook_url, metadata = {} } = options;

    if (!campaign_id) {
      throw new OriserveAPIError('campaign_id is required', null, null);
    }

    if (!mobile) {
      throw new OriserveAPIError('mobile is required', null, null);
    }

    // Validate phone number
    const phoneValidation = this.validatePhoneNumber(mobile);
    if (!phoneValidation.valid) {
      throw new OriserveAPIError(phoneValidation.error, null, null);
    }

    const payload = {
      campaign_id,
      mobile: phoneValidation.formatted,
      notification_webhook_url: notification_webhook_url || this.webhookUrl,
      metadata,
    };

    try {
      const response = await this.makeRequest('POST', '/campaigns/trigger', payload);

      return {
        success: true,
        campaign_id,
        mobile: phoneValidation.formatted,
        ...response,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Campaign trigger error:', error.message);
      return {
        success: false,
        error: error.message,
        statusCode: error.statusCode,
        campaign_id,
        mobile: phoneValidation.formatted,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Trigger campaign for multiple customers (with rate limiting)
   *
   * @param {Array} customers - Array of customer objects with campaign_id, mobile, metadata
   * @param {number} delayMs - Delay between requests (default: 1000ms)
   */
  async bulkTriggerCampaigns(customers, delayMs = 1000) {
    const results = {
      successful: 0,
      failed: 0,
      campaigns: [],
    };

    for (let i = 0; i < customers.length; i++) {
      const customer = customers[i];

      try {
        const result = await this.triggerCampaign({
          campaign_id: customer.campaign_id,
          mobile: customer.mobile,
          metadata: customer.metadata || {},
        });

        if (result.success) {
          results.successful++;
          results.campaigns.push({
            mobile: customer.mobile,
            status: 'triggered',
            ...result,
          });
        } else {
          results.failed++;
          results.campaigns.push({
            mobile: customer.mobile,
            status: 'failed',
            error: result.error,
          });
        }
      } catch (error) {
        results.failed++;
        results.campaigns.push({
          mobile: customer.mobile,
          status: 'error',
          error: error.message,
        });
      }

      // Rate limiting: delay between requests
      if (i < customers.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    return results;
  }

  /**
   * Get campaign status (if supported by Oriserve)
   */
  async getCampaignStatus(campaignId) {
    try {
      const response = await this.makeRequest('GET', `/campaigns/${campaignId}/status`);
      return {
        success: true,
        ...response,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Get campaign status error:', error.message);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Cancel an active campaign call (if supported by Oriserve)
   */
  async cancelCampaign(campaignCallId) {
    try {
      const response = await this.makeRequest('POST', `/campaigns/${campaignCallId}/cancel`);
      return {
        success: true,
        ...response,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Cancel campaign error:', error.message);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * List available campaigns
   */
  async listCampaigns() {
    try {
      const response = await this.makeRequest('GET', '/campaigns');
      return {
        success: true,
        campaigns: response.data || [],
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('List campaigns error:', error.message);
      return {
        success: false,
        error: error.message,
        campaigns: [],
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Health check - verify API connectivity
   */
  async healthCheck() {
    try {
      const response = await this.makeRequest('GET', '/health');
      return {
        success: true,
        status: 'healthy',
        ...response,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        success: false,
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }
}

export default OriserveVoiceClient;
