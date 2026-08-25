/**
 * OBD Webhook Handlers
 * Processes incoming webhooks from OBD API for:
 * - Voice call events (hangup, completion, connection)
 * - SMS/WhatsApp delivery events
 * - DTMF input tracking
 * - Call routing events
 */

// ==================== Voice Call Event Handlers ====================

export const handleHangupEvent = (payload) => {
  const {
    campaignId,
    campaignName,
    phoneNumber,
    callDuration,
    dialStatus,
    callResult,
    dtmfReceived,
    timestamp,
  } = payload;

  console.log('📞 HANGUP Event:');
  console.log(`  Campaign: ${campaignName} (ID: ${campaignId})`);
  console.log(`  Phone: ${phoneNumber}`);
  console.log(`  Duration: ${callDuration}s`);
  console.log(`  Status: ${dialStatus}`);
  console.log(`  Result: ${callResult}`);
  if (dtmfReceived) console.log(`  DTMF Input: ${dtmfReceived}`);
  console.log(`  Time: ${timestamp}`);

  return {
    success: true,
    message: 'Hangup event processed',
    data: {
      campaignId,
      phoneNumber,
      callDuration,
      processed: true,
    },
  };
};

export const handleCallConnectEvent = (payload) => {
  const {
    campaignId,
    campaignName,
    phoneNumber,
    agentNumber,
    agentName,
    groupName,
    callDuration,
    connectTime,
    timestamp,
  } = payload;

  console.log('👥 CALL CONNECT Event:');
  console.log(`  Campaign: ${campaignName} (ID: ${campaignId})`);
  console.log(`  Caller: ${phoneNumber}`);
  console.log(`  Connected to Agent: ${agentName} (${agentNumber})`);
  console.log(`  Group: ${groupName}`);
  console.log(`  Connected Duration: ${callDuration}s`);
  console.log(`  Time: ${timestamp}`);

  return {
    success: true,
    message: 'Call connect event processed',
    data: {
      campaignId,
      phoneNumber,
      agentNumber,
      groupName,
      connected: true,
    },
  };
};

export const handleDtmfEvent = (payload) => {
  const {
    campaignId,
    campaignName,
    phoneNumber,
    dtmfInput,
    dtmfDescription,
    menuLevel,
    routedToAgent,
    routedToGroup,
    timestamp,
  } = payload;

  console.log('🔢 DTMF Input Event:');
  console.log(`  Campaign: ${campaignName} (ID: ${campaignId})`);
  console.log(`  Caller: ${phoneNumber}`);
  console.log(`  DTMF Pressed: ${dtmfInput}`);
  console.log(`  Description: ${dtmfDescription}`);
  console.log(`  Menu Level: ${menuLevel}`);
  if (routedToAgent) console.log(`  Routed to Agent Group: ${routedToGroup}`);
  console.log(`  Time: ${timestamp}`);

  return {
    success: true,
    message: 'DTMF input recorded',
    data: {
      campaignId,
      phoneNumber,
      dtmfInput,
      routedToGroup,
      processed: true,
    },
  };
};

export const handleNoAnswerEvent = (payload) => {
  const { campaignId, campaignName, phoneNumber, attemptNumber, timestamp } = payload;

  console.log('❌ NO ANSWER Event:');
  console.log(`  Campaign: ${campaignName} (ID: ${campaignId})`);
  console.log(`  Phone: ${phoneNumber}`);
  console.log(`  Attempt: ${attemptNumber}`);
  console.log(`  Time: ${timestamp}`);

  return {
    success: true,
    message: 'No answer recorded',
    data: {
      campaignId,
      phoneNumber,
      retryable: true,
    },
  };
};

// ==================== SMS/WhatsApp Event Handlers ====================

export const handleSmsDeliveryEvent = (payload) => {
  const {
    campaignId,
    phoneNumber,
    messageId,
    status,
    statusDescription,
    deliveryTime,
    timestamp,
  } = payload;

  console.log('📨 SMS Delivery Event:');
  console.log(`  Campaign: ${campaignId}`);
  console.log(`  Phone: ${phoneNumber}`);
  console.log(`  Message ID: ${messageId}`);
  console.log(`  Status: ${status}`);
  console.log(`  Description: ${statusDescription}`);
  if (deliveryTime) console.log(`  Delivery Time: ${deliveryTime}`);
  console.log(`  Timestamp: ${timestamp}`);

  return {
    success: true,
    message: 'SMS delivery event processed',
    data: {
      messageId,
      phoneNumber,
      status,
      delivered: status === 'DELIVERED',
    },
  };
};

