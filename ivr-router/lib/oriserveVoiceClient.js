/**
 * Oriserve Voice Agent API Client
 * Triggers voice agent campaigns for outbound calls
 *
 * API Documentation:
 * Base URL: https://api-buddy-loan-vox.oriserve.com/api/v1
 * Authentication: X-API-Key header
 *
 * BuddyLoan runs on its own Oriserve tenant, api-buddy-loan-vox, not the
 * shared api-voice-agent host. See ivr-router/ORI_VOICE_BOT_CAMPAIGN.md.
 *
 * Environment Variables:
 *   ORISERVE_API_KEY - Your Oriserve API key
 *   ORISERVE_BASE_URL - API base URL (optional, defaults to the BuddyLoan tenant)
 *   ORISERVE_CAMPAIGN_ID - Default campaign to trigger when a caller omits one
 *   ORISERVE_WEBHOOK_URL - Your webhook URL for campaign callbacks
 *
 * Usage:
 *   import OriserveVoiceClient from './oriserveVoiceClient.js';
 *   const client = new OriserveVoiceClient();
 *   const result = await client.triggerCampaign({
 *     campaign_id: '6a969a1c91b08220629d6b88',
 *     mobile: '+919876543210',
 *     metadata: { customer_name: 'John Doe', account_id: 'BDL-10233' }
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
    this.baseUrl = baseUrl || process.env.ORISERVE_BASE_URL || 'https://api-buddy-loan-vox.oriserve.com/api/v1';
    this.webhookUrl = webhookUrl || process.env.ORISERVE_WEBHOOK_URL;
    this.defaultCampaignId = process.env.ORISERVE_CAMPAIGN_ID;
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
   * The callback URL we hand Oriserve, carrying the credential we will demand
   * back.
   *
   * We send notification_webhook_url on every trigger — it is not configured in
   * Oriserve's dashboard — and we used to send a bare URL. /webhooks/oriserve is
   * guarded by verifyWebhookSecret('ORISERVE_WEBHOOK_SECRET'), so every callback
   * they made was answered with a 401 and the outcome was lost:
   *
   *   [ORISERVE] Rejected request: missing secret (path=/webhooks/oriserve)
   *
   * On 04 Sep that ran from 04:24:31 — twenty seconds after the first call was
   * placed — continuously through 951 dispatched calls, and crm.voice_call_events
   * never took a single row. The word in the log is "missing", not "bad": they
   * were not sending a wrong secret, they had never been given one. Rotating
   * ORISERVE_WEBHOOK_SECRET would not have touched it.
   *
   * The token goes in the query string because that is the only slot we control.
   * verifyWebhookSecret reads x-webhook-secret, Authorization: Bearer, or
   * ?token= — and Oriserve composes the callback request, so we cannot make it
   * send a header. This is a deliberate trade: the secret is visible in their
   * request logs, which is why it is its own variable rather than one shared
   * with another integration, and why an existing token on the URL is never
   * overwritten.
   *
   * Read at call time, not in the constructor, so the URL and the secret cannot
   * drift apart in a long-lived process — two variables that had to agree by
   * hand is exactly how this broke.
   */
  callbackUrl(override) {
    const base = override || this.webhookUrl;
    if (!base) return base;

    const secret = (process.env.ORISERVE_WEBHOOK_SECRET || '').trim();
    if (!secret) return base;

    try {
      const url = new URL(base);
      // Someone who already put a token on the URL meant it. Do not second-guess.
      if (url.searchParams.has('token')) return base;
      url.searchParams.set('token', secret);
      return url.toString();
    } catch {
      // Not a parseable URL. Sending it unchanged reproduces the old behaviour,
      // which is a 401 rather than a call placed against a mangled callback.
      console.warn(
        `[ORISERVE] notification_webhook_url is not a valid URL — sending it ` +
          `unchanged, and the callback will be rejected as unauthenticated.`
      );
      return base;
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
   * @param {string} options.campaign_id - Oriserve campaign ID (defaults to ORISERVE_CAMPAIGN_ID)
   * @param {string} options.mobile - Customer phone number (+91XXXXXXXXXX)
   * @param {string} options.notification_webhook_url - Webhook URL for callbacks (optional)
   * @param {Object} options.metadata - Custom metadata (customer_name, account_id, etc.)
   * @returns {Promise<Object>} Campaign trigger response
   */
  async triggerCampaign(options) {
    const { mobile, notification_webhook_url, metadata = {} } = options;
    const campaign_id = options.campaign_id || this.defaultCampaignId;

    if (!campaign_id) {
      throw new OriserveAPIError(
        'campaign_id is required (pass it, or set ORISERVE_CAMPAIGN_ID)',
        null,
        null
      );
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
      notification_webhook_url: this.callbackUrl(notification_webhook_url),
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
