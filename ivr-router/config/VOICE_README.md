# IVR Voice Management System

## Overview

The voice management system enables lender-specific personality and tone for IVR conversations. Each lender (Flexiloans, Poonawala Fincorp) has a unique voice profile that shapes how the chatbot responds to users.

## Voice Profiles

### Flexiloans
- **Tone**: Friendly, Professional, Upbeat
- **Persona**: Approachable financial partner
- **Key Message**: Quick approval and flexible solutions
- **Located in**: `config/voices/flexiloans-voice.json`

### Poonawala Fincorp
- **Tone**: Professional, Confident, Composed
- **Persona**: Trusted financial expert
- **Key Message**: Experience and reliability
- **Located in**: `config/voices/poonawala-voice.json`

## Voice Profile Structure

Each voice profile contains:

```json
{
  "lender_id": "flexiloans",
  "lender_name": "Flexiloans",
  "voice_profile": {
    "tone": "friendly_professional",
    "pace": "moderate",
    "energy": "upbeat",
    "accent": "indian_english"
  },
  "tts_config": {
    "provider": "elevenlabs",
    "voice_id": "flexiloans_professional",
    "model": "eleven_monolingual_v1",
    "stability": 0.5,
    "similarity_boost": 0.75
  },
  "greeting_variants": [...],
  "product_description": "...",
  "key_benefits": [...],
  "common_responses": {
    "eligibility_check": "...",
    "approval": "...",
    "rejection": "...",
    "document_request": "...",
    "rate_inquiry": "...",
    "processing": "...",
    "completion": "..."
  },
  "error_handling": {...},
  "handoff_script": "...",
  "metadata": {...}
}
```

## Usage

### Initialize Conversation with Lender Voice

```javascript
import voiceIntegration from './lib/services/voiceIntegration.js';

const result = await voiceIntegration.initializeConversationWithVoice(
  'flexiloans',
  'John'
);

// Returns:
// {
//   greeting: "Hi John! Welcome to Flexiloans!...",
//   lender_profile: {...},
//   voice_tone: "friendly_professional",
//   tts_config: {...}
// }
```

### Generate Lender-Aware Response

```javascript
const response = await voiceIntegration.generateLenderAwareBotResponse(
  'poonawala',
  'What are your interest rates?'
);

// Returns Claude-generated response with Poonawala's professional tone
```

### Use Template Responses

```javascript
const voiceManager = require('./lib/services/voiceManager.js');

const result = await voiceManager.generateResponse(
  'flexiloans',
  'approval',
  { amount: '₹5,00,000' }
);
// Response: "Great news! You're approved for a loan up to ₹5,00,000."
```

### Get Available Lenders

```javascript
const voices = voiceIntegration.getAvailableLenderVoices();
// Returns: [{lender_id, lender_name, tone, benefits, ...}, ...]
```

## Template Variables

Common template variables that can be substituted:

- `{{amount}}`: Loan amount (e.g., "₹5,00,000")
- `{{rate}}`: Interest rate (e.g., "9.99%")
- `{{days}}`: Number of days (e.g., "30")
- `{{documents}}`: Required documents list

## Integrating with ElevenLabs TTS

To generate actual voice audio, configure ElevenLabs API key:

```javascript
import ElevenLabs from 'elevenlabs-node';

const elevenlabs = new ElevenLabs({
  apiKey: process.env.ELEVENLABS_API_KEY
});

// Use the voice_id from the profile
const audioStream = await elevenlabs.textToSpeech.convert({
  voice_id: profile.tts_config.voice_id,
  text: botResponse,
  model_id: profile.tts_config.model
});
```

## Adding New Lender Voices

1. Create a new JSON file in `config/voices/{lender_id}-voice.json`
2. Follow the voice profile structure
3. Run the chatbot — it auto-discovers voice profiles

## Response Generation Priority

1. **Template Match** (fastest) — Pre-written responses for common queries
2. **Claude with Context** (default) — AI-generated response with lender personality
3. **Error Handler** — Fallback responses for unclear inputs

## Customization

### Modify Existing Voice Tone

Edit the `voice_profile` in the JSON:
```json
"voice_profile": {
  "tone": "more_casual",  // Change tone
  "pace": "faster",       // Adjust speech pace
  "energy": "higher"      // Increase energy
}
```

### Add New Template Responses

Add to `common_responses` in the voice profile:
```json
"custom_query": "Custom response with {{variables}}"
```

### Update TTS Voice

Change `voice_id` in `tts_config` to use different ElevenLabs voices:
```json
"tts_config": {
  "voice_id": "new_voice_id_from_elevenlabs"
}
```

## Testing

Test voice integration:

```javascript
import voiceIntegration from './lib/services/voiceIntegration.js';

// Test initialization
const init = await voiceIntegration.initializeConversationWithVoice('flexiloans', 'Test User');
console.log(init.greeting);

// Test response generation
const response = await voiceIntegration.generateLenderAwareBotResponse(
  'poonawala',
  'Can I get a loan?'
);
console.log(response.message);

// Test available voices
const voices = voiceIntegration.getAvailableLenderVoices();
console.log(voices);
```

## Environment Variables

Required for full functionality:
- `ELEVENLABS_API_KEY` (for text-to-speech)
- `ANTHROPIC_API_KEY` (for Claude-based message generation)
- `CLAUDE_MODEL` (defaults to claude-3-5-sonnet-20241022)

## Future Enhancements

- [ ] Multi-language support (Hindi, Telugu, Marathi, etc.)
- [ ] Emotion-based tone variation (urgent, reassuring, excited)
- [ ] A/B testing different voice profiles
- [ ] Real-time voice analytics (engagement, sentiment)
- [ ] Custom voice cloning per lender brand
