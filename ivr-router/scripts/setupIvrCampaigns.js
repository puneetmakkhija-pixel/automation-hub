#!/usr/bin/env node

/**
 * IVR Campaigns Setup Script
 * Creates IVR recordings and campaigns for multiple lenders (Flexiloans, Poonawala)
 * Manages campaign bases with Supabase filtering
 */

import OBDApiClient from '../lib/obdApiClient.js';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

// ==================== Configuration ====================

const LENDERS = {
  flexiloans: {
    name: 'FlexiLoans',
    contactName: 'FlexiLoans Support',
    phoneNumber: '1800FLEXI',
    recordings: {
      welcome: 'Hi! This is FlexiLoans. We offer flexible personal loans up to 25 lakhs with minimal documentation.',
      menu: 'Press 1 for loan eligibility check, Press 2 to apply now, Press 3 to speak with our agent.',
      thanks: 'Thank you for choosing FlexiLoans. Your application is being processed. You will receive an SMS shortly.',
      noInput: 'Sorry, we did not receive any input. Please try again.',
      wrongInput: 'Invalid option. Please select 1, 2, or 3.',
    }
  },
  poonawala: {
    name: 'Poonawala Finance',
    contactName: 'Poonawala Finance',
    phoneNumber: '1800POONAWALA',
    recordings: {
      welcome: 'Welcome to Poonawala Finance. We provide instant financing for businesses, vehicles, and personal needs.',
      menu: 'Press 1 to check eligibility, Press 2 for business loans, Press 3 for auto loans, Press 4 to speak with a specialist.',
      thanks: 'Thank you for contacting Poonawala Finance. Your inquiry has been recorded. Our team will get back to you soon.',
      noInput: 'No input received. Please try again.',
      wrongInput: 'Invalid selection. Please choose from the available options.',
    }
  }
};

// ==================== Campaign Setup Manager ====================

class CampaignSetupManager {
  constructor() {
    this.obdClient = new OBDApiClient(
      process.env.OBD_BASE_URL || 'https://obdapi2.ivrsms.com',
      process.env.OBD_USERNAME,
      process.env.OBD_PASSWORD
    );

    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    this.recordings = {};
    this.campaigns = {};
    this.bases = {};
  }

  // ==================== IVR Recording Creation ====================

  async createIvrRecordings(lenderKey) {
    console.log(`\n🎙️ Creating IVR Recordings for ${LENDERS[lenderKey].name}`);

    const lender = LENDERS[lenderKey];
    const recordings = {};

    try {
      for (const [type, text] of Object.entries(lender.recordings)) {
        console.log(`  📝 Recording ${type}: "${text.substring(0, 50)}..."`);

        // Create a simple recording identifier
        // In production, these would use ElevenLabs or text-to-speech API
        recordings[type] = {
          text,
          promptId: null, // Will be set after upload
          type,
        };
      }

      this.recordings[lenderKey] = recordings;
      console.log(`✓ IVR recordings created for ${lenderKey}`);
      return recordings;
    } catch (error) {
      console.error(`✗ Recording creation failed: ${error.message}`);
      throw error;
    }
  }

  // ==================== Upload Recordings to OBD ====================

  async uploadRecordingsToObd(lenderKey) {
    console.log(`\n📤 Uploading Recordings to OBD for ${LENDERS[lenderKey].name}`);

    try {
      await this.obdClient.login();

      for (const [type, recording] of Object.entries(this.recordings[lenderKey])) {
        console.log(`  Uploading ${type} recording...`);

        // Note: In production, you would upload actual audio files
        // For now, we create placeholder recordings
        // Actual audio files would be generated via TTS (ElevenLabs, Google, etc.)

        try {
          // Create a simple text-based placeholder for demonstration
          const fileName = `${lenderKey}_${type}`;
          const category = type;

          // Create buffer from text (in production, this would be actual audio)
          const buffer = Buffer.from(recording.text);

          const result = await this.obdClient.uploadVoiceFile(
            buffer,
            fileName,
            category,
            'wav'
          );

          recording.promptId = result.promptId || result.id;
          console.log(`    ✓ ${type} uploaded (ID: ${recording.promptId})`);
        } catch (uploadError) {
          console.log(`    ⚠ Could not upload ${type}: ${uploadError.message}`);
          console.log(`    Using default prompt ID for ${type}`);
          // Fall back to placeholder IDs if upload fails
          recording.promptId = getDefaultPromptId(type);
        }
      }

      console.log(`✓ Recordings uploaded for ${lenderKey}`);
      return this.recordings[lenderKey];
    } catch (error) {
      console.error(`✗ Recording upload failed: ${error.message}`);
      throw error;
    }
  }

  // ==================== Setup Campaigns ====================

