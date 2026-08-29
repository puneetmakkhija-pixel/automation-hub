/**
 * Email Service
 * Handles sending emails via SendGrid with document attachments
 */

import sgMail from '@sendgrid/mail';
import logger from '../logging.js';

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'support@buddyloan.com';

if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
}

// FlexiLoans document submission recipients
const FLEXILOANS_TO = 'dadocs@flexiloans.com';
const FLEXILOANS_CC = ['sharda.p@buddyloan.com', 'rachit.saini@buddyloan.com'];

/**
 * Send FlexiLoans document collection email
 * @param {Object} options
 * @param {string} options.phone - Customer phone number
 * @param {string} options.name - Customer name
 * @param {Object} options.documents - Document data {panUrl, aadharUrl, bankStatementUrl}
 * @param {Object} options.metadata - Additional metadata
 */
export async function sendFlexiLoansDocumentEmail(options) {
  try {
    const { phone, name, documents, metadata = {} } = options;

    if (!SENDGRID_API_KEY) {
      logger.log('warn', 'EMAIL_NOT_CONFIGURED', 'SendGrid not configured', {
        type: 'email_service',
      });
      return { success: false, error: 'Email service not configured' };
    }

    const documentLinks = [];
    if (documents.panUrl) documentLinks.push(`PAN: ${documents.panUrl}`);
    if (documents.aadharUrl) documentLinks.push(`Aadhar: ${documents.aadharUrl}`);
    if (documents.bankStatementUrl) documentLinks.push(`Bank Statement: ${documents.bankStatementUrl}`);

    const htmlContent = `
      <h2>FlexiLoans Document Collection</h2>
      <p><strong>Customer Name:</strong> ${name}</p>
      <p><strong>Phone Number:</strong> ${phone}</p>
      <p><strong>Submission Time:</strong> ${new Date().toISOString()}</p>

      <h3>Documents Submitted:</h3>
      <ul>
        ${documentLinks.map(link => `<li>${link}</li>`).join('')}
      </ul>

      ${metadata.customerDetails ? `
        <h3>Customer Details:</h3>
        <pre>${JSON.stringify(metadata.customerDetails, null, 2)}</pre>
      ` : ''}

      <p><em>This is an automated message from the FlexiLoans IVR Automation Hub</em></p>
    `;

    const msg = {
      to: FLEXILOANS_TO,
      cc: FLEXILOANS_CC,
      from: SENDGRID_FROM_EMAIL,
      subject: `[FlexiLoans] Document Collection - ${phone}`,
      html: htmlContent,
      replyTo: SENDGRID_FROM_EMAIL,
    };

    await sgMail.send(msg);

    logger.log('info', 'FLEXILOANS_EMAIL_SENT', `Document email sent for ${phone}`, {
      phone: phone.slice(-4),
      recipient: FLEXILOANS_TO,
      cc: FLEXILOANS_CC.length,
      type: 'email_service',
    });

    return {
      success: true,
      message: 'Document email sent to FlexiLoans team',
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    logger.log('error', 'EMAIL_SEND_ERROR', `Failed to send email: ${error.message}`, {
      error: error.message,
      type: 'email_error',
    });
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Send generic email (for other use cases)
 */
export async function sendEmail(options) {
  try {
    const { to, cc, subject, html, from = SENDGRID_FROM_EMAIL } = options;

    if (!SENDGRID_API_KEY) {
      return { success: false, error: 'Email service not configured' };
    }

    const msg = {
      to,
      cc,
      from,
      subject,
      html,
    };

    await sgMail.send(msg);

    logger.log('info', 'EMAIL_SENT', `Email sent to ${to}`, {
      to,
      subject,
      type: 'email_service',
    });

    return {
      success: true,
      message: 'Email sent successfully',
    };
  } catch (error) {
    logger.log('error', 'EMAIL_SEND_ERROR', `Email send failed: ${error.message}`, {
      error: error.message,
      type: 'email_error',
    });
    return {
      success: false,
      error: error.message,
    };
  }
}

export default {
  sendFlexiLoansDocumentEmail,
  sendEmail,
};
