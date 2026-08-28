/**
 * OBD API Campaign Examples
 * Demonstrates how to use the OBD API client for different campaign types
 */

import OBDApiClient from '../lib/obdApiClient.js';
import * as templates from '../lib/campaignTemplates.js';

// Initialize the OBD API Client
const obdClient = new OBDApiClient(
  'https://obdapi2.ivrsms.com',
  'your_username',
  'your_password'
);

// ==================== Example 1: Simple IVR Campaign ====================
/**
 * Create a simple IVR campaign with voice prompts
 * Use case: Product announcements, notifications
 */
async function createSimpleIvrExample() {
  try {
    console.log('\n===== Example 1: Simple IVR Campaign =====');

    const campaignConfig = {
      campaignName: 'Product Launch Announcement 2024',
      baseId: '152499', // Contact list ID from base upload
      welcomePromptId: '954', // Voice file ID
      thanksPromptId: '956',
      scheduleTime: '2024-08-28 10:00:00',
      location: '{"locationList":[{"locationId":1,"locationName":"Mumbai"}]}',
      // Optional SMS notification on success
      smsSuccessApi: JSON.stringify({
        url: 'https://your-api.com/notify',
        requestType: 'GET',
        smsText: 'Thank you for listening',
      }),
    };

    const campaign = templates.createSimpleIvrCampaign(campaignConfig);
    const result = await obdClient.composeCampaign(campaign);

    console.log('Campaign created successfully:');
    console.log(`Campaign ID: ${result.campaignId}`);
    console.log(`Message: ${result.message}`);

    return result.campaignId;
  } catch (error) {
    console.error('Error creating Simple IVR campaign:', error.message);
  }
}

// ==================== Example 2: DTMF Campaign ====================
/**
 * Create a DTMF campaign with interactive menu
 * Use case: Customer service menus, surveys
 */
async function createDtmfCampaignExample() {
  try {
    console.log('\n===== Example 2: DTMF Campaign =====');

    const campaignConfig = {
      campaignName: 'Customer Support Menu - August 2024',
      baseId: '152499',
      welcomePromptId: '954',
      menuPromptId: '955', // "Press 1 for sales, 2 for support, 3 for billing"
      noInputPromptId: '957', // "Sorry, we didn't hear you"
      wrongInputPromptId: '958', // "That's not a valid option"
      thanksPromptId: '956',
      dtmf: '1', // Valid DTMF input
      scheduleTime: '2024-08-28 11:00:00',
      menuWaitTime: 5, // Wait 5 seconds for input
      rePrompt: 2, // Repeat menu twice if no input
      location: '{"locationList":[{"locationId":1,"locationName":"Mumbai"}]}',
      // SMS on successful DTMF response
      smsDtmfApi: JSON.stringify({
        url: 'https://media.sendmsg.in/mediasend',
        requestType: 'WHATSAPP',
        payload: JSON.stringify({
          user: 'your_user',
          pass: 'your_pass',
          whatsapptosend: [{
            from: '919XXXXXXXXX',
            to: '91{PHONE}',
            templateid: 'thank_you',
          }],
        }),
      }),
    };

    const campaign = templates.createDtmfCampaign(campaignConfig);
    const result = await obdClient.composeCampaign(campaign);

    console.log('DTMF Campaign created successfully:');
    console.log(`Campaign ID: ${result.campaignId}`);

    return result.campaignId;
  } catch (error) {
    console.error('Error creating DTMF campaign:', error.message);
  }
}

// ==================== Example 3: Call Patch Campaign ====================
/**
 * Create a Call Patch campaign to route calls to agents
 * Use case: Customer support, sales calls
 */
