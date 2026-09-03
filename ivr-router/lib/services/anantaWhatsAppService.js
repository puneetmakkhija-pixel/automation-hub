/**
 * Ananta WhatsApp Service
 * Handles sending WhatsApp messages via Ananta WhatsApp API
 */

import axios from 'axios';
import { aliasFor } from "../mobileAlias.js";

const ANANTA_API_ENDPOINT = process.env.ANANTA_API_ENDPOINT || 'https://api.ananta.io/v1/messages/send';
const ANANTA_API_KEY = process.env.ANANTA_API_KEY;
const ANANTA_PHONE_NUMBER = process.env.ANANTA_PHONE_NUMBER;

class AnantaWhatsAppService {
  /**
   * Send WhatsApp message via Ananta
   * @param {Object} options - Send options
   * @param {string} options.phone - Recipient phone number
   * @param {string} options.message - Message text with link
   * @param {string} options.campaignId - Campaign ID
   * @param {string} options.leadId - Lead ID
   * @returns {Promise<Object>} - Response from Ananta API
   */
  static async sendMessage({ phone, message, campaignId, leadId }) {
    try {
      // Replace variables in message
      const processedMessage = message
        .replace(/{phone}/g, phone)
        .replace(/{campaign_id}/g, campaignId)
        .replace(/{lead_id}/g, leadId);

      const payload = {
        phone_number: phone,
        message: processedMessage,
        campaign_id: campaignId,
        lead_id: leadId,
        timestamp: new Date().toISOString(),
      };

      console.log('📱 Sending WhatsApp via Ananta:', {
        phone: phone.slice(-4), // Log only last 4 digits
        campaign: campaignId,
        messageLength: processedMessage.length,
      });

      const response = await axios.post(ANANTA_API_ENDPOINT, payload, {
        headers: {
          'Authorization': `Bearer ${ANANTA_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      });

      return {
        success: true,
        messageId: response.data.message_id,
        status: response.data.status,
        timestamp: new Date(),
      };
    } catch (error) {
      console.error('❌ Ananta WhatsApp error:', error.message);
      return {
        success: false,
        error: error.message,
        timestamp: new Date(),
      };
    }
  }

  /**
   * Send bulk WhatsApp messages to multiple leads
   * @param {Array} leads - Array of lead objects {phone, name, campaignId}
   * @param {string} messageTemplate - Message template with variables
   * @returns {Promise<Array>} - Array of results
   */
  static async sendBulkMessages(leads, messageTemplate) {
    const results = [];

    for (const lead of leads) {
      const message = messageTemplate
        .replace(/{name}/g, lead.name || 'User')
        .replace(/{phone}/g, lead.phone)
        .replace(/{campaign_id}/g, lead.campaignId);

      const result = await this.sendMessage({
        phone: lead.phone,
        message,
        campaignId: lead.campaignId,
        leadId: lead.id,
      });

      results.push({
        phone: lead.phone,
        ...result,
      });

      // Rate limiting - wait 100ms between sends
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return results;
  }

  /**
   * Get WhatsApp message delivery status
   * @param {string} messageId - Message ID from Ananta
   * @returns {Promise<Object>} - Delivery status
   */
  static async getMessageStatus(messageId) {
    try {
      const response = await axios.get(
        `${ANANTA_API_ENDPOINT.replace('/send', '')}/status/${messageId}`,
        {
          headers: {
            'Authorization': `Bearer ${ANANTA_API_KEY}`,
          },
        }
      );

      return {
        messageId,
        status: response.data.status, // 'sent', 'delivered', 'read', 'failed'
        timestamp: response.data.timestamp,
      };
    } catch (error) {
      console.error('❌ Error getting message status:', error.message);
      return {
        messageId,
        status: 'unknown',
        error: error.message,
      };
    }
  }

  /**
   * Format FlexiLoans message with link
   * @param {Object} lead - Lead object
   * @param {string} campaignId - Campaign ID
   * @returns {string} - Formatted message
   */
  static formatFlexiLoansMessage(lead, campaignId) {
    // sub_id1 travels through whistleloop, a publisher account and every
    // redirect in between, and lands in all of their logs permanently. The raw
    // mobile used to be interpolated here; it is PII and it does not go in.
    // aliasFor() is the same reversible transform the live Poonawalla sends
    // use, so recon against the lender MIS still works by lookup or formula.
    const alias = aliasFor(lead.phone);
    // Refusing beats sending. On 01 Sep 5,707 Poonawalla messages went out with
    // an empty alias in sub_id1 and every one of them came back from the lender
    // looking identical — the whole batch is unattributable to a person, and
    // nothing downstream can repair it. A message that cannot be reconciled is
    // worse than a message not sent, so this is a hard stop, not a warning.
    if (!alias) {
      throw new Error(
        `formatFlexiLoansMessage: no alias for ${String(lead.phone ?? "").length} -digit phone; ` +
          "refusing to send a link that cannot be reconciled",
      );
    }
    const flexiLoansLink = `https://s1.whistleloop.com/?linkid=1710&offerid=178&publisher_id=259&parentid=259&pub_name=BuddyAdsIndia&sub_id1=alias_${alias}&loop_id=${campaignId}`;

    return `Hi ${lead.name || 'User'} 🎉

We have a personalized loan offer for you with FlexiLoans!

📋 Complete your document verification here:
${flexiLoansLink}

✅ Quick & Secure
✅ Up to ₹50L
✅ Instant Approval

Click above to get started!`;
  }
}

export default AnantaWhatsAppService;
