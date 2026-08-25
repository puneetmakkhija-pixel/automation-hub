/**
 * Campaign Templates for OBD API
 * Provides default configurations for different campaign types
 */

export const CampaignTypes = {
  SIMPLE_IVR: 0,
  DTMF: 1,
  CALL_PATCH: 2,
  CUSTOM_IVR: 3,
  TTS_SIMPLE_IVR: 7,
  TTS_DTMF: 8,
  TTS_CALL_PATCH: 9,
};

export const PromptCategories = {
  WELCOME: 'welcome',
  MENU: 'menu',
  THANKS: 'thanks',
  NO_INPUT: 'noinput',
  WRONG_INPUT: 'wronginput',
};

/**
 * Simple IVR Campaign Template
 * Basic outbound call with voice prompts
 */
export function createSimpleIvrCampaign(config) {
  return {
    campaignName: config.campaignName,
    templateId: CampaignTypes.SIMPLE_IVR,
    dtmf: '',
    baseId: config.baseId,
    welcomePId: config.welcomePromptId || '',
    menuPId: config.menuPromptId || '',
    noInputPId: config.noInputPromptId || '',
    wrongInputPId: config.wrongInputPromptId || '',
    thanksPId: config.thanksPromptId || '',
    scheduleTime: config.scheduleTime || new Date().toISOString().slice(0, 19).replace('T', ' '),
    smsSuccessApi: config.smsSuccessApi || '{}',
    smsFailApi: config.smsFailApi || '{}',
    smsDtmfApi: config.smsDtmfApi || '{}',
    callDurationSMS: config.callDurationSMS || 0,
    retries: config.retries || 2,
    retryInterval: config.retryInterval || 10,
    agentRows: '""',
    menuWaitTime: config.menuWaitTime || '',
    rePrompt: config.rePrompt || '',
    location: config.location || '{}',
    clis: config.clis || '',
    webhook: config.webhook || false,
    webhookId: config.webhookId || '',
    ttsRows: '[]',
    gender: config.gender || '',
    language: config.language || '',
    noAgentId: config.noAgentId || '',
    callPatchSuccessMessage: config.callPatchSuccessMessage || '',
    callPatchFailMessage: config.callPatchFailMessage || '',
  };
}

/**
 * DTMF Campaign Template
 * Interactive campaign with DTMF (phone keypad) input
 */
export function createDtmfCampaign(config) {
  return {
    campaignName: config.campaignName,
    templateId: CampaignTypes.DTMF,
    dtmf: config.dtmf || '1',
    baseId: config.baseId,
    welcomePId: config.welcomePromptId || '',
    menuPId: config.menuPromptId,
    noInputPId: config.noInputPromptId || '',
    wrongInputPId: config.wrongInputPromptId || '',
    thanksPId: config.thanksPromptId || '',
    scheduleTime: config.scheduleTime || new Date().toISOString().slice(0, 19).replace('T', ' '),
    smsSuccessApi: config.smsSuccessApi || '{}',
    smsFailApi: config.smsFailApi || '{}',
    smsDtmfApi: config.smsDtmfApi || '{}',
    callDurationSMS: config.callDurationSMS || 0,
    retries: config.retries || 2,
    retryInterval: config.retryInterval || 10,
    agentRows: '""',
    menuWaitTime: config.menuWaitTime || 5,
    rePrompt: config.rePrompt || 2,
    location: config.location || '{}',
    clis: config.clis || '',
    webhook: config.webhook || false,
    webhookId: config.webhookId || '',
    ttsRows: '[]',
    gender: config.gender || '',
    language: config.language || '',
    noAgentId: config.noAgentId || '',
    callPatchSuccessMessage: config.callPatchSuccessMessage || '',
    callPatchFailMessage: config.callPatchFailMessage || '',
  };
}

/**
 * Call Patch Campaign Template
 * Routes calls to agents based on DTMF input
 */
export function createCallPatchCampaign(config) {
  return {
    campaignName: config.campaignName,
    templateId: CampaignTypes.CALL_PATCH,
    dtmf: '',
    baseId: config.baseId,
    welcomePId: config.welcomePromptId || '',
    menuPId: config.menuPromptId,
    noInputPId: config.noInputPromptId || '',
    wrongInputPId: config.wrongInputPromptId || '',
    thanksPId: config.thanksPromptId || '',
    scheduleTime: config.scheduleTime || new Date().toISOString().slice(0, 19).replace('T', ' '),
    smsSuccessApi: config.smsSuccessApi || '{}',
    smsFailApi: config.smsFailApi || '{}',
    smsDtmfApi: config.smsDtmfApi || '{}',
    callDurationSMS: config.callDurationSMS || 0,
    retries: config.retries || 2,
    retryInterval: config.retryInterval || 10,
    agentRows: JSON.stringify({
      patchList: config.agentGroups || [],
    }),
    menuWaitTime: config.menuWaitTime || 5,
    rePrompt: config.rePrompt || 2,
    location: config.location || '{}',
    clis: config.clis || '',
    webhook: config.webhook || false,
    webhookId: config.webhookId || '',
    ttsRows: '[]',
    gender: config.gender || '',
    language: config.language || '',
    noAgentId: config.noAgentId || '',
    callPatchSuccessMessage: config.callPatchSuccessMessage || '{}',
    callPatchFailMessage: config.callPatchFailMessage || '{}',
  };
}

/**
 * SMS Webhook Configuration Template
 */
export function createSmsWebhookConfig(config) {
  return {
    webhookName: config.webhookName,
    url: config.url,
    requestType: config.requestType || 'GET', // GET or WHATSAPP
    smsText: config.smsText || '',
    payload: config.payload || '',
  };
}

/**
 * Voice Webhook Configuration Template
 */
export function createVoiceWebhookConfig(config) {
  return {
    webhookName: config.webhookName,
    url: config.url,
    event: config.event || 'HANGUP', // HANGUP or other events
  };
}

/**
 * Agent Group Configuration Template
 */
export function createAgentGroup(config) {
  return {
    groupName: config.groupName,
    agents: config.agents.map(agent => ({
      agentNumber: agent.agentNumber,
      agentName: agent.agentName,
      agentType: agent.agentType || 0, // 0 = Normal, 1 = Call Center
    })),
  };
}

/**
 * Campaign Analysis Query Template
 */
export function createAnalysisQuery(config) {
  return {
    startDate: config.startDate,
    endDate: config.endDate,
    campaignName: config.campaignName || 'All',
    campaignType: config.campaignType || 'All',
    username: config.username || '',
  };
}