async function createCallPatchCampaignExample() {
  try {
    console.log('\n===== Example 3: Call Patch Campaign =====');

    // First, ensure agent groups are set up
    const agentGroups = await obdClient.getAgentGroups();
    console.log(`Found ${agentGroups.length} agent groups`);

    const campaignConfig = {
      campaignName: 'Sales Agent Routing - August 2024',
      baseId: '152499',
      welcomePromptId: '954',
      menuPromptId: '955', // "Press 1 for sales, 2 for support"
      noInputPromptId: '957',
      wrongInputPromptId: '958',
      thanksPromptId: '956',
      scheduleTime: '2024-08-28 12:00:00',
      menuWaitTime: 5,
      rePrompt: 2,
      // Agent routing configuration
      agentGroups: [
        {
          groupId: '4',
          agentDtmf: '1',
          groupName: 'Sales Team',
        },
        {
          groupId: '5',
          agentDtmf: '2',
          groupName: 'Support Team',
        },
      ],
      location: '{"locationList":[{"locationId":1,"locationName":"Mumbai"}]}',
      // Success message when connected to agent
      callPatchSuccessMessage: JSON.stringify({
        url: 'https://your-api.com/connected',
        requestType: 'GET',
      }),
    };

    const campaign = templates.createCallPatchCampaign(campaignConfig);
    const result = await obdClient.composeCampaign(campaign);

    console.log('Call Patch Campaign created successfully:');
    console.log(`Campaign ID: ${result.campaignId}`);

    return result.campaignId;
  } catch (error) {
    console.error('Error creating Call Patch campaign:', error.message);
  }
}

// ==================== Example 4: Campaign Management ====================
/**
 * Demonstrate campaign control operations
 */
async function campaignManagementExample(campaignId) {
  try {
    console.log('\n===== Example 4: Campaign Management =====');

    // Pause campaign
    console.log(`\nPausing campaign ${campaignId}...`);
    let result = await obdClient.pauseCampaign(campaignId);
    console.log('Pause result:', result.message);

    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Resume campaign
    console.log(`\nResuming campaign ${campaignId}...`);
    result = await obdClient.resumeCampaign(campaignId);
    console.log('Resume result:', result.message);

    // Analyze campaign (check stats)
    console.log(`\nAnalyzing campaign statistics...`);
    result = await obdClient.analyzeCampaign(
      '2024-08-01',
      '2024-08-28',
      'All',
      'All',
      ''
    );
    console.log('Campaign stats:');
    console.log(JSON.stringify(result, null, 2));

  } catch (error) {
    console.error('Error in campaign management:', error.message);
  }
}

// ==================== Example 5: Webhook Configuration ====================
/**
 * Set up webhooks to receive campaign events
 */
async function webhookConfigurationExample() {
  try {
    console.log('\n===== Example 5: Webhook Configuration =====');

    // Create a voice webhook for campaign events
    console.log('\nCreating voice webhook...');
    const voiceWebhook = {
      webhookName: 'Campaign Completion Handler',
      url: 'https://your-domain.com/webhooks/obd',
      event: 'HANGUP',
    };

    let result = await obdClient.addWebhook(
      voiceWebhook.webhookName,
      voiceWebhook.url,
      voiceWebhook.event
    );
    console.log('Voice webhook created:', result.webhookId);

    // Create an SMS webhook for WhatsApp notifications
    console.log('\nCreating SMS webhook...');
    const smsWebhook = {
      webhookName: 'WhatsApp Notification Handler',
      url: 'https://media.sendmsg.in/mediasend',
      requestType: 'WHATSAPP',
      smsText: '',
      payload: JSON.stringify({
        user: 'your_user',
        pass: 'your_pass',
        whatsapptosend: [{
          from: '919XXXXXXXXX',
          to: '91{PHONE}',
          templateid: 'campaign_complete',
          smsgid: 'campaign_thank_you',
        }],
      }),
    };

    result = await obdClient.addSmsWebhook(
      smsWebhook.webhookName,
      smsWebhook.url,
      smsWebhook.requestType,
      smsWebhook.smsText,
      smsWebhook.payload
    );
    console.log('SMS webhook created:', result.webhookId);

    // List all webhooks
    console.log('\nListing all webhooks...');
    const webhooks = await obdClient.getWebhooks();
    console.log(`Total webhooks: ${webhooks.length}`);
    webhooks.forEach(w => {
      console.log(`- ${w.webhookName} (Event: ${w.event})`);
    });

  } catch (error) {
    console.error('Error setting up webhooks:', error.message);
  }
}

// ==================== Example 6: Agent Group Management ====================
/**
 * Manage agent groups for call routing
 */