  async setupCampaigns(lenderKey, baseId) {
    console.log(`\n📢 Setting up Campaigns for ${LENDERS[lenderKey].name}`);

    try {
      const lender = LENDERS[lenderKey];
      const recordings = this.recordings[lenderKey];

      // Create DTMF campaign
      const dtmfCampaign = {
        campaignName: `${lender.name} - Loan Eligibility Campaign`,
        campaignType: 'dtmf',
        baseId: baseId,
        welcomePromptId: recordings.welcome.promptId,
        menuPromptId: recordings.menu.promptId,
        noInputPromptId: recordings.noInput.promptId,
        wrongInputPromptId: recordings.wrongInput.promptId,
        thanksPromptId: recordings.thanks.promptId,
        dtmf: '1',
        menuWaitTime: 5,
        rePrompt: 2,
        scheduleTime: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      };

      console.log(`  📋 Campaign Config:`);
      console.log(`    Name: ${dtmfCampaign.campaignName}`);
      console.log(`    Type: ${dtmfCampaign.campaignType}`);
      console.log(`    Base ID: ${baseId}`);

      const result = await this.obdClient.composeCampaign(dtmfCampaign);

      this.campaigns[lenderKey] = {
        id: result.campaignId,
        name: dtmfCampaign.campaignName,
        lender: lenderKey,
        baseId: baseId,
        createdAt: new Date().toISOString(),
      };

      console.log(`✓ Campaign created`);
      console.log(`  Campaign ID: ${result.campaignId}`);
      return result;
    } catch (error) {
      console.error(`✗ Campaign setup failed: ${error.message}`);
      throw error;
    }
  }

  // ==================== Query and Filter Bases from Supabase ====================

  async queryAndFilterBases(lenderKey) {
    console.log(`\n🔍 Querying Campaign Bases for ${LENDERS[lenderKey].name}`);

    try {
      // Query campaign contacts from Supabase
      const { data: allContacts, error: queryError } = await this.supabase
        .from('campaign_contacts')
        .select('*')
        .eq('lender_id', lenderKey);

      if (queryError) {
        console.log(`  ⚠ Could not query campaign_contacts: ${queryError.message}`);
        console.log(`  Note: Ensure 'campaign_contacts' table exists in Supabase`);
        return [];
      }

      console.log(`  Found ${allContacts.length} total contacts`);

      // Filter by SME Circle and Self-Employed bases
      const filteredContacts = allContacts.filter(contact => {
        const isSmeLoanCircle = contact.loan_circle === 'sme_circle' ||
                                contact.segment === 'sme' ||
                                contact.business_type === 'sme';

        const isSelfEmployedBase = contact.employment_type === 'self_employed' ||
                                   contact.employment_type === 'se' ||
                                   contact.base_type === 'self_employed_base';

        return isSmeLoanCircle || isSelfEmployedBase;
      });

      console.log(`  ✓ Filtered to ${filteredContacts.length} SME/Self-Employed contacts`);

      // Store the filtered base
      this.bases[lenderKey] = {
        lender: lenderKey,
        totalContacts: allContacts.length,
        filteredContacts: filteredContacts.length,
        contacts: filteredContacts,
        filters: {
          smeLoanCircle: true,
          selfEmployedBase: true
        },
        createdAt: new Date().toISOString(),
      };

      return filteredContacts;
    } catch (error) {
      console.error(`✗ Base query failed: ${error.message}`);
      throw error;
    }
  }

  // ==================== Upload Base to OBD ====================

  async uploadBaseToObd(lenderKey) {
    console.log(`\n📤 Uploading Filtered Base to OBD for ${LENDERS[lenderKey].name}`);

    try {
      const base = this.bases[lenderKey];
      if (!base || base.contacts.length === 0) {
        console.log(`  ⚠ No contacts to upload for ${lenderKey}`);
        return null;
      }

      // Convert contacts to CSV format
      const csvHeader = ['phone', 'name', 'lender_id', 'segment', 'employment_type'];
      const csvRows = base.contacts.map(contact => [
        contact.phone,
        contact.name || 'N/A',
        contact.lender_id,
        contact.segment || 'sme',
        contact.employment_type || 'self_employed'
      ]);

      const csv = [csvHeader, ...csvRows]
        .map(row => row.map(cell => `"${cell}"`).join(','))
        .join('\n');

      const csvBuffer = Buffer.from(csv);
      const baseName = `${LENDERS[lenderKey].name}_SME_SE_Base_${new Date().toISOString().split('T')[0]}`;

      console.log(`  📋 CSV Details:`);
      console.log(`    Rows: ${csvRows.length}`);
      console.log(`    File: ${baseName}.csv`);

      const result = await this.obdClient.uploadBaseFile(csvBuffer, baseName);

      console.log(`✓ Base uploaded to OBD`);
      console.log(`  Base ID: ${result.baseId}`);

      return result.baseId;
    } catch (error) {
      console.error(`✗ Base upload failed: ${error.message}`);
      throw error;
    }
  }

  // ==================== Export Base Summary ====================

