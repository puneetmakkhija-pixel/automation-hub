import axios from 'axios';

class AnantaClient {
  constructor() {
    this.baseURL = process.env.ANANTA_BASE_URL;
    this.apiKey = process.env.ANANTA_API_KEY;
    this.apiToken = process.env.ANANTA_API_TOKEN;
    this.secretKey = process.env.ANANTA_API_SECRET_KEY;

    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        'Api-Key': this.apiKey,
        'Api-Token': this.apiToken,
        'Content-Type': 'application/json'
      }
    });
  }

  async sendMessage(phone, messageType, content) {
    try {
      const payload = {
        phone: phone.replace(/[^0-9]/g, ''),
        message_type: messageType,
        ...content
      };

      console.log(`[Ananta] Sending ${messageType} to ${phone}:`, payload);

      const response = await this.client.post('/messages/send', payload);

      console.log(`[Ananta] Message sent:`, response.data);
      return response.data;
    } catch (error) {
      console.error(`[Ananta] Error sending message:`, error.response?.data || error.message);
      throw error;
    }
  }

  async sendTextMessage(phone, text) {
    return this.sendMessage(phone, 'text', { text });
  }

  async sendInteractiveMessage(phone, text, buttons) {
    return this.sendMessage(phone, 'interactive', {
      text,
      buttons: buttons.map((btn, idx) => ({
        id: `btn_${idx}`,
        title: btn.title
      }))
    });
  }

  async sendTemplateMessage(phone, templateName, params) {
    return this.sendMessage(phone, 'template', {
      template_name: templateName,
      parameters: params
    });
  }

  async sendMediaMessage(phone, mediaUrl, caption) {
    return this.sendMessage(phone, 'media', {
      media_url: mediaUrl,
      caption
    });
  }

  async updateUserProfile(phone, profile) {
    try {
      const response = await this.client.put(`/customers/${phone}`, profile);
      return response.data;
    } catch (error) {
      console.error(`[Ananta] Error updating profile:`, error.response?.data);
      throw error;
    }
  }

  async getUserProfile(phone) {
    try {
      const response = await this.client.get(`/customers/${phone}`);
      return response.data;
    } catch (error) {
      console.error(`[Ananta] Error fetching profile:`, error.response?.data);
      throw error;
    }
  }
}

let instance = null;
try {
  instance = new AnantaClient();
} catch (error) {
  console.warn('⚠️ Ananta client initialization failed:', error.message);
  console.warn('   Messaging features will be unavailable until configuration is complete');
}

export default instance;
