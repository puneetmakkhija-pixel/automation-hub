import ananta from '../clients/anantaClient.js';
import supabase from '../clients/supabaseClient.js';
import axios from 'axios';

class ApplicationPushClient {
  constructor() {
    this.sendgridApiKey = process.env.SENDGRID_API_KEY;
    this.sendgridFromEmail = process.env.SENDGRID_FROM_EMAIL || 'support@buddyloan.com';
    this.slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
  }

  async sendPersonalizedApplicationPush(phoneNumber, userIntent, userProfile) {
    try {
      const pushResult = {
        phone_number: phoneNumber,
        channels_attempted: [],
        channels_succeeded: [],
        push_timestamp: new Date().toISOString(),
        intent_used: userIntent?.intent,
        personalized_message: userIntent?.personalized_message
      };

      // Channel 1: WhatsApp (Primary)
      const whatsappResult = await this.sendWhatsAppMessage(phoneNumber, userIntent, userProfile);
      pushResult.channels_attempted.push('whatsapp');

      if (whatsappResult.success) {
        pushResult.channels_succeeded.push('whatsapp');
        pushResult.whatsapp_message_id = whatsappResult.message_id;
        console.log(`[AppPush] WhatsApp sent to ${phoneNumber}: ${whatsappResult.message_id}`);
      } else {
        console.error(`[AppPush] WhatsApp failed for ${phoneNumber}: ${whatsappResult.error}`);

        // Channel 2: Email (Fallback if WhatsApp fails)
        const emailResult = await this.sendEmailMessage(phoneNumber, userIntent, userProfile);
        pushResult.channels_attempted.push('email');

        if (emailResult.success) {
          pushResult.channels_succeeded.push('email');
          pushResult.email_message_id = emailResult.message_id;
          console.log(`[AppPush] Email sent to ${userProfile.email}: ${emailResult.message_id}`);
        } else {
          console.error(`[AppPush] Email failed for ${phoneNumber}: ${emailResult.error}`);
        }
      }

      // Channel 3: Slack Alert (for ops team on high-intent leads)
      if (userIntent?.completion_probability > 0.80) {
        const slackResult = await this.sendSlackAlert(phoneNumber, userIntent, userProfile);
        pushResult.channels_attempted.push('slack');

        if (slackResult.success) {
          pushResult.channels_succeeded.push('slack');
          console.log(`[AppPush] Slack alert sent for high-intent lead: ${phoneNumber}`);
        } else {
          console.warn(`[AppPush] Slack alert failed: ${slackResult.error}`);
        }
      }

      // Store push event in Supabase
      await this.storePushEvent(pushResult);

      return {
        success: pushResult.channels_succeeded.length > 0,
        push_event: pushResult,
        message: `Push sent via ${pushResult.channels_succeeded.join(', ')}`
      };
    } catch (error) {
      console.error('[AppPush] Push orchestration error:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async sendWhatsAppMessage(phoneNumber, userIntent, userProfile) {
    try {
      const message = this.buildWhatsAppMessage(userIntent, userProfile);

      const response = await ananta.sendTextMessage(phoneNumber, message);

      return {
        success: response.success || true,
        message_id: response.messageId || response.msgid || 'whatsapp_' + Date.now(),
        error: response.error || null
      };
    } catch (error) {
      console.error('[AppPush] WhatsApp send error:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  buildWhatsAppMessage(userIntent, userProfile) {
    const name = userProfile.name || 'there';
    const amount = this.formatCurrency(userIntent?.recommended_amount || 500000);
    const rate = '14';
    const tenure = 36;
    const emi = this.calculateEMI(userIntent?.recommended_amount || 500000, tenure);

    return `Hi ${name}! 👋

We can help you get ${amount} to ${this.getMessagingCopy(userIntent?.messaging_angle)}.

✅ No guarantor needed
✅ Approval in 24 hours
✅ Your rate: ${rate}% p.a. (EMI: ₹${this.formatCurrency(emi)}/month)

Start your application → [Click here]

Any questions? Just reply here! 💬`;
  }

  async sendEmailMessage(phoneNumber, userIntent, userProfile) {
    try {
      if (!this.sendgridApiKey) {
        return { success: false, error: 'SendGrid API key not configured' };
      }

      if (!userProfile.email) {
        return { success: false, error: 'User email not available' };
      }

      const { subject, html } = this.buildEmailContent(userIntent, userProfile);

      const response = await axios.post(
        'https://api.sendgrid.com/v3/mail/send',
        {
          personalizations: [
            {
              to: [{ email: userProfile.email }],
              subject: subject
            }
          ],
          from: { email: this.sendgridFromEmail, name: 'BuddyLoan' },
          content: [
            {
              type: 'text/html',
              value: html
            }
          ]
        },
        {
          headers: {
            'Authorization': `Bearer ${this.sendgridApiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        success: response.status === 202,
        message_id: response.headers['x-message-id'] || 'email_' + Date.now(),
        error: null
      };
    } catch (error) {
      console.error('[AppPush] Email send error:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  buildEmailContent(userIntent, userProfile) {
    const name = userProfile.name || 'User';
    const amount = this.formatCurrency(userIntent?.recommended_amount || 500000);
    const rate = '14';

    const subject = `₹${amount} Pre-Approved for ${name} - Complete in 5 Minutes`;

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Arial, sans-serif; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background-color: #1a73e8; color: white; padding: 20px; border-radius: 8px 8px 0 0; text-align: center; }
    .content { background-color: #f9f9f9; padding: 30px; }
    .cta { background-color: #1a73e8; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 20px; }
    .benefits { list-style: none; padding: 0; margin: 20px 0; }
    .benefits li { padding: 10px 0; border-bottom: 1px solid #ddd; }
    .benefits li:before { content: "✓ "; color: #1a73e8; font-weight: bold; margin-right: 10px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Pre-Approved Loan Offer</h1>
    </div>
    <div class="content">
      <p>Hi ${name},</p>

      <p>We're excited to let you know that you've been <strong>pre-approved</strong> for a loan of <strong>₹${amount}</strong>!</p>

      <h3>Your Offer Details:</h3>
      <ul class="benefits">
        <li>Loan Amount: ₹${amount}</li>
        <li>Interest Rate: ${rate}% p.a.</li>
        <li>Approval Time: 24 hours</li>
        <li>No guarantor required</li>
      </ul>

      <p>Completing your application takes just 5 minutes. Click the button below to get started:</p>

      <center>
        <a href="https://app.buddyloan.com/application" class="cta">Complete Your Application</a>
      </center>

      <p style="margin-top: 30px; color: #666; font-size: 14px;">
        Questions? Reply to this email or contact our support team at support@buddyloan.com
      </p>
    </div>
  </div>
</body>
</html>`;

    return { subject, html };
  }

  async sendSlackAlert(phoneNumber, userIntent, userProfile) {
    try {
      if (!this.slackWebhookUrl) {
        return { success: false, error: 'Slack webhook URL not configured' };
      }

      const name = userProfile.name || 'Unknown';
      const amount = this.formatCurrency(userIntent?.recommended_amount || 500000);
      const completionProb = (userIntent?.completion_probability * 100).toFixed(0);
      const lender = userIntent?.recommended_lender || 'TBD';

      const payload = {
        channel: '#application-tracking',
        username: 'BuddyLoan Bot',
        icon_emoji: ':rocket:',
        attachments: [
          {
            fallback: `High-intent lead: ${name}`,
            color: '#1a73e8',
            title: `🚀 High-Intent Lead: ${name}`,
            fields: [
              {
                title: 'Phone',
                value: phoneNumber,
                short: true
              },
              {
                title: 'Loan Amount',
                value: `₹${amount}`,
                short: true
              },
              {
                title: 'Intent',
                value: userIntent?.intent || 'Unknown',
                short: true
              },
              {
                title: 'Completion Probability',
                value: `${completionProb}%`,
                short: true
              },
              {
                title: 'Recommended Lender',
                value: lender,
                short: true
              },
              {
                title: 'Risk Profile',
                value: userIntent?.risk_profile || 'Unknown',
                short: true
              },
              {
                title: 'Message',
                value: userIntent?.personalized_message || 'N/A',
                short: false
              }
            ],
            footer: 'Intent Generation Engine',
            ts: Math.floor(Date.now() / 1000)
          }
        ]
      };

      const response = await axios.post(this.slackWebhookUrl, payload);

      return {
        success: response.status === 200,
        message_id: 'slack_' + Date.now(),
        error: null
      };
    } catch (error) {
      console.error('[AppPush] Slack alert error:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async storePushEvent(pushEvent) {
    try {
      const { data, error } = await supabase
        .from('push_events')
        .insert({
          phone_number: pushEvent.phone_number,
          channels_attempted: pushEvent.channels_attempted,
          channels_succeeded: pushEvent.channels_succeeded,
          intent_used: pushEvent.intent_used,
          personalized_message: pushEvent.personalized_message,
          whatsapp_message_id: pushEvent.whatsapp_message_id,
          email_message_id: pushEvent.email_message_id,
          created_at: pushEvent.push_timestamp
        });

      if (error) {
        console.error('[AppPush] Storage error:', error.message);
        return { success: false, error: error.message };
      }

      return { success: true, data };
    } catch (error) {
      console.error('[AppPush] Push event storage error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async trackPushEngagement(phoneNumber, eventType, metadata = {}) {
    try {
      const { data, error } = await supabase
        .from('push_engagement_events')
        .insert({
          phone_number: phoneNumber,
          event_type: eventType, // 'whatsapp_opened', 'email_clicked', 'application_started', etc.
          metadata: metadata,
          created_at: new Date().toISOString()
        });

      if (error) {
        console.error('[AppPush] Engagement tracking error:', error.message);
        return { success: false };
      }

      return { success: true };
    } catch (error) {
      console.error('[AppPush] Tracking error:', error.message);
      return { success: false };
    }
  }

  formatCurrency(amount) {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).replace('₹', '').trim();
  }

  calculateEMI(principal, months) {
    const monthlyRate = (10.5 / 12) / 100;
    const emi = (principal * monthlyRate * Math.pow(1 + monthlyRate, months)) /
                (Math.pow(1 + monthlyRate, months) - 1);
    return Math.round(emi);
  }

  getMessagingCopy(messagingAngle) {
    const copies = {
      'cash_flow_smooth': 'manage your seasonal cash flow',
      'business_growth': 'invest in business growth',
      'debt_relief': 'consolidate your existing debts',
      'seasonal_need': 'handle seasonal business demands',
      'emergency_support': 'address your immediate cash needs'
    };

    return copies[messagingAngle] || 'grow your business';
  }
}

export default new ApplicationPushClient();
