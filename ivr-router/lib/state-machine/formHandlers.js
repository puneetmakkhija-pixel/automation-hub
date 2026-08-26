import supabase from '../clients/supabaseClient.js';

class FormHandlers {
  // PHASE 4: Personal Details - Multi-step form
  static async handlePersonalDetailsForm(state, userMessage, step = 1) {
    const formData = state.form_data || {};

    if (step === 1) {
      // Already collected name in previous phase
      return {
        message: '📞 What\'s your contact email address?',
        nextPhase: 'form_personal',
        messageType: 'text',
        step: 2
      };
    }

    if (step === 2) {
      // Email validation
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(userMessage.trim())) {
        return {
          message: '❌ Please enter a valid email address (e.g., rajesh@example.com)',
          nextPhase: 'form_personal',
          messageType: 'text',
          step: 2,
          validation: { valid: false, reason: 'Invalid email format' }
        };
      }

      await supabase.moveToPhase(state.phone_number, 'form_personal', {
        email: userMessage.trim()
      });

      return {
        message: '✅ Got it!\n\n👤 What\'s your age?',
        nextPhase: 'form_personal',
        messageType: 'text',
        step: 3
      };
    }

    if (step === 3) {
      // Age validation
      const age = parseInt(userMessage.trim());
      if (isNaN(age) || age < 18 || age > 100) {
        return {
          message: '❌ Please enter a valid age (18-100)',
          nextPhase: 'form_personal',
          messageType: 'text',
          step: 3,
          validation: { valid: false, reason: 'Invalid age' }
        };
      }

      await supabase.moveToPhase(state.phone_number, 'form_business', {
        age: age
      });

      return {
        message: '✅ Perfect!\n\n📊 What\'s your business type?',
        buttons: [
          { title: '1️⃣ Retail' },
          { title: '2️⃣ Manufacturing' },
          { title: '3️⃣ Services' },
          { title: '4️⃣ Import/Export' },
          { title: '5️⃣ Other' }
        ],
        nextPhase: 'form_business',
        messageType: 'interactive'
      };
    }
  }

  // PHASE 5: Business Details - Multi-step form
  static async handleBusinessDetailsForm(state, userMessage, step = 1) {
    const formData = state.form_data || {};
    const businessTypes = ['Retail', 'Manufacturing', 'Services', 'Import/Export', 'Other'];

    if (step === 1) {
      // Business type selection
      const choice = userMessage.trim();
      const typeIndex = parseInt(choice) - 1;

      if (isNaN(typeIndex) || typeIndex < 0 || typeIndex > 4) {
        return {
          message: '❌ Please select a valid option (1-5)',
          nextPhase: 'form_business',
          messageType: 'text',
          step: 1,
          validation: { valid: false, reason: 'Invalid business type selection' }
        };
      }

      await supabase.moveToPhase(state.phone_number, 'form_business', {
        business_type: businessTypes[typeIndex]
      });

      return {
        message: '✅ Got it!\n\n💰 What\'s your annual business income? (in ₹)\nExample: 1800000',
        nextPhase: 'form_business',
        messageType: 'text',
        step: 2
      };
    }

    if (step === 2) {
      // Annual income validation
      const income = parseInt(userMessage.trim().replace(/,/g, ''));
      if (isNaN(income) || income < 100000 || income > 50000000) {
        return {
          message: '❌ Please enter a valid annual income (₹100,000 to ₹5,00,00,000)',
          nextPhase: 'form_business',
          messageType: 'text',
          step: 2,
          validation: { valid: false, reason: 'Invalid income range' }
        };
      }

      await supabase.moveToPhase(state.phone_number, 'form_business', {
        annual_income: income
      });

      return {
        message: '💯 Great!\n\n💸 How much loan amount do you need? (in ₹)\nExample: 1200000',
        nextPhase: 'form_business',
        messageType: 'text',
        step: 3
      };
    }

    if (step === 3) {
      // Loan amount validation
      const loanAmount = parseInt(userMessage.trim().replace(/,/g, ''));
      if (isNaN(loanAmount) || loanAmount < 50000 || loanAmount > 5000000) {
        return {
          message: '❌ Please enter a valid loan amount (₹50,000 to ₹50,00,000)',
          nextPhase: 'form_business',
          messageType: 'text',
          step: 3,
          validation: { valid: false, reason: 'Invalid loan amount' }
        };
      }

      await supabase.moveToPhase(state.phone_number, 'form_business', {
        loan_amount: loanAmount
      });

      return {
        message: '📅 What tenure do you prefer?\n1️⃣ 12 months\n2️⃣ 24 months\n3️⃣ 36 months\n4️⃣ 48 months\n5️⃣ 60 months',
        nextPhase: 'form_business',
        messageType: 'text',
        step: 4
      };
    }

    if (step === 4) {
      // Tenure selection
      const tenureOptions = [12, 24, 36, 48, 60];
      const choice = parseInt(userMessage.trim());

      if (!tenureOptions.includes(choice)) {
        return {
          message: '❌ Please select a valid tenure (1-5)',
          nextPhase: 'form_business',
          messageType: 'text',
          step: 4,
          validation: { valid: false, reason: 'Invalid tenure selection' }
        };
      }

      await supabase.moveToPhase(state.phone_number, 'documents', {
        tenure_months: choice
      });

      // Calculate approximate EMI
      const monthlyRate = (10.5 / 12) / 100; // 10.5% annual rate
      const numPayments = choice;
      const principal = formData.loan_amount;
      const emi = Math.round((principal * monthlyRate * Math.pow(1 + monthlyRate, numPayments)) / (Math.pow(1 + monthlyRate, numPayments) - 1));

      return {
        message: `✅ Perfect! Here's your summary:\n\n💰 Loan Amount: ₹${principal.toLocaleString('en-IN')}\n📅 Tenure: ${choice} months\n💸 Approx EMI: ₹${emi.toLocaleString('en-IN')}/month\n\n📄 Now let's upload your documents.`,
        nextPhase: 'documents',
        messageType: 'text'
      };
    }
  }

  // PHASE 6: Document Collection
  static async handleDocumentsForm(state, userMessage) {
    const documents = ['BRC', 'Bank Statements', 'ID Proof'];
    const currentDocumentStatus = state.document_status || {};

    // Check if user is uploading a document
    if (userMessage.toLowerCase().includes('upload') || userMessage.toLowerCase().includes('document')) {
      return {
        message: '📤 Please upload your documents via this link: https://upload.buddyloan.com\n\nRequired documents:\n1️⃣ Business Registration Certificate (BRC)\n2️⃣ Bank Statements (last 6 months)\n3️⃣ ID Proof (Aadhar/Passport/DL)\n\nReply "DONE" when you\'ve uploaded all documents.',
        nextPhase: 'documents',
        messageType: 'text'
      };
    }

    if (userMessage.toLowerCase().includes('done')) {
      await supabase.moveToPhase(state.phone_number, 'kyc_verification', {
        document_status: {
          brc: { uploaded: true, verified: false, status: 'pending' },
          bank_statement: { uploaded: true, verified: false, status: 'pending' },
          id_proof: { uploaded: true, verified: false, status: 'pending' }
        }
      });

      return {
        message: '✅ Documents received!\n\n🔍 Our team is verifying your documents...\n\nExpected time: 2-4 hours\n\nWe\'ll update you via WhatsApp as soon as we\'re done!',
        nextPhase: 'kyc_verification',
        messageType: 'text'
      };
    }

    return {
      message: '📄 Which document would you like to upload?\n\n1️⃣ BRC (Business Registration Certificate)\n2️⃣ Bank Statements (6 months)\n3️⃣ ID Proof\n4️⃣ Upload all',
      nextPhase: 'documents',
      messageType: 'text'
    };
  }
}

export default FormHandlers;