export const handleWhatsappDeliveryEvent = (payload) => {
  const {
    campaignId,
    phoneNumber,
    messageId,
    status,
    statusDescription,
    templateId,
    readTime,
    deliveryTime,
    timestamp,
  } = payload;

  console.log('💬 WhatsApp Delivery Event:');
  console.log(`  Campaign: ${campaignId}`);
  console.log(`  Phone: ${phoneNumber}`);
  console.log(`  Message ID: ${messageId}`);
  console.log(`  Template: ${templateId}`);
  console.log(`  Status: ${status}`);
  if (deliveryTime) console.log(`  Delivered: ${deliveryTime}`);
  if (readTime) console.log(`  Read: ${readTime}`);
  console.log(`  Timestamp: ${timestamp}`);

  return {
    success: true,
    message: 'WhatsApp delivery event processed',
    data: {
      messageId,
      phoneNumber,
      status,
      templateId,
      delivered: status === 'DELIVERED' || status === 'READ',
    },
  };
};

export const handleSmsReplyEvent = (payload) => {
  const { messageId, phoneNumber, replyText, timestamp } = payload;

  console.log('↩️ SMS Reply Event:');
  console.log(`  Original Message: ${messageId}`);
  console.log(`  From: ${phoneNumber}`);
  console.log(`  Reply: ${replyText}`);
  console.log(`  Timestamp: ${timestamp}`);

  return {
    success: true,
    message: 'SMS reply received',
    data: {
      messageId,
      phoneNumber,
      replyText,
      processed: true,
    },
  };
};

// ==================== Campaign Event Handlers ====================

export const handleCampaignStartEvent = (payload) => {
  const { campaignId, campaignName, totalContacts, timestamp } = payload;

  console.log('🚀 Campaign Started:');
  console.log(`  Campaign: ${campaignName} (ID: ${campaignId})`);
  console.log(`  Total Contacts: ${totalContacts}`);
  console.log(`  Time: ${timestamp}`);

  return {
    success: true,
    message: 'Campaign start event processed',
    data: {
      campaignId,
      campaignName,
      totalContacts,
      started: true,
    },
  };
};

export const handleCampaignPauseEvent = (payload) => {
  const { campaignId, campaignName, timestamp } = payload;

  console.log('⏸️ Campaign Paused:');
  console.log(`  Campaign: ${campaignName} (ID: ${campaignId})`);
  console.log(`  Time: ${timestamp}`);

  return {
    success: true,
    message: 'Campaign pause event processed',
    data: {
      campaignId,
      paused: true,
    },
  };
};

export const handleCampaignResumeEvent = (payload) => {
  const { campaignId, campaignName, timestamp } = payload;

  console.log('▶️ Campaign Resumed:');
  console.log(`  Campaign: ${campaignName} (ID: ${campaignId})`);
  console.log(`  Time: ${timestamp}`);

  return {
    success: true,
    message: 'Campaign resume event processed',
    data: {
      campaignId,
      resumed: true,
    },
  };
};

export const handleCampaignCompleteEvent = (payload) => {
  const {
    campaignId,
    campaignName,
    totalContacts,
    completedCalls,
    failedCalls,
    noAnswerCalls,
    averageCallDuration,
    totalDuration,
    timestamp,
  } = payload;

  console.log('✅ Campaign Completed:');
  console.log(`  Campaign: ${campaignName} (ID: ${campaignId})`);
  console.log(`  Total Contacts: ${totalContacts}`);
  console.log(`  Completed: ${completedCalls}`);
  console.log(`  Failed: ${failedCalls}`);
  console.log(`  No Answer: ${noAnswerCalls}`);
  console.log(`  Avg Call Duration: ${averageCallDuration}s`);
  console.log(`  Total Duration: ${totalDuration}s`);
  console.log(`  Time: ${timestamp}`);

  return {
    success: true,
    message: 'Campaign completion event processed',
    data: {
      campaignId,
      campaignName,
      stats: {
        totalContacts,
        completedCalls,
        failedCalls,
        noAnswerCalls,
        successRate: ((completedCalls / totalContacts) * 100).toFixed(2) + '%',
      },
    },
  };
};

// ==================== Agent Group Event Handlers ====================

export const handleAgentAvailableEvent = (payload) => {
  const {
    agentNumber,
    agentName,
    groupId,
    groupName,
    timestamp,
  } = payload;

  console.log('🟢 Agent Available:');
  console.log(`  Agent: ${agentName} (${agentNumber})`);
  console.log(`  Group: ${groupName} (ID: ${groupId})`);
  console.log(`  Time: ${timestamp}`);

  return {
    success: true,
    message: 'Agent available event processed',
    data: {
      agentNumber,
      groupId,
      available: true,
    },
  };
};

