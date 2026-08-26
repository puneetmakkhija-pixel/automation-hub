/**
 * Structured Logging System
 * Logs all IVR events with context for debugging and monitoring
 */

class IVRLogger {
  constructor() {
    this.logLevel = process.env.LOG_LEVEL || 'info';
    this.levels = { error: 0, warn: 1, info: 2, debug: 3 };
  }

  shouldLog(level) {
    return this.levels[level] <= this.levels[this.logLevel];
  }

  formatLog(level, context, message, data = {}) {
    return {
      timestamp: new Date().toISOString(),
      level,
      service: 'ivr-voice-bot-system',
      context,
      message,
      data,
      environment: process.env.NODE_ENV || 'production',
    };
  }

  log(level, context, message, data = {}) {
    if (!this.shouldLog(level)) return;
    const logEntry = this.formatLog(level, context, message, data);
    console.log(JSON.stringify(logEntry));
  }

  // ==================== Call Logging ====================
  logIncomingCall(phone, lenderId, callSid) {
    this.log('info', 'CALL_CONNECT', 'Incoming call received', {
      phone,
      lenderId,
      callSid,
      type: 'voice_call',
    });
  }

  logDTMFInput(phone, dtmf, lenderId) {
    this.log('info', 'DTMF_INPUT', `DTMF pressed: ${dtmf}`, {
      phone,
      dtmf,
      lenderId,
      type: 'user_input',
    });
  }

  logRouting(phone, lenderId, route, channels) {
    this.log('info', 'ROUTING_DECISION', `Routing to: ${route}`, {
      phone,
      lenderId,
      route,
      channels: channels || [],
      type: 'routing_decision',
    });
  }

  logWhatsAppSent(phone, message) {
    this.log('info', 'WHATSAPP_SEND', 'WhatsApp message sent', {
      phone,
      messageLength: message?.length || 0,
      type: 'messaging',
    });
  }

  logVoiceBotStart(phone, voiceBot) {
    this.log('info', 'VOICE_BOT_START', `Voice bot started: ${voiceBot}`, {
      phone,
      voiceBot,
      type: 'voice_bot',
    });
  }

  logEligibilityCheck(phone, result) {
    this.log('info', 'ELIGIBILITY_CHECK', 'Eligibility check completed', {
      phone,
      eligible: result.totalEligible > 0,
      totalEligible: result.totalEligible,
      primaryLender: result.primaryLender?.lenderId,
      type: 'eligibility',
    });
  }

  logCallHangup(phone, duration, reason) {
    this.log('info', 'CALL_HANGUP', 'Call ended', {
      phone,
      durationSeconds: duration,
      reason,
      type: 'call_end',
    });
  }

  logConversationStart(phone, lenderId) {
    this.log('info', 'CONVERSATION_START', 'Conversation initiated', {
      phone,
      lenderId,
      type: 'conversation',
    });
  }

  logConversationMessage(phone, phase, userInput, botResponse) {
    this.log('debug', 'CONVERSATION_MESSAGE', 'Message in conversation', {
      phone,
      phase,
      userInputLength: userInput?.length || 0,
      botResponseLength: botResponse?.length || 0,
      type: 'message',
    });
  }

  // ==================== Error Logging ====================
  logError(context, error, metadata = {}) {
    this.log('error', context, error.message, {
      error: error.message,
      stack: error.stack,
      ...metadata,
      type: 'error',
    });
  }

  logWebhookError(eventType, error, payload = {}) {
    this.log('error', 'WEBHOOK_ERROR', `Webhook processing failed: ${eventType}`, {
      eventType,
      error: error.message,
      payloadKeys: Object.keys(payload),
      type: 'webhook_error',
    });
  }

  logValidationError(field, value, error) {
    this.log('warn', 'VALIDATION_ERROR', `Validation failed for ${field}`, {
      field,
      value: typeof value === 'string' ? value.substring(0, 50) : value,
      error,
      type: 'validation',
    });
  }

  // ==================== Performance Logging ====================
  logApiLatency(endpoint, durationMs) {
    this.log('debug', 'API_LATENCY', `API call completed`, {
      endpoint,
      durationMs,
      type: 'performance',
    });
  }

  logDatabaseQuery(query, durationMs, rowsAffected) {
    this.log('debug', 'DB_QUERY', 'Database query executed', {
      query: query.substring(0, 100),
      durationMs,
      rowsAffected,
      type: 'database',
    });
  }

  // ==================== Integration Logging ====================
  logOriserveCall(phone, campaignId, status) {
    this.log('info', 'ORISERVE_CALL', 'Oriserve voice agent call initiated', {
      phone,
      campaignId,
      status,
      type: 'voice_provider',
    });
  }

  logAnantaMessage(phone, status, messageId) {
    this.log('info', 'ANANTA_MESSAGE', 'Ananta WhatsApp message', {
      phone,
      status,
      messageId,
      type: 'sms_provider',
    });
  }

  logSupabaseSync(operation, table, success, error) {
    this.log(success ? 'info' : 'error', 'SUPABASE_SYNC', `Database ${operation}`, {
      table,
      operation,
      success,
      error: error?.message,
      type: 'database_sync',
    });
  }

  // ==================== Metrics Logging ====================
  logMetrics(metrics) {
    this.log('info', 'METRICS', 'Service metrics snapshot', {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      ...metrics,
      type: 'metrics',
    });
  }
}

export default new IVRLogger();
