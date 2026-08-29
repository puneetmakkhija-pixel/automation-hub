/**
 * Email Service
 * Handles sending emails via connected Gmail account
 */

import logger from '../logging.js';

// FlexiLoans document submission recipients
const FLEXILOANS_TO = 'dadocs@flexiloans.com';
const FLEXILOANS_CC = ['sharda.p@buddyloan.com', 'rachit.saini@buddyloan.com'];

/**
 * Send FlexiLoans document collection email via Gmail MCP
 * Uses the connected Gmail account to send emails
 * @param {Object} options
 * @param {string} options.phone - Customer phone number
 * @param {string} options.name - Customer name
 * @param {Object} options.documents - Document data {panUrl, aadharUrl, bankStatementUrl}
 * @param {Object} options.metadata - Additional metadata
 */
export async function sendFlexiLoansDocumentEmail(options) {
  try {
    const { phone, name, documents, metadata = {} } = options;

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

    // Note: In production, this is called via MCP from the frontend
    // The backend stores the submission, and the frontend handles Gmail sending
    logger.log('info', 'FLEXILOANS_EMAIL_PREPARED', `Email prepared for ${phone}`, {
      phone: phone.slice(-4),
      recipient: FLEXILOANS_TO,
      cc: FLEXILOANS_CC.length,
      type: 'email_service',
    });

    return {
      success: true,
      message: 'Document email ready to send via Gmail',
      emailData: {
        to: [FLEXILOANS_TO],
        cc: FLEXILOANS_CC,
        subject: `[FlexiLoans] Document Collection - ${phone}`,
        htmlBody: htmlContent,
      },
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    logger.log('error', 'EMAIL_PREP_ERROR', `Failed to prepare email: ${error.message}`, {
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
 * Returns email data structure for Gmail MCP sending
 */
export async function sendEmail(options) {
  try {
    const { to, cc, subject, html } = options;

    logger.log('info', 'EMAIL_PREPARED', `Email prepared for ${to}`, {
      to,
      subject,
      type: 'email_service',
    });

    return {
      success: true,
      message: 'Email ready to send via Gmail',
      emailData: {
        to: Array.isArray(to) ? to : [to],
        cc: cc || [],
        subject,
        htmlBody: html,
      },
    };
  } catch (error) {
    logger.log('error', 'EMAIL_PREP_ERROR', `Email preparation failed: ${error.message}`, {
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
