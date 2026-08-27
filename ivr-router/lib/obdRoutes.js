/**
 * OBD API Routes
 * REST endpoints for managing IVR campaigns via OBD API
 */

import express from 'express';
import OBDApiClient from './obdApiClient.js';
import * as templates from './campaignTemplates.js';

export function createObdRoutes(obdClient) {
  const router = express.Router();

  // Guard: Check if OBD client is available
  router.use((req, res, next) => {
    if (!obdClient) {
      return res.status(503).json({
        success: false,
        error: 'OBD API Client not initialized - configuration required',
      });
    }
    next();
  });

  // ==================== Authentication ====================
  router.post('/auth/login', async (req, res) => {
    try {
      const result = await obdClient.login();
      res.json({
        success: true,
        message: 'Login successful',
        data: {
          userId: result.userid,
          role: result.role,
        },
      });
    } catch (error) {
      res.status(401).json({
        success: false,
        error: error.message,
      });
    }
  });

  // ==================== Voice Management ====================
  router.post('/voices/upload', async (req, res) => {
    try {
      const { fileName, promptCategory, fileType = 'wav' } = req.body;

      if (!req.files || !req.files.waveFile) {
        return res.status(400).json({
          success: false,
          error: 'Wave file is required',
        });
      }

      const result = await obdClient.uploadVoiceFile(
        req.files.waveFile.data,
        fileName,
        promptCategory,
        fileType
      );

      res.json({
        success: true,
        message: 'Voice file uploaded successfully',
        data: result,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  router.get('/voices', async (req, res) => {
    try {
      const voices = await obdClient.getVoiceFiles();
      res.json({
        success: true,
        data: voices,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  // ==================== Base Files ====================
  router.post('/bases/upload', async (req, res) => {
    try {
      const { baseName } = req.body;

      if (!req.files || !req.files.baseFile) {
        return res.status(400).json({
          success: false,
          error: 'Base file is required',
        });
      }

      const result = await obdClient.uploadBaseFile(
        req.files.baseFile.data,
        baseName
      );

      res.json({
        success: true,
        message: 'Base file uploaded successfully',
        data: result,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  // ==================== Campaigns ====================
  router.post('/campaigns/simple-ivr', async (req, res) => {
    try {
      const campaignConfig = templates.createSimpleIvrCampaign(req.body);
      const result = await obdClient.composeCampaign(campaignConfig);

      res.json({
        success: true,
        message: 'Simple IVR campaign created successfully',
        data: result,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  router.post('/campaigns/dtmf', async (req, res) => {
    try {
      const campaignConfig = templates.createDtmfCampaign(req.body);
      const result = await obdClient.composeCampaign(campaignConfig);

      res.json({
        success: true,
        message: 'DTMF campaign created successfully',
        data: result,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  router.post('/campaigns/call-patch', async (req, res) => {
    try {
      const campaignConfig = templates.createCallPatchCampaign(req.body);
      const result = await obdClient.composeCampaign(campaignConfig);

      res.json({
        success: true,
        message: 'Call Patch campaign created successfully',
        data: result,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  router.post('/campaigns/:campaignId/pause', async (req, res) => {
    try {
      const { campaignId } = req.params;
      const result = await obdClient.pauseCampaign(campaignId);

      res.json({
        success: true,
        message: 'Campaign paused successfully',
        data: result,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  router.post('/campaigns/:campaignId/resume', async (req, res) => {
    try {
      const { campaignId } = req.params;
      const result = await obdClient.resumeCampaign(campaignId);

      res.json({
        success: true,
        message: 'Campaign resumed successfully',
        data: result,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  router.post('/campaigns/:campaignId/stop', async (req, res) => {
    try {
      const { campaignId } = req.params;
      const result = await obdClient.stopCampaign(campaignId);

      res.json({
        success: true,
        message: 'Campaign stopped successfully',
        data: result,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  router.post('/campaigns/analyze', async (req, res) => {
    try {
      const { startDate, endDate, campaignName, campaignType, username } = req.body;
      const result = await obdClient.analyzeCampaign(
        startDate,
        endDate,
        campaignName,
        campaignType,
        username
      );

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  // ==================== Webhooks ====================
  router.post('/webhooks', async (req, res) => {
    try {
      const { webhookName, url, event } = req.body;
      const result = await obdClient.addWebhook(webhookName, url, event);

      res.json({
        success: true,
        message: 'Webhook created successfully',
        data: result,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  router.get('/webhooks', async (req, res) => {
    try {
      const webhooks = await obdClient.getWebhooks();
      res.json({
        success: true,
        data: webhooks,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  router.put('/webhooks/:webhookId', async (req, res) => {
    try {
      const { webhookId } = req.params;
      const { webhookName, url, event } = req.body;
      const result = await obdClient.editWebhook(webhookId, webhookName, url, event);

      res.json({
        success: true,
        message: 'Webhook updated successfully',
        data: result,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  router.delete('/webhooks/:webhookId', async (req, res) => {
    try {
      const { webhookId } = req.params;
      const result = await obdClient.deleteWebhook(webhookId);

      res.json({
        success: true,
        message: 'Webhook deleted successfully',
        data: result,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  // ==================== SMS Webhooks ====================
  router.post('/sms-webhooks', async (req, res) => {
    try {
      const { webhookName, url, requestType, smsText, payload } = req.body;
      const result = await obdClient.addSmsWebhook(
        webhookName,
        url,
        requestType,
        smsText,
        payload
      );

      res.json({
        success: true,
        message: 'SMS webhook created successfully',
        data: result,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  router.get('/sms-webhooks', async (req, res) => {
    try {
      const webhooks = await obdClient.getSmsWebhooks();
      res.json({
        success: true,
        data: webhooks,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  router.get('/sms-webhooks/:webhookId', async (req, res) => {
    try {
      const { webhookId } = req.params;
      const webhook = await obdClient.getSmsWebhook(webhookId);
      res.json({
        success: true,
        data: webhook,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  router.put('/sms-webhooks/:webhookId', async (req, res) => {
    try {
      const { webhookId } = req.params;
      const { webhookName, url, requestType, smsText, payload } = req.body;
      const result = await obdClient.editSmsWebhook(
        webhookId,
        webhookName,
        url,
        requestType,
        smsText,
        payload
      );

      res.json({
        success: true,
        message: 'SMS webhook updated successfully',
        data: result,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  // ==================== Reports ====================
  router.post('/reports/:campaignId/generate', async (req, res) => {
    try {
      const { campaignId } = req.params;
      const { reportType = 'full' } = req.body;
      const result = await obdClient.generateReport(campaignId, reportType);

      res.json({
        success: true,
        message: 'Report generation started',
        data: result,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  router.get('/reports/download', async (req, res) => {
    try {
      const reports = await obdClient.downloadReport();
      res.json({
        success: true,
        data: reports,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  // ==================== Agent Groups ====================
  router.post('/agent-groups', async (req, res) => {
    try {
      const { groupName, agents } = req.body;
      const result = await obdClient.addAgentGroup(groupName, agents);

      res.json({
        success: true,
        message: 'Agent group created successfully',
        data: result,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  router.get('/agent-groups', async (req, res) => {
    try {
      const groups = await obdClient.getAgentGroups();
      res.json({
        success: true,
        data: groups,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  router.get('/agent-groups/:groupId', async (req, res) => {
    try {
      const { groupId } = req.params;
      const group = await obdClient.getAgentGroup(groupId);
      res.json({
        success: true,
        data: group,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  router.put('/agent-groups/:groupId', async (req, res) => {
    try {
      const { groupId } = req.params;
      const { groupName, agents } = req.body;
      const result = await obdClient.editAgentGroup(groupId, groupName, agents);

      res.json({
        success: true,
        message: 'Agent group updated successfully',
        data: result,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  router.delete('/agent-groups/:groupId', async (req, res) => {
    try {
      const { groupId } = req.params;
      const result = await obdClient.deleteAgentGroup(groupId);

      res.json({
        success: true,
        message: 'Agent group deleted successfully',
        data: result,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  return router;
}

export default createObdRoutes;
