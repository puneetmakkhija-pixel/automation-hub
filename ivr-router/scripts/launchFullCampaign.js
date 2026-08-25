#!/usr/bin/env node

/**
 * Full Campaign Launcher
 * Completely automates end-to-end campaign execution:
 * - Upload contact lists (base files)
 * - Upload voice prompts
 * - Create/configure agent groups
 * - Setup webhooks
 * - Create campaigns
 * - Schedule and monitor
 */

import OBDApiClient from '../lib/obdApiClient.js';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const obdClient = new OBDApiClient(
  process.env.OBD_BASE_URL || 'https://obdapi2.ivrsms.com',
  process.env.OBD_USERNAME,
  process.env.OBD_PASSWORD
);

// ==================== Campaign Configuration ====================

class CampaignLauncher {
  constructor() {
    this.uploadedBaseId = null;
    this.uploadedPrompts = {};
    this.createdAgentGroups = {};
    this.campaignId = null;
  }

  // ==================== Phase 1: Upload Contact Lists ====================

  async uploadContactList(csvFilePath, baseName) {
    console.log('\n📋 PHASE 1: Uploading Contact List');
    console.log(`File: ${csvFilePath}`);

    try {
      if (!fs.existsSync(csvFilePath)) {
        throw new Error(`Contact list file not found: ${csvFilePath}`);
      }

      const fileContent = fs.readFileSync(csvFilePath);
      const result = await obdClient.uploadBaseFile(fileContent, baseName);

      this.uploadedBaseId = result.baseId;
      console.log(`✓ Contact list uploaded successfully`);
      console.log(`  Base ID: ${this.uploadedBaseId}`);
      console.log(`  Name: ${baseName}`);

      return this.uploadedBaseId;
    } catch (error) {
      console.error(`✗ Contact list upload failed: ${error.message}`);
      throw error;
    }
  }

  // ==================== Phase 2: Upload Voice Prompts ====================

  async uploadVoicePrompts(promptsConfig) {
    console.log('\n🎙️ PHASE 2: Uploading Voice Prompts');

    try {
      for (const [key, config] of Object.entries(promptsConfig)) {
        const { filePath, fileName, category } = config;

        if (!fs.existsSync(filePath)) {
          console.log(`⚠ Skipping ${key}: file not found (${filePath})`);
          continue;
        }

        const fileContent = fs.readFileSync(filePath);
        const result = await obdClient.uploadVoiceFile(
          fileContent,
          fileName,
          category,
          'wav'
        );

        this.uploadedPrompts[key] = result.promptId;
        console.log(`✓ Uploaded ${key} prompt`);
        console.log(`  Prompt ID: ${result.promptId}`);
        console.log(`  Category: ${category}`);
      }

      if (Object.keys(this.uploadedPrompts).length === 0) {
        console.log('⚠ No voice prompts uploaded. Using existing prompt IDs from config.');
      }

      return this.uploadedPrompts;
    } catch (error) {
      console.error(`✗ Voice prompt upload failed: ${error.message}`);
      throw error;
    }
  }

  // ==================== Phase 3: Create Agent Groups ====================

  async createAgentGroups(agentGroupsConfig) {
    console.log('\n👥 PHASE 3: Creating Agent Groups');

    try {
      for (const [key, config] of Object.entries(agentGroupsConfig)) {
        const { groupName, agents } = config;

        const result = await obdClient.addAgentGroup(groupName, agents);
        this.createdAgentGroups[key] = result.groupId;

        console.log(`✓ Created agent group: ${groupName}`);
        console.log(`  Group ID: ${result.groupId}`);
        console.log(`  Agents: ${agents.length}`);
        agents.forEach(agent => {
          console.log(`    - ${agent.agentName} (${agent.agentNumber})`);
        });
      }

      return this.createdAgentGroups;
    } catch (error) {
      console.error(`✗ Agent group creation failed: ${error.message}`);
      throw error;
    }
  }

