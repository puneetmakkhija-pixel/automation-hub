import ananta from '../clients/anantaClient.js';
import supabase from '../clients/supabaseClient.js';
import FormHandlers from './formHandlers.js';

class PhaseHandlers {
  static async handleProductSelection(state, userMessage) {
    const response = userMessage.trim().toLowerCase();

    if (response.includes('yes') || response.includes('1') || response.includes('banking')) {
      await supabase.moveToPhase(state.phone_number, 'eligibility_check', {
        product_type: 'banking'
      });

      return {
        message: '✅ Great! Now let\'s check your eligibility.\n\nWhat\'s your business registration pincode? (e.g., 400001)',
        nextPhase: 'eligibility_check',
        messageType: 'text'
      };
    } else if (response.includes('no') || response.includes('2') || response.includes('non-banking')) {
      await supabase.moveToPhase(state.phone_number, 'eligibility_check', {
        product_type: 'non_banking'
      });

      return {
        message: '✅ No problem! We have options for you too.\n\nWhat\'s your business registration pincode?',
        nextPhase: 'eligibility_check',
        messageType: 'text'
      };
    } else {
      return {
        message: '❌ Please reply:\n1️⃣ Yes, I have a bank account\n2️⃣ No, I don\'t have a bank account',
        nextPhase: 'product_selection',
        messageType: 'text',
        validation: { valid: false, reason: 'Invalid choice' }
      };
    }
  }

  static async handleEligibilityCheck(state, userMessage) {
    const pincode = userMessage.trim();

    if (!/^\d{6}$/.test(pincode)) {
      return {
        message: '❌ Invalid pincode. Please enter 6 digits (e.g., 400001)',
        nextPhase: 'eligibility_check',
        messageType: 'text',
        validation: { valid: false, reason: 'Invalid pincode format' }
      };
    }

    const isServiceable = true;

    if (!isServiceable) {
      return {
        message: `❌ Sorry, we don't serve pincode ${pincode} yet.\n\nTry another pincode or check back later.`,
        nextPhase: 'eligibility_check',
        messageType: 'text',
        validation: { valid: false, reason: 'Pincode not serviceable' }
      };
    }

    await supabase.moveToPhase(state.phone_number, 'form_personal', {
      pincode: pincode
    });

    return {
      message: '✅ Pincode verified!\n\nWhat\'s your annual business income (in ₹)?\nExample: 1800000',
      nextPhase: 'form_personal',
      messageType: 'text'
    };
  }

  static async handleLenderSelection(state, userMessage) {
    const eligibleLenders = [
      { name: 'Poonawala', minAmount: 100000, maxAmount: 2500000, rate: '12-18%', emi: 3200 },
      { name: 'Hero FinCorp', minAmount: 50000, maxAmount: 2000000, rate: '13-20%', emi: 3100 },
      { name: 'HDFC Jumbo', minAmount: 500000, maxAmount: 5000000, rate: '10-15%', emi: 3050 }
    ];

    const choice = userMessage.trim().toUpperCase();
    const selectedLender = eligibleLenders.find(l => l.name.includes(choice) || choice === '1' || choice === '2' || choice === '3');

    if (!selectedLender) {
      const buttons = eligibleLenders.map((l, idx) => ({
        title: `${idx + 1}. ${l.name} @ ${l.rate} (EMI: ₹${l.emi})`
      }));

      return {
        message: '💰 Which lender would you prefer?',
        buttons,
        nextPhase: 'lender_selection',
        messageType: 'interactive',
        validation: { valid: false, reason: 'Invalid lender selection' }
      };
    }

    await supabase.moveToPhase(state.phone_number, 'form_personal', {
      selected_lender: selectedLender.name,
      eligible_lenders: eligibleLenders.map(l => l.name)
    });

    return {
      message: `✅ Great choice! ${selectedLender.name} it is.\n\nNow let's complete your application.\n\n📝 What's your full name?`,
      nextPhase: 'form_personal',
      messageType: 'text'
    };
  }

  static async handlePersonalDetails(state, userMessage) {
    const name = userMessage.trim();

    if (name.length < 3 || /\d/.test(name)) {
      return {
        message: '❌ Please enter a valid name (minimum 3 characters, no numbers)',
        nextPhase: 'form_personal',
        messageType: 'text',
        validation: { valid: false, reason: 'Invalid name format' }
      };
    }

    await supabase.moveToPhase(state.phone_number, 'form_business', {
      full_name: name
    });

    return {
      message: `✅ Nice to meet you, ${name}!\n\n📊 What's your business type?\n1️⃣ Retail\n2️⃣ Manufacturing\n3️⃣ Services\n4️⃣ Import/Export\n5️⃣ Other`,
      nextPhase: 'form_business',
      messageType: 'text'
    };
  }

  static async handleBusinessDetails(state, userMessage) {
    const step = state.form_data?.business_step || 1;
    return await FormHandlers.handleBusinessDetailsForm(state, userMessage, step);
  }

  static async handleDocuments(state, userMessage) {
    return await FormHandlers.handleDocumentsForm(state, userMessage);
  }

  static async handleKYCVerification(state, userMessage) {
    return {
      message: 'KYC verification (background processing)',
      nextPhase: 'lender_submission',
      messageType: 'text'
    };
  }

  static async handleLenderSubmission(state, userMessage) {
    return {
      message: 'Lender submission (Phase 2 integration)',
      nextPhase: 'approval',
      messageType: 'text'
    };
  }
}

export default PhaseHandlers;