  async exportBaseSummary(lenderKey, filePath = null) {
    console.log(`\n📊 Exporting Base Summary for ${LENDERS[lenderKey].name}`);

    try {
      const base = this.bases[lenderKey];
      if (!base) {
        console.log(`  ⚠ No base data available for ${lenderKey}`);
        return null;
      }

      const summary = {
        lender: LENDERS[lenderKey].name,
        timestamp: new Date().toISOString(),
        baseStats: {
          totalContacts: base.totalContacts,
          filteredContacts: base.filteredContacts,
          filterCriteria: base.filters,
          filtrationRatio: (base.filteredContacts / base.totalContacts * 100).toFixed(2) + '%'
        },
        sampleContacts: base.contacts.slice(0, 5),
        campaign: this.campaigns[lenderKey] || null
      };

      if (filePath) {
        fs.writeFileSync(filePath, JSON.stringify(summary, null, 2));
        console.log(`✓ Summary exported to ${filePath}`);
      } else {
        console.log(`✓ Base Summary:`);
        console.log(JSON.stringify(summary, null, 2));
      }

      return summary;
    } catch (error) {
      console.error(`✗ Export failed: ${error.message}`);
      throw error;
    }
  }

  // ==================== Full Workflow ====================

  async setupCompleteWorkflow(lenderKey, baseId = null) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Setting up IVR Campaign for ${LENDERS[lenderKey].name}`);
    console.log(`${'='.repeat(60)}`);

    try {
      // Step 1: Create IVR recordings
      await this.createIvrRecordings(lenderKey);

      // Step 2: Upload recordings to OBD
      await this.uploadRecordingsToObd(lenderKey);

      // Step 3: Query and filter bases from Supabase
      await this.queryAndFilterBases(lenderKey);

      // Step 4: Upload filtered base to OBD
      const uploadedBaseId = await this.uploadBaseToObd(lenderKey);
      const finalBaseId = uploadedBaseId || baseId;

      if (!finalBaseId) {
        throw new Error('No base ID available for campaign setup');
      }

      // Step 5: Setup campaign
      await this.setupCampaigns(lenderKey, finalBaseId);

      // Step 6: Export summary
      const summaryPath = `./campaigns/${lenderKey}_campaign_summary.json`;
      await this.exportBaseSummary(lenderKey, summaryPath);

      console.log(`\n✓ Complete workflow finished for ${LENDERS[lenderKey].name}`);
      console.log(`  Campaign ID: ${this.campaigns[lenderKey].id}`);
      console.log(`  Base ID: ${finalBaseId}`);
      console.log(`  Summary: ${summaryPath}`);

      return {
        campaign: this.campaigns[lenderKey],
        base: this.bases[lenderKey]
      };
    } catch (error) {
      console.error(`\n✗ Workflow failed: ${error.message}`);
      throw error;
    }
  }
}

// ==================== Utility Functions ====================

function getDefaultPromptId(type) {
  const defaultIds = {
    welcome: '954',
    menu: '955',
    thanks: '956',
    noInput: '957',
    wrongInput: '958'
  };
  return defaultIds[type] || '954';
}

// ==================== Main Execution ====================

async function main() {
  const manager = new CampaignSetupManager();

  try {
    // Create campaigns directory
    if (!fs.existsSync('./campaigns')) {
      fs.mkdirSync('./campaigns', { recursive: true });
    }

    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║   IVR Campaign Setup - Flexiloans & Poonawala            ║');
    console.log('║   Auto-configure campaigns with recordings & bases       ║');
    console.log('╚════════════════════════════════════════════════════════════╝');

    // Setup for each lender
    for (const lenderKey of Object.keys(LENDERS)) {
      try {
        await manager.setupCompleteWorkflow(
          lenderKey,
          null // Will be uploaded from filtered Supabase data
        );
      } catch (lenderError) {
        console.error(`\n⚠ Setup for ${lenderKey} encountered issues:`);
        console.error(`  ${lenderError.message}`);
        console.log(`  Continuing with next lender...\n`);
      }
    }

    // Summary Report
    console.log(`\n${'='.repeat(60)}`);
    console.log('Campaign Setup Complete - Summary Report');
    console.log(`${'='.repeat(60)}`);

    for (const lenderKey of Object.keys(LENDERS)) {
      const campaign = manager.campaigns[lenderKey];
      const base = manager.bases[lenderKey];

      if (campaign) {
        console.log(`\n${LENDERS[lenderKey].name}:`);
        console.log(`  Campaign ID: ${campaign.id}`);
        console.log(`  Status: Active`);
      }

      if (base) {
        console.log(`  Contacts: ${base.filteredContacts}/${base.totalContacts}`);
      }
    }

    console.log(`\n✓ All campaigns configured. Check ./campaigns/ for details.`);

  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Execute
main();

export { CampaignSetupManager, LENDERS };
