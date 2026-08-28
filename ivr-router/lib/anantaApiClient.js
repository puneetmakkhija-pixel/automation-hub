/**
 * Ananta API Client
 * WhatsApp and customer data management integration
 * Handles:
 * - WhatsApp message sending via A2P API
 * - Customer data (demographics) management
 * - Delivery tracking and webhooks
 * - Campaign targeting by demographics
 */

import axios from 'axios';

class AnantaApiClient {
  constructor(baseUrl, apiToken, apiSecKey) {
    this.baseUrl = baseUrl || 'https://data-api.anantadot.com';
    this.apiToken = apiToken;
    this.apiSecKey = apiSecKey;
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
    });
  }

  // ==================== Customer Data Management ====================

  /**
   * Add or update customer demographic data
   * Required: mobile number (10 digits, starts with 6-9)
   * Optional: state, city, pincode, age, dob, gender, marital_status, custom fields
   */
  async sendCustomerData(customers) {
    try {
      const payload = {
        api_token: this.apiToken,
        api_sec_key: this.apiSecKey,
        data: customers.map(customer => ({
          mobile: customer.mobile,
          state: customer.state || null,
          city: customer.city || null,
          pincode: customer.pincode || null,
          age: customer.age || null,
          dob: customer.dob || null, // YYYY-MM-DD format
          gender: customer.gender || null, // 1=Male, 2=Female, 3=Others, 4=Prefer not to say
          marital_status: customer.marital_status || null, // 1=Married, 2=Single, 3=Divorced, 4=Widowed, 5=Others
          custom: customer.custom || {},
        })),
      };

      const response = await this.client.post('/Data/verify_user', payload);

      if (response.status === 200 || response.status === 204) {
        return {
          success: true,
          uploaded: customers.length,
          dataIds: response.data.my_data_id ? [response.data.my_data_id] : [],
          message: 'Customer data synchronized successfully',
        };
      }

      throw new Error(`Unexpected status: ${response.status}`);
    } catch (error) {
      console.error('Customer data upload error:', error.message);
      return {
        success: false,
        error: error.message,
        uploaded: 0,
      };
    }
  }

  /**
   * Send WhatsApp message via Ananta
   */
  async sendWhatsAppMessage(phoneNumber, templateId, messageText = '') {
    try {
      const payload = {
        api_token: this.apiToken,
        api_sec_key: this.apiSecKey,
        mobile: phoneNumber,
        template_id: templateId,
        message: messageText,
      };

      const response = await this.client.post('/WhatsApp/send', payload);

      return {
        success: response.status === 200,
        messageId: response.data.message_id,
        status: response.data.status,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('WhatsApp send error:', error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  // ==================== Campaign Targeting ====================

  /**
   * Get customers by demographic criteria for targeting
   * Filters: state, city, age_range, gender, marital_status
   */
  async getCustomersByDemographics(criteria) {
    try {
      const payload = {
        api_token: this.apiToken,
        api_sec_key: this.apiSecKey,
        filters: {
          state: criteria.state || null,
          city: criteria.city || null,
          age_min: criteria.ageMin || null,
          age_max: criteria.ageMax || null,
          gender: criteria.gender || null,
          marital_status: criteria.maritalStatus || null,
          custom: criteria.custom || {},
        },
      };

      const response = await this.client.post('/Customers/search', payload);

      return {
        success: true,
        count: response.data.count || 0,
        customers: response.data.customers || [],
        criteria,
      };
    } catch (error) {
      console.error('Customer search error:', error.message);
      return {
        success: false,
        error: error.message,
        count: 0,
        customers: [],
      };
    }
  }

  /**
   * Get customer data by phone number
   */
  async getCustomer(phoneNumber) {
    try {
      const response = await this.client.get(`/Customers/${phoneNumber}`, {
        params: {
          api_token: this.apiToken,
          api_sec_key: this.apiSecKey,
        },
      });

      return {
        success: true,
        customer: response.data,
        phoneNumber,
      };
    } catch (error) {
      console.error('Get customer error:', error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  // ==================== Delivery Tracking ====================

  /**
   * Parse WhatsApp delivery webhook
   * Called when Ananta sends webhook events for message delivery
   */
  parseDeliveryWebhook(webhookPayload) {
    const {
      account_number,
      phone,
      status, // 'delivered', 'read', 'sent', 'failed'
      msgid,
      date,
      template,
      campaign_date,
    } = webhookPayload;

    return {
      accountNumber: account_number,
      phoneNumber: phone,
      deliveryStatus: status,
      messageId: msgid,
      deliveredAt: date,
      template: template,
      campaignDate: campaign_date,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get delivery stats for a campaign
   */
  async getDeliveryStats(campaignId, startDate, endDate) {
    try {
      const response = await this.client.get('/Reports/delivery-stats', {
        params: {
          api_token: this.apiToken,
          api_sec_key: this.apiSecKey,
          campaign_id: campaignId,
          start_date: startDate,
          end_date: endDate,
        },
      });

      return {
        success: true,
        campaignId,
        stats: {
          sent: response.data.sent || 0,
          delivered: response.data.delivered || 0,
          read: response.data.read || 0,
          clicked: response.data.clicked || 0,
          failed: response.data.failed || 0,
          deliveryRate: this.calculateRate(
            response.data.delivered,
            response.data.sent
          ),
          readRate: this.calculateRate(response.data.read, response.data.delivered),
          clickRate: this.calculateRate(
            response.data.clicked,
            response.data.delivered
          ),
        },
        period: { startDate, endDate },
      };
    } catch (error) {
      console.error('Delivery stats error:', error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  // ==================== Campaign Segmentation ====================

  /**
   * Create targeted campaign segment based on demographics
   */
  createDemographicSegment(name, criteria) {
    return {
      segmentName: name,
      criteria: {
        states: criteria.states || [],
        cities: criteria.cities || [],
        ageRange: {
          min: criteria.ageMin || 0,
          max: criteria.ageMax || 100,
        },
        genders: criteria.genders || [1, 2, 3, 4], // All genders
        maritalStatuses: criteria.maritalStatuses || [1, 2, 3, 4, 5],
        customAttributes: criteria.customAttributes || {},
      },
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Segment customers by age groups
   */
  segmentByAge(customers) {
    return {
      '13-20': customers.filter(c => c.age >= 13 && c.age <= 20),
      '21-30': customers.filter(c => c.age >= 21 && c.age <= 30),
      '31-40': customers.filter(c => c.age >= 31 && c.age <= 40),
      '41-50': customers.filter(c => c.age >= 41 && c.age <= 50),
      '51+': customers.filter(c => c.age >= 51),
    };
  }

  /**
   * Segment customers by state
   */
  segmentByState(customers) {
    const segments = {};
    customers.forEach(customer => {
      const state = customer.state || 'Unknown';
      if (!segments[state]) segments[state] = [];
      segments[state].push(customer);
    });
    return segments;
  }

  /**
   * Segment customers by gender
   */
  segmentByGender(customers) {
    return {
      male: customers.filter(c => c.gender === 1),
      female: customers.filter(c => c.gender === 2),
      others: customers.filter(c => c.gender === 3),
      preferNotToSay: customers.filter(c => c.gender === 4),
    };
  }

  // ==================== Bulk Operations ====================

  /**
   * Bulk send WhatsApp messages to segment
   */
  async bulkSendWhatsApp(segment, templateId, messageText = '') {
    const results = {
      successful: 0,
      failed: 0,
      messages: [],
    };

    for (const customer of segment) {
      try {
        const result = await this.sendWhatsAppMessage(
          customer.mobile,
          templateId,
          messageText
        );

        if (result.success) {
          results.successful++;
          results.messages.push({
            phoneNumber: customer.mobile,
            messageId: result.messageId,
            status: 'sent',
          });
        } else {
          results.failed++;
          results.messages.push({
            phoneNumber: customer.mobile,
            status: 'failed',
            error: result.error,
          });
        }
      } catch (error) {
        results.failed++;
        results.messages.push({
          phoneNumber: customer.mobile,
          status: 'error',
          error: error.message,
        });
      }

      // Rate limiting: 1 second between requests
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return results;
  }

  /**
   * Bulk sync customer data
   */
  async bulkSyncCustomers(customers, batchSize = 100) {
    const results = {
      successful: 0,
      failed: 0,
      batches: [],
    };

    for (let i = 0; i < customers.length; i += batchSize) {
      const batch = customers.slice(i, i + batchSize);

      try {
        const result = await this.sendCustomerData(batch);

        if (result.success) {
          results.successful += result.uploaded;
          results.batches.push({
            batchNumber: Math.floor(i / batchSize) + 1,
            count: batch.length,
            status: 'success',
          });
        } else {
          results.failed += batch.length;
          results.batches.push({
            batchNumber: Math.floor(i / batchSize) + 1,
            count: batch.length,
            status: 'failed',
            error: result.error,
          });
        }
      } catch (error) {
        results.failed += batch.length;
        results.batches.push({
          batchNumber: Math.floor(i / batchSize) + 1,
          count: batch.length,
          status: 'error',
          error: error.message,
        });
      }

      // Rate limiting between batches
      if (i + batchSize < customers.length) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    return results;
  }

  // ==================== Utility Functions ====================

  calculateRate(numerator, denominator) {
    if (!denominator || denominator === 0) return 0;
    return ((numerator / denominator) * 100).toFixed(2) + '%';
  }

  validatePhoneNumber(phoneNumber) {
    // Indian format: 10 digits starting with 6-9
    const cleaned = phoneNumber.replace(/\D/g, '');
    const isValid = cleaned.length === 10 && /^[6-9]/.test(cleaned);

    return {
      valid: isValid,
      cleaned,
      error: !isValid ? 'Phone must be 10 digits starting with 6-9' : null,
    };
  }

  validateAge(age) {
    const ageNum = parseInt(age);
    return ageNum >= 1 && ageNum <= 120;
  }

  validateGender(gender) {
    // 1=Male, 2=Female, 3=Others, 4=Prefer not to say
    return [1, 2, 3, 4].includes(parseInt(gender));
  }

  validateMaritalStatus(status) {
    // 1=Married, 2=Single, 3=Divorced, 4=Widowed, 5=Others
    return [1, 2, 3, 4, 5].includes(parseInt(status));
  }
}

export default AnantaApiClient;