  // ==================== Phase 4: Configure Webhooks ====================

  async setupWebhooks(webhookConfigs) {
    console.log('\n🔗 PHASE 4: Configuring Webhooks');

    try {
      const voiceWebhooks = webhookConfigs.voice || {};
      const smsWebhooks = webhookConfigs.sms || {};

      // Setup voice webhooks
      for (const [key, config] of Object.entries(voiceWebhooks)) {
        try {
          await obdClient.addWebhook(config.name, config.url, config.event);
          console.log(`✓ Created voice webhook: ${config.name}`);
          console.log(`  Event: ${config.event}`);
          console.log(`  URL: ${config.url}`);
        } catch (error) {
          console.log(`⚠ Voice webhook creation warning: ${error.message}`);
        }
      }

      // Setup SMS webhooks
      for (const [key, config] of Object.entries(smsWebhooks)) {
        try {
          await obdClient.addSmsWebhook(
            config.name,
            config.url,
            config.requestType,
            config.smsText || '',
            config.payload || '{}'
          );
          console.log(`✓ Created SMS webhook: ${config.name}`);
          console.log(`  Type: ${config.requestType}`);
          console.log(`  URL: ${config.url}`);
        } catch (error) {
          console.log(`⚠ SMS webhook creation warning: ${error.message}`);
        }
      }

      return true;
    } catch (error) {
      console.error(`✗ Webhook setup failed: ${error.message}`);
      throw error;
    }
  }

  // ==================== Phase 5: Create Campaign ====================

  async createCampaign(campaignConfig) {
    console.log('\n📢 PHASE 5: Creating Campaign');

    try {
      const config = {
        ...campaignConfig,
        baseId: this.uploadedBaseId || campaignConfig.baseId,
      };

      // Use uploaded prompt IDs if available, otherwise use existing ones
      if (this.uploadedPrompts.welcome) config.welcomePromptId = this.uploadedPrompts.welcome;
      if (this.uploadedPrompts.menu) config.menuPromptId = this.uploadedPrompts.menu;
      if (this.uploadedPrompts.thanks) config.thanksPromptId = this.uploadedPrompts.thanks;
      if (this.uploadedPrompts.noInput) config.noInputPromptId = this.uploadedPrompts.noInput;
      if (this.uploadedPrompts.wrongInput) config.wrongInputPromptId = this.uploadedPrompts.wrongInput;

      // Handle agent groups for Call Patch campaigns
      if (config.agentGroups) {
        config.agentGroups = config.agentGroups.map(group => ({
          ...group,
          groupId: this.createdAgentGroups[group.key] || group.groupId,
        }));
      }

      console.log(`Campaign Config:`);
      console.log(`  Name: ${config.campaignName}`);
      console.log(`  Type: ${config.campaignType || 'Simple IVR'}`);
      console.log(`  Base ID: ${config.baseId}`);
      console.log(`  Schedule: ${config.scheduleTime}`);

      let result;
      if (config.campaignType === 'call-patch' || config.agentGroups) {
        result = await obdClient.composeCampaign(this.buildCallPatchCampaign(config));
      } else if (config.campaignType === 'dtmf') {
        result = await obdClient.composeCampaign(this.buildDtmfCampaign(config));
      } else {
        result = await obdClient.composeCampaign(this.buildSimpleIvrCampaign(config));
      }

      this.campaignId = result.campaignId;
      console.log(`✓ Campaign created successfully`);
      console.log(`  Campaign ID: ${this.campaignId}`);
      console.log(`  Message: ${result.message}`);

      return this.campaignId;
    } catch (error) {
      console.error(`✗ Campaign creation failed: ${error.message}`);
      throw error;
    }
  }

  // ==================== Phase 6: Monitor Campaign ====================

