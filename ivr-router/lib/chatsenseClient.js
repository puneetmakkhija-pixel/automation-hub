/**
 * Chatsense Public API Client
 * Send WhatsApp templates, interactives, and flows via Chatsense
 *
 * API Documentation:
 * Base URL: https://api.chatsense.com/api/v1/public
 * Authentication: Bearer token (company-scoped API key)
 *
 * Environment Variables:
 *   CHATSENSE_API_KEY - Your Chatsense API key
 *   CHATSENSE_BASE_URL - API base URL (optional, defaults to production)
 *
 * Usage:
 *   import ChatsenseClient from './chatsenseClient.js';
 *   const client = new ChatsenseClient(process.env.CHATSENSE_API_KEY);
 *
 *   // Send template
 *   const result = await client.sendTemplate({
 *     phone: '919876543210',
 *     customerName: 'John Doe',
 *     templateName: 'welcome_template',
 *     language: 'en_US'
 *   });
 *
 *   // Send interactive
 *   const result = await client.sendInteractive({
 *     phone: '919876543210',
 *     interactiveId: 'interactive_123'
 *   });
 */

class ChatsenseAPIError extends Error {
  constructor(message, statusCode, response) {
    super(message);
    this.name = 'ChatsenseAPIError';
    this.statusCode = statusCode;
    this.response = response;
  }
}

class ChatsenseClient {
  constructor(apiKey, baseUrl, timeout = 30000) {
    this.apiKey = apiKey || process.env.CHATSENSE_API_KEY;
    this.baseUrl = baseUrl || process.env.CHATSENSE_BASE_URL || 'https://api.chatsense.com/api/v1/public';
    this.timeout = timeout;
    this.isConfigured = !!this.apiKey;

    if (!this.apiKey) {
      console.warn('⚠️ Chatsense client initialized without API key - messaging features unavailable');
    }
  }

  /**
   * Make API request to Chatsense
   */
  async makeRequest(method, path, body = null) {
    if (!this.isConfigured) {
      throw new ChatsenseAPIError(
        'Chatsense API key not configured',
        null,
        null
      );
    }

    const url = `${this.baseUrl}${path}`;
    const headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
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
        throw new ChatsenseAPIError(
          `${method} ${path} failed with HTTP ${response.status}`,
          response.status,
          data
        );
      }