export const handleAgentBusyEvent = (payload) => {
  const {
    agentNumber,
    agentName,
    groupId,
    groupName,
    callDuration,
    timestamp,
  } = payload;

  console.log('🟠 Agent Busy:');
  console.log(`  Agent: ${agentName} (${agentNumber})`);
  console.log(`  Group: ${groupName} (ID: ${groupId})`);
  console.log(`  Call Duration: ${callDuration}s`);
  console.log(`  Time: ${timestamp}`);

  return {
    success: true,
    message: 'Agent busy event processed',
    data: {
      agentNumber,
      groupId,
      busy: true,
    },
  };
};

// ==================== Error Event Handler ====================

export const handleErrorEvent = (payload) => {
  const {
    campaignId,
    phoneNumber,
    errorCode,
    errorMessage,
    errorType,
    recoverable,
    timestamp,
  } = payload;

  console.log('⚠️ Error Event:');
  console.log(`  Campaign: ${campaignId}`);
  console.log(`  Phone: ${phoneNumber}`);
  console.log(`  Error Code: ${errorCode}`);
  console.log(`  Error Type: ${errorType}`);
  console.log(`  Message: ${errorMessage}`);
  console.log(`  Recoverable: ${recoverable}`);
  console.log(`  Time: ${timestamp}`);

  return {
    success: true,
    message: 'Error event logged',
    data: {
      campaignId,
      phoneNumber,
      errorCode,
      recoverable,
      logged: true,
    },
  };
};

// ==================== Event Router ====================

export const routeWebhookEvent = (eventType, payload) => {
  const handlers = {
    HANGUP: handleHangupEvent,
    CALL_CONNECT: handleCallConnectEvent,
    DTMF_INPUT: handleDtmfEvent,
    NO_ANSWER: handleNoAnswerEvent,
    SMS_DELIVERY: handleSmsDeliveryEvent,
    WHATSAPP_DELIVERY: handleWhatsappDeliveryEvent,
    SMS_REPLY: handleSmsReplyEvent,
    CAMPAIGN_START: handleCampaignStartEvent,
    CAMPAIGN_PAUSE: handleCampaignPauseEvent,
    CAMPAIGN_RESUME: handleCampaignResumeEvent,
    CAMPAIGN_COMPLETE: handleCampaignCompleteEvent,
    AGENT_AVAILABLE: handleAgentAvailableEvent,
    AGENT_BUSY: handleAgentBusyEvent,
    ERROR: handleErrorEvent,
  };

  const handler = handlers[eventType];
  if (!handler) {
    console.warn(`Unknown event type: ${eventType}`);
    return {
      success: false,
      error: `Unknown event type: ${eventType}`,
    };
  }

  try {
    return handler(payload);
  } catch (error) {
    console.error(`Error handling ${eventType}:`, error.message);
    return {
      success: false,
      error: error.message,
    };
  }
};

// ==================== Response Builders ====================

export const buildDtmfResponse = (dtmfCode, action) => {
  return {
    dtmfCode,
    action,
    prompt: getPromptForAction(action),
    timestamp: new Date().toISOString(),
  };
};

export const buildAgentRoutingResponse = (dtmfInput, agentGroupId, agentGroupName) => {
  return {
    dtmfInput,
    routingDecision: 'TRANSFER_TO_AGENT',
    agentGroupId,
    agentGroupName,
    priority: 'IMMEDIATE',
    timestamp: new Date().toISOString(),
  };
};

export const buildSmsResponse = (phoneNumber, message, messageType = 'TEXT') => {
  return {
    phoneNumber,
    message,
    messageType,
    timestamp: new Date().toISOString(),
  };
};

// ==================== Helper Functions ====================

function getPromptForAction(action) {
  const prompts = {
    SALES: 'Connecting you to our sales team. Please hold.',
    SUPPORT: 'Connecting you to customer support. Please hold.',
    BILLING: 'Connecting you to billing support. Please hold.',
    MENU_REPEAT: 'Let me repeat the menu options.',
    INVALID_INPUT: 'That was not a valid option. Please try again.',
    NO_INPUT: 'We did not receive your input. Please try again.',
    GOODBYE: 'Thank you for calling. Goodbye.',
  };

  return prompts[action] || 'Processing your request.';
}

// ==================== Exports ====================

export default {
  handleHangupEvent,
  handleCallConnectEvent,
  handleDtmfEvent,
  handleNoAnswerEvent,
  handleSmsDeliveryEvent,
  handleWhatsappDeliveryEvent,
  handleSmsReplyEvent,
  handleCampaignStartEvent,
  handleCampaignPauseEvent,
  handleCampaignResumeEvent,
  handleCampaignCompleteEvent,
  handleAgentAvailableEvent,
  handleAgentBusyEvent,
  handleErrorEvent,
  routeWebhookEvent,
  buildDtmfResponse,
  buildAgentRoutingResponse,
  buildSmsResponse,
};