  async monitorCampaign(durationSeconds = 60) {
    console.log('\n📊 PHASE 6: Monitoring Campaign');
    console.log(`Monitoring for ${durationSeconds} seconds...`);

    try {
      const startTime = Date.now();
      const interval = setInterval(async () => {
        try {
          const result = await obdClient.analyzeCampaign(
            new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            new Date().toISOString().split('T')[0],
            'All',
            'All',
            ''
          );

          if (result && Array.isArray(result)) {
            const campaign = result.find(c => c.campaignId === this.campaignId);
            if (campaign) {
              console.log(`\n📈 Campaign Stats:`);
              console.log(`  Status: ${campaign.status}`);
              console.log(`  Total Calls: ${campaign.totalCalls}`);
              console.log(`  Completed: ${campaign.completed}`);
              console.log(`  Failed: ${campaign.failed}`);
              console.log(`  Pending: ${campaign.pending}`);
            }
          }
        } catch (error) {
          console.log(`⚠ Monitoring error: ${error.message}`);
        }

        if (Date.now() - startTime > durationSeconds * 1000) {
          clearInterval(interval);
          console.log('\n✓ Monitoring completed');
        }
      }, 10000);
    } catch (error) {
      console.error(`✗ Monitoring failed: ${error.message}`);
    }
  }

  // ==================== Campaign Template Builders ====================

  buildSimpleIvrCampaign(config) {
    return {
      campaignName: config.campaignName,
      baseId: config.baseId,
      welcomePromptId: config.welcomePromptId,
      thanksPromptId: config.thanksPromptId,
      scheduleTime: config.scheduleTime,
      location: config.location || '{"locationList":[{"locationId":1,"locationName":"Default"}]}',
      smsSuccessApi: config.smsSuccessApi ? JSON.stringify(config.smsSuccessApi) : null,
    };
  }

  buildDtmfCampaign(config) {
    return {
      campaignName: config.campaignName,
      baseId: config.baseId,
      welcomePromptId: config.welcomePromptId,
      menuPromptId: config.menuPromptId,
      noInputPromptId: config.noInputPromptId,
      wrongInputPromptId: config.wrongInputPromptId,
      thanksPromptId: config.thanksPromptId,
      dtmf: config.dtmf || '1',
      scheduleTime: config.scheduleTime,
      menuWaitTime: config.menuWaitTime || 5,
      rePrompt: config.rePrompt || 2,
      location: config.location || '{"locationList":[{"locationId":1,"locationName":"Default"}]}',
      smsDtmfApi: config.smsDtmfApi ? JSON.stringify(config.smsDtmfApi) : null,
    };
  }

  buildCallPatchCampaign(config) {
    return {
      campaignName: config.campaignName,
      baseId: config.baseId,
      welcomePromptId: config.welcomePromptId,
      menuPromptId: config.menuPromptId,
      noInputPromptId: config.noInputPromptId,
      wrongInputPromptId: config.wrongInputPromptId,
      thanksPromptId: config.thanksPromptId,
      scheduleTime: config.scheduleTime,
      menuWaitTime: config.menuWaitTime || 5,
      rePrompt: config.rePrompt || 2,
      agentGroups: config.agentGroups || [],
      location: config.location || '{"locationList":[{"locationId":1,"locationName":"Default"}]}',
      callPatchSuccessMessage: config.callPatchSuccessMessage ? JSON.stringify(config.callPatchSuccessMessage) : null,
    };
  }
}

// ==================== Example Campaign Configurations ====================