async function agentGroupManagementExample() {
  try {
    console.log('\n===== Example 6: Agent Group Management =====');

    // Create a new agent group
    console.log('\nCreating agent group...');
    const newGroup = {
      groupName: 'Premium Support Team',
      agents: [
        {
          agentNumber: '9185718XXXXX',
          agentName: 'Raj Kumar',
          agentType: 1, // Call Center Agent
        },
        {
          agentNumber: '9876543XXXXX',
          agentName: 'Priya Singh',
          agentType: 1,
        },
      ],
    };

    let result = await obdClient.addAgentGroup(
      newGroup.groupName,
      newGroup.agents
    );
    console.log('Agent group created successfully');

    // List all agent groups
    console.log('\nListing agent groups...');
    const groups = await obdClient.getAgentGroups();
    console.log(`Total agent groups: ${groups.length}`);
    groups.forEach(g => {
      console.log(`- ${g.groupName} (${g.agents.length} agents)`);
      g.agents.forEach(a => {
        console.log(`  * ${a.agentName}: ${a.agentNumber}`);
      });
    });

  } catch (error) {
    console.error('Error managing agent groups:', error.message);
  }
}

// ==================== Example 7: Voice File Management ====================
/**
 * Upload and manage voice prompts
 * Note: This requires file system access and file upload
 */
async function voiceFileManagementExample() {
  try {
    console.log('\n===== Example 7: Voice File Management =====');

    // List existing voice files
    console.log('\nListing uploaded voice files...');
    const voices = await obdClient.getVoiceFiles();
    console.log(`Total voice files: ${voices.length}`);
    voices.forEach(v => {
      console.log(`- ${v.fileName} (Category: ${v.promptCategory}, ID: ${v.promptId})`);
    });

    console.log('\nTo upload a voice file, use:');
    console.log('POST /api/obd/voices/upload');
    console.log('Content-Type: multipart/form-data');

  } catch (error) {
    console.error('Error managing voice files:', error.message);
  }
}

// ==================== Example 8: Campaign Reporting ====================
/**
 * Generate and download campaign reports
 */
async function campaignReportingExample(campaignId) {
  try {
    console.log('\n===== Example 8: Campaign Reporting =====');

    // Generate report for a campaign
    console.log(`\nGenerating report for campaign ${campaignId}...`);
    let result = await obdClient.generateReport(campaignId, 'full');
    console.log('Report generation initiated:');
    console.log(`Status: ${result.reportStatus}`);
    console.log(`Message: ${result.message}`);

    // Download available reports
    console.log('\nDownloading reports...');
    result = await obdClient.downloadReport();
    console.log(`Total reports available: ${result.length}`);
    result.slice(0, 5).forEach(r => {
      console.log(`- Campaign: ${r.campaignName}`);
      console.log(`  Status: ${r.status}`);
      console.log(`  Requested: ${r.reqDate}`);
      if (r.reportUrl) console.log(`  Download: ${r.reportUrl}`);
    });

  } catch (error) {
    console.error('Error in campaign reporting:', error.message);
  }
}

// ==================== Main Execution ====================
async function runExamples() {
  try {
    console.log('====================================');
    console.log('OBD API Campaign Examples');
    console.log('====================================');

    // Authenticate first
    console.log('\nAuthenticating with OBD API...');
    await obdClient.login();
    console.log('✓ Authentication successful');

    // Run examples
    // const simpleCampaignId = await createSimpleIvrExample();
    // const dtmfCampaignId = await createDtmfCampaignExample();
    // const callPatchCampaignId = await createCallPatchCampaignExample();

    // Uncomment below to test campaign management
    // await campaignManagementExample(simpleCampaignId);

    await webhookConfigurationExample();
    await agentGroupManagementExample();
    await voiceFileManagementExample();
    // await campaignReportingExample(simpleCampaignId);

    console.log('\n====================================');
    console.log('✓ All examples completed');
    console.log('====================================\n');

  } catch (error) {
    console.error('\n✗ Error running examples:', error.message);
  }
}

// Uncomment to run examples
// runExamples();

export {
  createSimpleIvrExample,
  createDtmfCampaignExample,
  createCallPatchCampaignExample,
  campaignManagementExample,
  webhookConfigurationExample,
  agentGroupManagementExample,
  voiceFileManagementExample,
  campaignReportingExample,
};
