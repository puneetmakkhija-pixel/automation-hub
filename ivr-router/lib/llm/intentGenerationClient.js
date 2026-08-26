import Anthropic from '@anthropic-ai/sdk';
import supabase from '../clients/supabaseClient.js';

class IntentGenerationClient {
  constructor() {
    this.client = new Anthropic({
      apiKey: process.env.CLAUDE_API_KEY,
    });
    this.model = 'claude-3-5-sonnet-20241022';
  }

  async generateIntent(userProfile) {
    const prompt = this.buildPrompt(userProfile);

    try {
      const message = await this.client.messages.create({
        model: this.model,
        max_tokens: 500,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      });

      const responseText = message.content[0].type === 'text' ? message.content[0].text : '';
      const intent = JSON.parse(responseText);

      return {
        valid: true,
        intent: intent.intent,
        intent_confidence: intent.intent_confidence,
        risk_profile: intent.risk_profile,
        completion_probability: intent.completion_probability,
        messaging_angle: intent.messaging_angle,
        recommended_amount: intent.recommended_amount,
        recommended_lender: intent.recommended_lender,
        personalized_message: intent.personalized_message,
        reasoning: intent.reasoning
      };
    } catch (error) {
      console.error('[IntentGeneration] Claude API error:', error.message);
      return {
        valid: false,
        error: error.message
      };
    }
  }

  buildPrompt(userProfile) {
    return `You are a loan origination AI expert. Analyze this user profile and generate a structured intent analysis.

USER PROFILE:
${JSON.stringify(userProfile, null, 2)}

TASK: Generate a JSON response with the following fields:
1. intent - User's likely loan purpose: 'working_capital', 'debt_consolidation', 'expansion', 'equipment', 'emergency', or 'other'
2. intent_confidence - Confidence level (0.0-1.0)
3. risk_profile - 'low', 'medium', or 'high' based on business stage, credit score, and income
4. completion_probability - Likelihood they'll complete application (0.0-1.0)
5. messaging_angle - Best approach to drive completion: 'cash_flow_smooth', 'business_growth', 'debt_relief', 'seasonal_need', 'emergency_support'
6. recommended_amount - Loan amount in rupees (based on income and business stage)
7. recommended_lender - Best lender match: 'poonawala', 'hero_fincorp', 'hdfc', or 'other'
8. personalized_message - Short, compelling WhatsApp message (max 160 chars) to drive application
9. reasoning - Brief explanation of the analysis

CRITERIA FOR ANALYSIS:
- If business_age < 1 year OR CIBIL < 650: risk_profile = 'high'
- If business_age 1-3 years OR CIBIL 650-700: risk_profile = 'medium'
- If business_age > 3 years AND CIBIL > 700: risk_profile = 'low'
- Completion probability: Add 0.15 for low_risk, subtract 0.15 for high_risk
- Recommended amount: income * 0.6 to 0.8 based on risk_profile
- Lender selection: Poonawala for low_risk, Hero for medium_risk, HDFC for high_risk with strong income

RESPOND WITH JSON ONLY (no markdown, no explanation):
{
  "intent": "...",
  "intent_confidence": 0.0,
  "risk_profile": "...",
  "completion_probability": 0.0,
  "messaging_angle": "...",
  "recommended_amount": 0,
  "recommended_lender": "...",
  "personalized_message": "...",
  "reasoning": "..."
}`;
  }

  async storeIntent(phoneNumber, intent) {
    try {
      const { data, error } = await supabase
        .from('user_intents')
        .insert({
          phone_number: phoneNumber,
          intent: intent.intent,
          intent_confidence: intent.intent_confidence,
          risk_profile: intent.risk_profile,
          completion_probability: intent.completion_probability,
          messaging_angle: intent.messaging_angle,
          recommended_amount: intent.recommended_amount,
          recommended_lender: intent.recommended_lender,
          personalized_message: intent.personalized_message,
          reasoning: intent.reasoning,
          created_at: new Date().toISOString()
        });

      if (error) {
        console.error('[IntentGeneration] Supabase insert error:', error.message);
        return { valid: false, error: error.message };
      }

      return { valid: true, data };
    } catch (error) {
      console.error('[IntentGeneration] Storage error:', error.message);
      return { valid: false, error: error.message };
    }
  }

  async getUserIntent(phoneNumber) {
    try {
      const { data, error } = await supabase
        .from('user_intents')
        .select('*')
        .eq('phone_number', phoneNumber)
        .order('created_at', { ascending: false })
        .limit(1);

      if (error) {
        console.error('[IntentGeneration] Retrieval error:', error.message);
        return null;
      }

      return data && data.length > 0 ? data[0] : null;
    } catch (error) {
      console.error('[IntentGeneration] Query error:', error.message);
      return null;
    }
  }
}

export default new IntentGenerationClient();