const EXAMPLE_CONFIGS = {
  simpleAnnouncement: {
    campaignName: 'Product Launch Announcement',
    campaignType: 'simple-ivr',
    welcomePromptId: '954',
    thanksPromptId: '956',
    scheduleTime: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  },

  dtmfMenu: {
    campaignName: 'Interactive Support Menu',
    campaignType: 'dtmf',
    welcomePromptId: '954',
    menuPromptId: '955',
    noInputPromptId: '957',
    wrongInputPromptId: '958',
    thanksPromptId: '956',
    dtmf: '1',
    menuWaitTime: 5,
    rePrompt: 2,
    scheduleTime: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  },

  callRouting: {
    campaignName: 'Agent Routing Campaign',
    campaignType: 'call-patch',
    welcomePromptId: '954',
    menuPromptId: '955',
    noInputPromptId: '957',
    wrongInputPromptId: '958',
    thanksPromptId: '956',
    menuWaitTime: 5,
    rePrompt: 2,
    agentGroups: [
      { key: 'sales', groupId: '4', agentDtmf: '1', groupName: 'Sales Team' },
      { key: 'support', groupId: '5', agentDtmf: '2', groupName: 'Support Team' },
    ],
    scheduleTime: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  },
};

// ==================== Main Execution ====================

async function launchCampaign(campaignType = 'simpleAnnouncement') {
  const launcher = new CampaignLauncher();

  try {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║   OBD Full Campaign Launcher                               ║');
    console.log('║   Complete end-to-end campaign automation                  ║');
    console.log('╚════════════════════════════════════════════════════════════╝');

    // Authenticate
    console.log('\n🔐 Authenticating with OBD API...');
    await obdClient.login();
    console.log('✓ Authentication successful\n');

    // Get configuration
    const config = EXAMPLE_CONFIGS[campaignType];
    if (!config) {
      throw new Error(`Unknown campaign type: ${campaignType}`);
    }

    console.log(`📋 Campaign Type: ${campaignType}`);
    console.log(`📛 Campaign Name: ${config.campaignName}\n`);

    // Phase 1: Upload contact list (optional - would need actual file)
    // await launcher.uploadContactList('./data/contacts.csv', 'Customer List 2024');

    // Phase 2: Upload voice prompts (optional - would need actual files)
    // const prompts = {
    //   welcome: { filePath: './prompts/welcome.wav', fileName: 'welcome', category: 'welcome' },
    //   menu: { filePath: './prompts/menu.wav', fileName: 'menu', category: 'menu' },
    // };
    // await launcher.uploadVoicePrompts(prompts);

    // Phase 3: Create agent groups (for call routing campaigns)
    if (config.agentGroups) {
      const agentGroups = {
        sales: {
          groupName: 'Sales Team',
          agents: [
            { agentNumber: '9185718XXXXX', agentName: 'Raj Kumar', agentType: 1 },
            { agentNumber: '9876543XXXXX', agentName: 'Priya Singh', agentType: 1 },
          ],
        },
        support: {
          groupName: 'Support Team',
          agents: [
            { agentNumber: '9988776655', agentName: 'Amit Patel', agentType: 1 },
          ],
        },
      };
      await launcher.createAgentGroups(agentGroups);
    }

    // Phase 4: Setup webhooks
    const webhookConfigs = {
      voice: {
        hangup: {
          name: 'Campaign Hangup Handler',
          url: process.env.OBD_WEBHOOK_URL + '/webhooks/obd/hangup',
          event: 'HANGUP',
        },
      },
    };
    await launcher.setupWebhooks(webhookConfigs);

    // Phase 5: Create campaign
    await launcher.createCampaign({
      ...config,
      baseId: '152499', // Use existing base ID or replace with uploaded one
    });

    // Phase 6: Monitor campaign
    await launcher.monitorCampaign(30);

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║   ✓ Campaign Launch Complete                               ║');
    console.log(`║   Campaign ID: ${launcher.campaignId}`.padEnd(60) + '║');
    console.log('║   Monitor campaign in OBD dashboard for real-time stats   ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

  } catch (error) {
    console.error('\n✗ Campaign launch failed:', error.message);
    process.exit(1);
  }
}

// Parse command line arguments
const campaignType = process.argv[2] || 'simpleAnnouncement';
launchCampaign(campaignType);

export { CampaignLauncher, EXAMPLE_CONFIGS };
