import rejectionTrackingClient from './lib/llm/rejectionTrackingClient.js';
import suppressionAnalysisClient from './lib/llm/suppressionAnalysisClient.js';
import reengagementClient from './lib/llm/reengagementClient.js';

const testPhoneNumber = '+919876543210';
const testLenderId = 'poonawala';

async function runE2ETest() {
  console.log('\n========== END-TO-END TEST ==========\n');

  try {
    // Phase 3.5c: Capture rejection
    console.log('Step 1: Capturing rejection...');
    const rejectionResult = await rejectionTrackingClient.captureRejection({
      phone_number: testPhoneNumber,
      application_id: 'test-app-001',
      lender_id: testLenderId,
      rejection_reason: 'cibil_low',
      rejection_message: 'CIBIL score is below minimum threshold',
      rejected_bureau_vars: {
        cibil_score: 650,
        hunter_score: 750,
        dpd: 0
      },
      rejected_demographic_vars: {
        age: 32,
        annual_income: 400000,
        pincode: '400001'
      }
    });

    if (!rejectionResult.success) {
      console.error('❌ Rejection capture failed:', rejectionResult.error);
      return;
    }
    console.log('✅ Rejection captured:', rejectionResult.message);

    // Add a small delay to ensure database commit
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Phase 3.5d: Analyze rejection patterns & get recommendations
    console.log('\nStep 2: Analyzing rejection patterns for recalibration...');
    const analysisResult = await suppressionAnalysisClient.analyzeRejectionPatternsForRecalibration(
      24,
      [testLenderId]
    );

    if (!analysisResult.success) {
      console.error('❌ Analysis failed:', analysisResult.error);
      return;
    }

    console.log('✅ Analysis complete');
    if (analysisResult.recommendation) {
      console.log('   - Confidence:', analysisResult.recommendation.confidence);
      console.log('   - Key insights:', analysisResult.recommendation.key_insights);
    } else {
      console.log('   - No recommendation generated (may need more data)');
    }

    // Phase 3.5e: Find newly eligible users & re-engage
    console.log('\nStep 3: Finding newly eligible users...');
    const eligibleResult = await reengagementClient.findNewlyEligibleUsers(24);

    if (!eligibleResult.success) {
      console.error('❌ Eligibility check failed:', eligibleResult.error);
      return;
    }

    console.log(`✅ Found ${eligibleResult.count || 0} newly eligible users`);

    if (eligibleResult.count > 0) {
      console.log('\nStep 4: Sending re-engagement campaign...');
      const campaignResult = await reengagementClient.sendReengagementCampaign(
        eligibleResult.newly_eligible_users
      );

      if (!campaignResult.success) {
        console.error('❌ Campaign failed:', campaignResult.error);
        return;
      }

      console.log('✅ Campaign completed');
      console.log('   - Sent:', campaignResult.results.sent);
      console.log('   - Failed:', campaignResult.results.failed);
      console.log('   - WhatsApp:', campaignResult.results.channels.whatsapp);
    }

    // Get metrics
    console.log('\nStep 5: Fetching re-engagement metrics...');
    const metricsResult = await reengagementClient.getReengagementMetrics(24);

    if (!metricsResult.success) {
      console.error('❌ Metrics fetch failed:', metricsResult.error);
      return;
    }

    console.log('✅ Metrics retrieved');
    console.log('   - Campaigns sent:', metricsResult.metrics.campaigns_sent);
    console.log('   - Responses:', metricsResult.metrics.responses_received);
    console.log('   - Conversion rate:', metricsResult.metrics.conversion_rate + '%');

    console.log('\n========== TEST COMPLETE ==========\n');
  } catch (error) {
    console.error('❌ Test error:', error.message);
  }
}

runE2ETest();