      return data;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new ChatsenseAPIError(
          `Request timeout after ${this.timeout}ms`,
          null,
          null
        );
      }
      if (error instanceof ChatsenseAPIError) {
        throw error;
      }
      throw new ChatsenseAPIError(
        `Network error: ${error.message}`,
        null,
        null
      );
    }
  }

  /**
   * Validate API key
   */
  async validateApiKey() {
    try {
      const response = await this.makeRequest('POST', '/api-keys/validate', {
        apiKey: this.apiKey,
      });
      return {
        success: true,
        ...response,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('API key validation error:', error.message);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Send WhatsApp template message
   *
   * @param {Object} options - Send options
   * @param {string} options.phone - Phone number (10 digits, without +91)
   * @param {string} options.customerName - Customer name
   * @param {string} options.templateName - Template name
   * @param {string} options.language - Language code (default: en_US)
   */
  async sendTemplate(options) {
    const { phone, customerName, templateName, language = 'en_US' } = options;

    if (!phone || !customerName || !templateName) {
      throw new ChatsenseAPIError(
        'phone, customerName, and templateName are required',
        null,
        null
      );
    }

    const formattedPhone = this.formatPhoneNumber(phone);

    const payload = {
      phone: formattedPhone,
      customerName,
      templateName,
      language,
    };

    try {
      const response = await this.makeRequest('POST', '/integrations/templates/send', payload);

      return {
        success: true,
        phone: formattedPhone,
        templateName,
        ...response,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Send template error:', error.message);
      return {
        success: false,
        error: error.message,
        statusCode: error.statusCode,
        phone: formattedPhone,
        templateName,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Send WhatsApp interactive message
   *
   * @param {Object} options - Send options
   * @param {string} options.phone - Phone number
   * @param {string} options.interactiveId - Interactive element ID
   */
  async sendInteractive(options) {
    const { phone, interactiveId } = options;

    if (!phone || !interactiveId) {
      throw new ChatsenseAPIError(
        'phone and interactiveId are required',
        null,
        null
      );
    }

    const formattedPhone = this.formatPhoneNumber(phone);

    const payload = {
      phone: formattedPhone,
      interactiveId,
    };

    try {
      const response = await this.makeRequest('POST', '/integrations/interactives/send', payload);

      return {
        success: true,
        phone: formattedPhone,
        interactiveId,
        ...response,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Send interactive error:', error.message);
      return {
        success: false,
        error: error.message,
        statusCode: error.statusCode,
        phone: formattedPhone,
        interactiveId,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Send WhatsApp flow message
   *
   * @param {Object} options - Send options
   * @param {string} options.phone - Phone number
   * @param {string} options.flowId - Flow ID
   * @param {string} options.headerText - Header text
   * @param {string} options.bodyText - Body text
   * @param {string} options.footerText - Footer text (optional)
   * @param {string} options.ctaText - CTA button text (default: "Open")
   */
  async sendFlow(options) {
    const { phone, flowId, headerText, bodyText, footerText, ctaText = 'Open' } = options;

    if (!phone || !flowId || !headerText || !bodyText) {
      throw new ChatsenseAPIError(
        'phone, flowId, headerText, and bodyText are required',
        null,
        null
      );
    }

    const formattedPhone = this.formatPhoneNumber(phone);

    const payload = {
      phone: formattedPhone,
      flowId,
      headerText,
      bodyText,
      ctaText,
    };

    if (footerText) {
      payload.footerText = footerText;
    }

    try {
      const response = await this.makeRequest('POST', '/integrations/flows/send', payload);

      return {
        success: true,
        phone: formattedPhone,
        flowId,
        ...response,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Send flow error:', error.message);
      return {
        success: false,
        error: error.message,
        statusCode: error.statusCode,
        phone: formattedPhone,
        flowId,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * List available templates
   */
  async listTemplates() {
    try {
      const response = await this.makeRequest('GET', '/integrations/templates');
      return {
        success: true,
        templates: response.data || [],
        ...response,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('List templates error:', error.message);
      return {
        success: false,
        error: error.message,
        templates: [],
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * List available interactives
   */
  async listInteractives() {
    try {
      const response = await this.makeRequest('GET', '/integrations/interactives');
      return {
        success: true,
        interactives: response.data || [],
        ...response,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('List interactives error:', error.message);
      return {
        success: false,
        error: error.message,
        interactives: [],
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * List available flows
   */
  async listFlows() {
    try {
      const response = await this.makeRequest('GET', '/integrations/flows');
      return {
        success: true,
        flows: response.data || [],
        ...response,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('List flows error:', error.message);
      return {
        success: false,
        error: error.message,
        flows: [],
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * List webhooks
   */
  async listWebhooks() {
    try {
      const response = await this.makeRequest('GET', '/integrations/webhooks');
      return {
        success: true,
        webhooks: response.data || [],
        ...response,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('List webhooks error:', error.message);
      return {
        success: false,
        error: error.message,
        webhooks: [],
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Bulk send templates to multiple customers (with rate limiting)
   *
   * @param {Array} customers - Array of customer objects
   * @param {string} customers[].phone - Phone number
   * @param {string} customers[].customerName - Customer name
   * @param {string} templateName - Template name (same for all)
   * @param {number} delayMs - Delay between requests (default: 1000ms)
   */
  async bulkSendTemplate(customers, templateName, delayMs = 1000) {
    const results = {
      successful: 0,
      failed: 0,
      messages: [],
    };

    for (let i = 0; i < customers.length; i++) {
      const customer = customers[i];

      try {
        const result = await this.sendTemplate({
          phone: customer.phone,
          customerName: customer.customerName,
          templateName,
        });

        if (result.success) {
          results.successful++;
          results.messages.push({
            phone: customer.phone,
            status: 'sent',
            ...result,
          });
        } else {
          results.failed++;
          results.messages.push({
            phone: customer.phone,
            status: 'failed',
            error: result.error,
          });
        }
      } catch (error) {
        results.failed++;
        results.messages.push({
          phone: customer.phone,
          status: 'error',
          error: error.message,
        });
      }

      if (i < customers.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    return results;
  }

  /**
   * Format phone number to ensure proper format
   */
  formatPhoneNumber(phone) {
    // Remove all non-digits
    const cleaned = phone.replace(/\D/g, '');

    // If it's 10 digits, prepend 91 (India)
    if (cleaned.length === 10) {
      return `91${cleaned}`;
    }

    // If it's 12 digits starting with 91, return as is
    if (cleaned.length === 12 && cleaned.startsWith('91')) {
      return cleaned;
    }

    // Otherwise return cleaned
    return cleaned;
  }

  /**
   * Health check - verify API connectivity
   */
  async healthCheck() {
    try {
      const response = await this.validateApiKey();
      return {
        success: true,
        status: 'healthy',
        ...response,
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

export default ChatsenseClient;
