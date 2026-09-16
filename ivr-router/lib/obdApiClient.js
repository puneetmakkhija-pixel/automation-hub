/**
 * OBD API Client
 * Handles all interactions with the OBD IVR SMS API
 */

/**
 * A prompt name the dialler will accept: digits, letters, minus, underscore.
 *
 * Exported because the rule belongs to OBD rather than to any one caller, and a
 * rule worth enforcing is worth being able to test on its own.
 */
export function obdSafeFileName(fileName) {
  const stripped = String(fileName ?? '').replace(/\.[A-Za-z0-9]{1,5}$/, '');
  const safe = stripped.replace(/[^A-Za-z0-9_-]/g, '_');
  // Not merely non-empty: "...." sanitises to "____", which OBD would accept
  // and no human could ever find again in the prompt list. A name has to carry
  // at least one character the caller actually chose.
  if (!/[A-Za-z0-9]/.test(safe)) {
    // Better than letting the dialler answer with the same vague 400 that cost
    // a campaign run to read.
    throw new Error(`Voice upload needs a file name; got ${JSON.stringify(fileName)}`);
  }
  return safe;
}

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

    // A Blob, not a raw Buffer.
    //
    // FormData.append() only keeps bytes for Blob-like values. Anything else —
    // a Buffer included — is coerced with String(), so the dialler received the
    // literal text "[object Object]" or a mangled byte string instead of audio.
    // Wrapping here fixes every caller at once rather than each one separately.
    const mime = fileType === 'mp3' ? 'audio/mpeg' : 'audio/wav';
    const blob =
      typeof Blob !== 'undefined' && waveFile instanceof Blob
        ? waveFile
        : new Blob([waveFile], { type: mime });

    // The dialler refuses a dot:
    //
    //   HTTP 400 {"message":"File Name only accepts digits, alphabets,minus
    //             and underscore."}
    //
    // which is what "FLEXI_BL_20260916.mp3" hit. The extension is not
    // information the dialler needs in the NAME — fileType carries it, and so
    // does the Blob's mime type — so it is stripped rather than escaped, and
    // anything else outside the allowed set becomes an underscore.
    //
    // Sanitised here rather than at the call site so every caller is fixed at
    // once, the same reason the Blob wrapping lives here.
    const safeName = obdSafeFileName(fileName);

    const formData = new FormData();
    formData.append('waveFile', blob, safeName);
    formData.append('userId', this.userId);
    formData.append('fileName', safeName);
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
        // statusText is EMPTY over HTTP/2, so the old message was literally
        // "Voice upload failed: " and threw away both the status code and the
        // body. An error that names nothing costs an hour of guessing; this one
        // names the status and whatever the dialler said.
        const detail = await response.text().catch(() => '');
        throw new Error(
          `Voice upload failed: HTTP ${response.status}` +
            (detail ? ` — ${detail.slice(0, 300)}` : '')
        );
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

  /**
   * Change some fields of a webhook, and leave the rest exactly as they were.
   *
   * This used to send only { id, webhookName, url, event }. A webhook also
   * carries headerJson and bodyJson, and those are the load-bearing parts:
   * bodyJson names which fields the panel posts to us (mobile, dtmf, unique_id
   * and the rest), and headerJson carries the shared secret our /webhooks/ivr
   * routes check. Editing a URL through this method risked clearing both, which
   * would turn a live campaign into 401s or into presses with no mobile in them
   * — and nothing would have said so.
   *
   * So: read the webhook first, merge the caller's changes over it, and send
   * the whole thing back. An edit of one field is then an edit of one field.
   *
   * `changes` is an object rather than positional arguments, so that omitting a
   * field means "leave it alone" instead of "set it to undefined". The old
   * positional form is still accepted; see the shim below.
   */
  async editWebhook(id, changes = {}) {
    await this.ensureToken();

    const patch =
      typeof changes === 'string' || arguments.length > 2
        ? { webhookName: arguments[1], url: arguments[2], event: arguments[3] }
        : changes;

    const wanted = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined && v !== null)
    );
    if (!Object.keys(wanted).length) {
      throw new Error(`Edit webhook ${id}: nothing to change`);
    }

    // Read before write. Blind-writing an id that is not there would create or
    // corrupt something we never looked at.
    const before = await this.findWebhook(id);
    if (!before) {
      throw new Error(`Edit webhook ${id}: no such webhook on this account`);
    }

    const merged = { ...before, ...wanted, id: before.id, userId: this.userId };

    try {
      const response = await fetch(`${this.baseUrl}/api/obd/webhooks/edit`, {
        method: 'POST',
        headers: this.getAuthHeader(),
        body: JSON.stringify(merged),
      });

      if (!response.ok) {
        throw new Error(`Edit webhook failed: ${response.statusText}`);
      }

      const result = await response.json();

      // The provider is not ours and its edit contract is not documented, so
      // confirm rather than assume. If the two fields that can silently break a
      // campaign came back empty, say so loudly AND hand back what they were,
      // so whoever is reading can put them straight back.
      const after = await this.findWebhook(id);
      for (const field of ['headerJson', 'bodyJson']) {
        if (before[field] && !(after && after[field])) {
          throw new Error(
            `Edit webhook ${id} DROPPED ${field}. The panel no longer has it and ` +
              `presses may now fail. Restore it to:\n${before[field]}`
          );
        }
      }

      return result;
    } catch (error) {
      console.error('Edit Webhook Error:', error);
      throw error;
    }
  }

  /** One webhook by id, or null. Tolerates a bare array or a {data:[...]} wrapper. */
  async findWebhook(id) {
    const raw = await this.getWebhooks();
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [];
    return list.find((w) => String(w?.id) === String(id)) ?? null;
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
