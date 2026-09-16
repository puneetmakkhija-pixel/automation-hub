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
 * A schedule time the dialler will accept.
 *
 * OBD answered compose with:
 *
 *   {"message":"Invalid Schedule Date and Time !!"}
 *
 * The templates built it as `new Date().toISOString()`, which is UTC. OBD is
 * an Indian dialler and reads the string as IST, so a campaign composed at
 * 10:14 UTC arrived asking to be scheduled at 10:14 IST -- five and a half
 * hours in the PAST, every single time. A past schedule is not a schedule.
 *
 * India has no daylight saving, so the offset is a constant +05:30 and a fixed
 * arithmetic shift is exact rather than approximate.
 *
 * The lead is small and deliberate: "now" races the request itself, and by the
 * time the dialler parses the body a second or two has gone. Two minutes is
 * comfortably past that and still reads as immediate to a human watching the
 * campaign list.
 */
const IST_OFFSET_MINUTES = 5 * 60 + 30;

export function obdScheduleTime(now = new Date(), leadMinutes = 2) {
  const at = new Date(now.getTime() + leadMinutes * 60000 + IST_OFFSET_MINUTES * 60000);
  return at.toISOString().slice(0, 19).replace('T', ' ');
}

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
    scheduleTime: config.scheduleTime || obdScheduleTime(),
    smsSuccessApi: config.smsSuccessApi || '{}',
    smsFailApi: config.smsFailApi || '{}',
    smsDtmfApi: config.smsDtmfApi || '{}',
    callDurationSMS: config.callDurationSMS || 0,
    retries: config.retries || 2,
    retryInterval: config.retryInterval || 10,
    // '""' is a JSON-encoded EMPTY STRING, and it is a guess that has never
    // been tested. createCallPatchCampaign -- written by someone who knew the
    // shape -- sends JSON.stringify({patchList: [...]}), an object. These two
    // send a string. Something has to explain compose answering 400 with a
    // ZERO-BYTE body when every earlier refusal named its field
    // ("locationList is missing", "Invalid Schedule Date and Time !!"), and a
    // server that did JSON.parse(agentRows).patchList on a string would throw
    // before it could compose a message. That is exactly what an empty 400
    // looks like.
    //
    // Not changed blind: made overridable so probe-compose can settle it in
    // one request instead of a deploy per shape. The default stays as it was
    // until the dialler says otherwise.
    agentRows: config.agentRows ?? '""',
    menuWaitTime: config.menuWaitTime || '',
    rePrompt: config.rePrompt || '',
    location: config.location || '{}',
    // "locationList is missing" -- the dialler's own words, twice in a row, on
    // an otherwise complete payload. It is a separate field from `location`,
    // which we were already sending, and nothing here had ever sent it.
    //
    // '[]' rather than '{}' because this file stringifies everything it sends
    // and uses '[]' for the list-shaped fields (ttsRows) and '{}' for the
    // object-shaped ones (location, smsSuccessApi). A field called
    // locationList is a list. An empty one is "no location filter", which is
    // what a nationwide campaign wants.
    locationList: config.locationList || '[]',
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
    scheduleTime: config.scheduleTime || obdScheduleTime(),
    smsSuccessApi: config.smsSuccessApi || '{}',
    smsFailApi: config.smsFailApi || '{}',
    smsDtmfApi: config.smsDtmfApi || '{}',
    callDurationSMS: config.callDurationSMS || 0,
    retries: config.retries || 2,
    retryInterval: config.retryInterval || 10,
    // See the note in createSimpleIvrCampaign: a guess, made overridable so it
    // can be probed rather than redeployed per shape.
    agentRows: config.agentRows ?? '""',
    menuWaitTime: config.menuWaitTime || 5,
    rePrompt: config.rePrompt || 2,
    location: config.location || '{}',
    // "locationList is missing" -- the dialler's own words, twice in a row, on
    // an otherwise complete payload. It is a separate field from `location`,
    // which we were already sending, and nothing here had ever sent it.
    //
    // '[]' rather than '{}' because this file stringifies everything it sends
    // and uses '[]' for the list-shaped fields (ttsRows) and '{}' for the
    // object-shaped ones (location, smsSuccessApi). A field called
    // locationList is a list. An empty one is "no location filter", which is
    // what a nationwide campaign wants.
    locationList: config.locationList || '[]',
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
    scheduleTime: config.scheduleTime || obdScheduleTime(),
    smsSuccessApi: config.smsSuccessApi || '{}',
    smsFailApi: config.smsFailApi || '{}',
    smsDtmfApi: config.smsDtmfApi || '{}',
    callDurationSMS: config.callDurationSMS || 0,
    retries: config.retries || 2,
    retryInterval: config.retryInterval || 10,
    agentRows:
      config.agentRows ??
      JSON.stringify({
        patchList: config.agentGroups || [],
      }),
    menuWaitTime: config.menuWaitTime || 5,
    rePrompt: config.rePrompt || 2,
    location: config.location || '{}',
    // "locationList is missing" -- the dialler's own words, twice in a row, on
    // an otherwise complete payload. It is a separate field from `location`,
    // which we were already sending, and nothing here had ever sent it.
    //
    // '[]' rather than '{}' because this file stringifies everything it sends
    // and uses '[]' for the list-shaped fields (ttsRows) and '{}' for the
    // object-shaped ones (location, smsSuccessApi). A field called
    // locationList is a list. An empty one is "no location filter", which is
    // what a nationwide campaign wants.
    locationList: config.locationList || '[]',
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
