/**
 * FlexiLoans Document Submission Routes
 * Handles document collection and email routing to FlexiLoans team
 */

import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { sendFlexiLoansDocumentEmail } from '../services/emailService.js';
import logger from '../logging.js';

const router = express.Router();

// Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabase = null;

if (supabaseUrl && supabaseServiceRoleKey) {
  supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
}

// ==================== POST: Submit documents and send to FlexiLoans ====================
router.post('/submit-documents', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase not configured',
      });
    }

    const { phone, name, panUrl, aadharUrl, bankStatementUrl, metadata } = req.body;

    if (!phone || !name) {
      return res.status(400).json({
        success: false,
        error: 'phone and name are required',
      });
    }

    // Store document submission in database
    const { data: submission, error: dbError } = await supabase
      .from('flexiloans_document_submissions')
      .insert({
        phone_number: phone,
        customer_name: name,
        pan_url: panUrl || null,
        aadhar_url: aadharUrl || null,
        bank_statement_url: bankStatementUrl || null,
        status: 'submitted',
        metadata: metadata || {},
        submitted_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (dbError) {
      throw new Error(`Failed to store submission: ${dbError.message}`);
    }

    // Send email to FlexiLoans team
    const emailResult = await sendFlexiLoansDocumentEmail({
      phone,
      name,
      documents: {
        panUrl,
        aadharUrl,
        bankStatementUrl,
      },
      metadata,
    });

    if (!emailResult.success) {
      logger.log('warn', 'FLEXILOANS_EMAIL_FAILED', `Email not sent for ${phone}`, {
        phone: phone.slice(-4),
        error: emailResult.error,
        type: 'flexiloans_error',
      });
    }

    logger.log('info', 'FLEXILOANS_DOCUMENTS_SUBMITTED', `Documents submitted for ${phone}`, {
      phone: phone.slice(-4),
      name,
      documentsCount: [panUrl, aadharUrl, bankStatementUrl].filter(Boolean).length,
      emailSent: emailResult.success,
      type: 'flexiloans_submission',
    });

    return res.status(201).json({
      success: true,
      data: {
        submissionId: submission.id,
        phone,
        name,
        status: 'submitted',
        emailSent: emailResult.success,
        emailStatus: emailResult.message,
      },
      message: 'Documents submitted and email sent to FlexiLoans team',
    });
  } catch (error) {
    logger.log('error', 'FLEXILOANS_SUBMISSION_ERROR', `Failed to submit documents: ${error.message}`, {
      error: error.message,
      type: 'flexiloans_error',
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== GET: Get submission status ====================
router.get('/submission-status/:phone', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase not configured',
      });
    }

    const { phone } = req.params;

    const { data, error } = await supabase
      .from('flexiloans_document_submissions')
      .select('*')
      .eq('phone_number', phone)
      .order('submitted_at', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw new Error(`Failed to get submission: ${error.message}`);
    }

    return res.json({
      success: true,
      data: data || {
        status: 'no_submission',
        message: 'No submission found for this customer',
      },
    });
  } catch (error) {
    logger.log('error', 'FLEXILOANS_STATUS_ERROR', `Failed to get submission status: ${error.message}`, {
      error: error.message,
      type: 'flexiloans_error',
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== GET: Get all FlexiLoans submissions (paginated) ====================
// The dashboard used to call this with no limit/offset at all, which pulled the
// whole table on every page load and again on every "Docs" tab switch. It now
// takes limit/offset like GET /api/leads already documents, clamped to a sane
// range so a stray ?limit=100000 can't turn this back into a full-table scan.
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

router.get('/submissions', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Supabase not configured',
      });
    }

    const limit = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_PAGE_SIZE)
    );
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    const { data, error } = await supabase
      .from('flexiloans_document_submissions')
      .select('*')
      .order('submitted_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      throw new Error(`Failed to get submissions: ${error.message}`);
    }

    logger.log('info', 'FLEXILOANS_SUBMISSIONS_LIST', `Retrieved ${data?.length || 0} submissions`, {
      count: data?.length || 0,
      limit,
      offset,
      type: 'flexiloans_management',
    });

    return res.json({
      success: true,
      data: data || [],
      count: data?.length || 0,
      pagination: {
        limit,
        offset,
        // We deliberately avoid a separate COUNT(*) query here (it would double
        // the cost of every page load); a full page implies there may be more.
        hasMore: (data?.length || 0) === limit,
      },
    });
  } catch (error) {
    logger.log('error', 'FLEXILOANS_SUBMISSIONS_ERROR', `Failed to list submissions: ${error.message}`, {
      error: error.message,
      type: 'flexiloans_error',
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
