/**
 * Ananta WhatsApp data-api client (Node.js)
 * Fetches approved templates, campaign links, and webhooks from data-api.anantadot.com
 *
 * Credentials: set these as environment variables, never hardcode them:
 *   ANANTA_API_TOKEN
 *   ANANTA_API_SECRET_KEY
 *
 * Usage:
 *   import AnantaDataClient from './anantaDataClient.js';
 *   const client = new AnantaDataClient();
 *   const templates = await client.getApprovedTemplates();
 */

const DATA_BASE = 'https://data-api.anantadot.com';

class AnantaAPIError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AnantaAPIError';
  }
}

class AnantaDataClient {
  constructor(apiToken, apiSecretKey, timeout = 30000) {
    this.apiToken = apiToken || process.env.ANANTA_API_TOKEN;
    this.apiSecretKey = apiSecretKey || process.env.ANANTA_API_SECRET_KEY;
    this.timeout = timeout;

    if (!this.apiToken || !this.apiSecretKey) {
      throw new AnantaAPIError(
        'Missing ANANTA_API_TOKEN / ANANTA_API_SECRET_KEY environment variables.'
      );
    }
  }

  async callDataApi(method, path, extraBody = {}) {
    const body = {
      api_token: this.apiToken,
      api_sec_key: this.apiSecretKey,
      ...extraBody,
    };

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const res = await fetch(`${DATA_BASE}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      let data;
      const text = await res.text();
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw_text: text };
      }

      if (!res.ok) {
        throw new AnantaAPIError(
          `${method} ${path} failed with HTTP ${res.status}: ${JSON.stringify(data)}`
        );
      }

      if (data && String(data.status).toLowerCase() === 'false') {
        throw new AnantaAPIError(
          `${method} ${path} returned an error: ${JSON.stringify(data)}`
        );
      }

      return data;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new AnantaAPIError(`Request timeout after ${this.timeout}ms`);
      }
      throw error;
    }
  }

  /**
   * GET /WhatsApp/templates/approved
   * Returns template id, name, approval status
   */
  async getApprovedTemplates() {
    return this.callDataApi('GET', '/WhatsApp/templates/approved');
  }

  /**
   * POST /WhatsApp/list-templates
   * Alternative method to list templates
   */
  async listTemplates() {
    return this.callDataApi('POST', '/WhatsApp/list-templates');
  }

  /**
   * GET /Campaigns/links
   * Returns link id, name, url
   */
  async getCampaignLinks() {
    return this.callDataApi('GET', '/Campaigns/links');
  }

  /**
   * POST /Webhooks/list
   * Returns webhook urls + configured events
   */
  async listWebhooks() {
    return this.callDataApi('POST', '/Webhooks/list');
  }

  /**
   * Fetch all data (templates, campaign links, webhooks)
   * Returns a consolidated object with all data
   */
  async getAllData() {
    try {
      const [templates, campaigns, webhooks] = await Promise.all([
        this.getApprovedTemplates(),
        this.getCampaignLinks(),
        this.listWebhooks(),
      ]);

      return {
        success: true,
        templates: templates.data || [],
        campaigns: campaigns.data || [],
        webhooks: webhooks.data || [],
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Error fetching all data:', error.message);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Get templates by status
   */
  async getTemplatesByStatus(status = 'APPROVED') {
    try {
      const result = await this.getApprovedTemplates();
      if (!result.data) return [];
      return result.data.filter(
        (t) => t.status && t.status.toUpperCase() === status.toUpperCase()
      );
    } catch (error) {
      console.error(`Error getting templates by status ${status}:`, error.message);
      return [];
    }
  }

  /**
   * Find template by ID
   */
  async findTemplateById(templateId) {
    try {
      const result = await this.getApprovedTemplates();
      if (!result.data) return null;
      return result.data.find((t) => t.template_id === templateId);
    } catch (error) {
      console.error(`Error finding template ${templateId}:`, error.message);
      return null;
    }
  }

  /**
   * Find template by name
   */
  async findTemplateByName(templateName) {
    try {
      const result = await this.getApprovedTemplates();
      if (!result.data) return null;
      return result.data.find(
        (t) =>
          t.template_name &&
          t.template_name.toLowerCase() === templateName.toLowerCase()
      );
    } catch (error) {
      console.error(`Error finding template ${templateName}:`, error.message);
      return null;
    }
  }

  /**
   * Find campaign link by name
   */
  async findCampaignLinkByName(linkName) {
    try {
      const result = await this.getCampaignLinks();
      if (!result.data) return null;
      return result.data.find(
        (l) => l.link_name && l.link_name.toLowerCase() === linkName.toLowerCase()
      );
    } catch (error) {
      console.error(`Error finding campaign link ${linkName}:`, error.message);
      return null;
    }
  }

  /**
   * Validate webhook is configured
   */
  async isWebhookConfigured(webhookUrl) {
    try {
      const result = await this.listWebhooks();
      if (!result.data) return false;
      return result.data.some((w) => w.webhook_url === webhookUrl);
    } catch (error) {
      console.error(`Error checking webhook:`, error.message);
      return false;
    }
  }
}

export default AnantaDataClient;
