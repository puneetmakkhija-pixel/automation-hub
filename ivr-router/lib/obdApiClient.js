/**
 * OBD API Client
 * Handles all interactions with the OBD IVR SMS API
 */

class OBDApiClient {
  constructor(baseUrl, username, password) {
    this.baseUrl = baseUrl;
    this.username = username;
    this.password = password;
    this.token = null;
    this.tokenExpiry = null;
  }

  async login() {
    try {
      const response = await fetch(`${this.baseUrl}/api/obd/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: this.username,
          password: this.password,
        }),
      });

      if (!response.ok) {
        throw new Error(`Login failed: ${response.statusText}`);
      }

      const data = await response.json();
      this.token = data.token;
      this.userId = data.userid;
      this.tokenExpiry = Date.now() + 3600000; // 1 hour
      return data;
    } catch (error) {
      console.error('OBD Login Error:', error);
      throw error;
    }
  }

  async ensureToken() {
    if (!this.token || Date.now() > this.tokenExpiry) {
      await this.login();
    }
  }

  getAuthHeader() {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  // Voice Management APIs
  async uploadVoiceFile(waveFile, fileName, promptCategory, fileType = 'wav') {
    await this.ensureToken();

    const formData = new FormData();
    formData.append('waveFile', waveFile);
    formData.append('userId', this.userId);
    formData.append('fileName', fileName);
    formData.append('promptCategory', promptCategory);
    formData.append('fileType', fileType);

    try {
      const response = await fetch(`${this.baseUrl}/api/obd/promptupload`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
        },
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Voice upload failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Voice Upload Error:', error);
      throw error;
    }
  }

  async getVoiceFiles() {
    await this.ensureToken();

    try {
      const response = await fetch(`${this.baseUrl}/api/obd/prompts/${this.userId}`, {
        method: 'GET',
        headers: this.getAuthHeader(),
      });

      if (!response.ok) {
        throw new Error(`Get voice files failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Get Voice Files Error:', error);
      throw error;
    }
  }

  // Base File APIs
  async uploadBaseFile(baseFile, baseName) {
    await this.ensureToken();

    const formData = new FormData();
    formData.append('baseFile', baseFile);
    formData.append('userId', this.userId);
    formData.append('baseName', baseName);
    formData.append('contactList', null);

    try {
      const response = await fetch(`${this.baseUrl}/api/obd/baseupload`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
        },
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Base upload failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Base Upload Error:', error);
      throw error;
    }
  }

  // Campaign APIs
  async composeCampaign(campaignConfig) {
    await this.ensureToken();

    const payload = {
      userId: this.userId,
      ...campaignConfig,
    };

    try {
      const response = await fetch(`${this.baseUrl}/api/obd/campaign/compose`, {
        method: 'POST',
        headers: this.getAuthHeader(),
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Compose campaign failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Compose Campaign Error:', error);
      throw error;
    }
  }

  async pauseCampaign(campaignId) {
    await this.ensureToken();

    try {
      const response = await fetch(`${this.baseUrl}/api/obd/campaign/pause`, {
        method: 'POST',
        headers: this.getAuthHeader(),
        body: JSON.stringify({ campaignId }),
      });

      if (!response.ok) {
        throw new Error(`Pause campaign failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Pause Campaign Error:', error);
      throw error;
    }
  }

  async resumeCampaign(campaignId) {
    await this.ensureToken();

    try {
      const response = await fetch(`${this.baseUrl}/api/obd/campaign/resume`, {
        method: 'POST',
        headers: this.getAuthHeader(),
        body: JSON.stringify({ campaignId, userId: this.userId }),
      });

      if (!response.ok) {
        throw new Error(`Resume campaign failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Resume Campaign Error:', error);
      throw error;
    }
  }

  async stopCampaign(campaignId) {
    await this.ensureToken();

    try {
      const response = await fetch(`${this.baseUrl}/api/obd/campaign/stop`, {
        method: 'POST',
        headers: this.getAuthHeader(),
        body: JSON.stringify({ campaignId }),
      });

      if (!response.ok) {
        throw new Error(`Stop campaign failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Stop Campaign Error:', error);
      throw error;
    }
  }

  async analyzeCampaign(startDate, endDate, campaignName = 'All', campaignType = 'All', username = '') {
    await this.ensureToken();

    try {
      const response = await fetch(`${this.baseUrl}/api/obd/campaign/analysis`, {
        method: 'POST',
        headers: this.getAuthHeader(),
        body: JSON.stringify({
          userId: this.userId,
          startDate,
          endDate,
          campaignName,
          campaignType,
          username,
        }),
      });

      if (!response.ok) {
        throw new Error(`Campaign analysis failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Campaign Analysis Error:', error);
      throw error;
    }
  }

  // Webhook APIs
  async addWebhook(webhookName, url, event) {
    await this.ensureToken();

    try {
      const response = await fetch(`${this.baseUrl}/api/obd/addWebHooks`, {
        method: 'POST',
        headers: this.getAuthHeader(),
        body: JSON.stringify({
          webhookName,
          url,
          event,
          userId: this.userId,
        }),
      });

      if (!response.ok) {
        throw new Error(`Add webhook failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Add Webhook Error:', error);
      throw error;
    }
  }

  async getWebhooks() {
    await this.ensureToken();

    try {
      const response = await fetch(`${this.baseUrl}/api/obd/webhooks/${this.userId}`, {
        method: 'GET',
        headers: this.getAuthHeader(),
      });

      if (!response.ok) {
        throw new Error(`Get webhooks failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Get Webhooks Error:', error);
      throw error;
    }
  }

  async editWebhook(id, webhookName, url, event) {
    await this.ensureToken();

    try {
      const response = await fetch(`${this.baseUrl}/api/obd/webhooks/edit`, {
        method: 'POST',
        headers: this.getAuthHeader(),
        body: JSON.stringify({
          id,
          webhookName,
          url,
          event,
          userId: this.userId,
        }),
      });

      if (!response.ok) {
        throw new Error(`Edit webhook failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Edit Webhook Error:', error);
      throw error;
    }
  }

  async deleteWebhook(webhookId) {
    await this.ensureToken();

    try {
      const response = await fetch(`${this.baseUrl}/api/obd/webhooks/${webhookId}`, {
        method: 'GET',
        headers: this.getAuthHeader(),
      });

      if (!response.ok) {
        throw new Error(`Delete webhook failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Delete Webhook Error:', error);
      throw error;
    }
  }

  // Reports APIs
  async generateReport(campaignId, reportType = 'full') {
    await this.ensureToken();

    try {
      const response = await fetch(`${this.baseUrl}/api/obd/report/generate`, {
        method: 'POST',
        headers: this.getAuthHeader(),
        body: JSON.stringify({
          campaignId,
          reportType,
        }),
      });

      if (!response.ok) {
        throw new Error(`Generate report failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Generate Report Error:', error);
      throw error;
    }
  }

  async downloadReport() {
    await this.ensureToken();

    try {
      const response = await fetch(`${this.baseUrl}/api/obd/download/${this.userId}`, {
        method: 'GET',
        headers: this.getAuthHeader(),
      });

      if (!response.ok) {
        throw new Error(`Download report failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Download Report Error:', error);
      throw error;
    }
  }

  // Agent Group APIs
  async addAgentGroup(groupName, agents) {
    await this.ensureToken();

    try {
      const response = await fetch(`${this.baseUrl}/api/obd/add/group/agent`, {
        method: 'POST',
        headers: this.getAuthHeader(),
        body: JSON.stringify({
          userId: this.userId,
          groupName,
          agents,
        }),
      });

      if (!response.ok) {
        throw new Error(`Add agent group failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Add Agent Group Error:', error);
      throw error;
    }
  }

  async getAgentGroups() {
    await this.ensureToken();

    try {
      const response = await fetch(`${this.baseUrl}/api/obd/group/agent/list/${this.userId}`, {
        method: 'GET',
        headers: this.getAuthHeader(),
      });

      if (!response.ok) {
        throw new Error(`Get agent groups failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Get Agent Groups Error:', error);
      throw error;
    }
  }

  async getAgentGroup(groupId) {
    await this.ensureToken();

    try {
      const response = await fetch(`${this.baseUrl}/api/obd/group/agent/${groupId}`, {
        method: 'GET',
        headers: this.getAuthHeader(),
      });

      if (!response.ok) {
        throw new Error(`Get agent group failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Get Agent Group Error:', error);
      throw error;
    }
  }

  async editAgentGroup(groupId, groupName, agents) {
    await this.ensureToken();

    try {
      const response = await fetch(`${this.baseUrl}/api/obd/edit/group/agent`, {
        method: 'POST',
        headers: this.getAuthHeader(),
        body: JSON.stringify({
          userId: this.userId,
          groupId,
          groupName,
          agents,
        }),
      });

      if (!response.ok) {
        throw new Error(`Edit agent group failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Edit Agent Group Error:', error);
      throw error;
    }
  }

  async deleteAgentGroup(groupId) {
    await this.ensureToken();

    try {
      const response = await fetch(`${this.baseUrl}/api/obd/group/agent/${groupId}`, {
        method: 'DELETE',
        headers: this.getAuthHeader(),
      });

      if (!response.ok) {
        throw new Error(`Delete agent group failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Delete Agent Group Error:', error);
      throw error;
    }
  }

  // SMS Webhook APIs
  async addSmsWebhook(webhookName, url, requestType, smsText, payload) {
    await this.ensureToken();

    try {
      const response = await fetch(`${this.baseUrl}/api/obd/add/sms/webhooks`, {
        method: 'POST',
        headers: this.getAuthHeader(),
        body: JSON.stringify({
          webhookName,
          url,
          userId: this.userId,
          requestType,
          smsText,
          payload,
        }),
      });

      if (!response.ok) {
        throw new Error(`Add SMS webhook failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Add SMS Webhook Error:', error);
      throw error;
    }
  }

  async getSmsWebhooks() {
    await this.ensureToken();

    try {
      const response = await fetch(`${this.baseUrl}/api/obd/sms/webhooks/${this.userId}`, {
        method: 'GET',
        headers: this.getAuthHeader(),
      });

      if (!response.ok) {
        throw new Error(`Get SMS webhooks failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Get SMS Webhooks Error:', error);
      throw error;
    }
  }

  async getSmsWebhook(webhookId) {
    await this.ensureToken();

    try {
      const response = await fetch(`${this.baseUrl}/api/obd/getSMS/webhook/${webhookId}`, {
        method: 'GET',
        headers: this.getAuthHeader(),
      });

      if (!response.ok) {
        throw new Error(`Get SMS webhook failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Get SMS Webhook Error:', error);
      throw error;
    }
  }

  async editSmsWebhook(id, webhookName, url, requestType, smsText, payload) {
    await this.ensureToken();

    try {
      const response = await fetch(`${this.baseUrl}/api/obd/sms/webhooks/edit`, {
        method: 'POST',
        headers: this.getAuthHeader(),
        body: JSON.stringify({
          id,
          webhookName,
          url,
          userId: this.userId,
          requestType,
          smsText,
          payload,
        }),
      });

      if (!response.ok) {
        throw new Error(`Edit SMS webhook failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Edit SMS Webhook Error:', error);
      throw error;
    }
  }
}

export default OBDApiClient;
