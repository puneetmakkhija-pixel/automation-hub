# Eleven Labs Voice Generation - Quick Start

Complete guide to generate natural-sounding voice for IVR menus, personalized greetings, and voice notifications.

## 1. Create Eleven Labs Account

1. **Sign Up:**
   - Visit https://elevenlabs.io
   - Click "Sign Up"
   - Use email or Google/GitHub

2. **Get Your API Key:**
   - Click Profile → API Keys
   - Copy your API key
   - Store securely (never commit to git)

3. **Check Your Plan:**
   - Free tier: 10,000 characters/month
   - Pro tier: 100,000+ characters/month
   - (Adjust based on your usage)

## 2. Set Up Environment Variables

Create a `.env` file (never commit to git):

```bash
# Eleven Labs Credentials
ELEVEN_LABS_API_KEY=your_api_key_from_dashboard
ELEVEN_LABS_BASE_URL=https://api.elevenlabs.io/v1
```

## 3. List Available Voices

### Get All Voices

```bash
curl -X GET http://localhost:3000/api/voice/voices \
  -H "Content-Type: application/json"
```

**Response:**
```json
{
  "success": true,
  "voices": [
    {
      "voice_id": "EXAVITQu4vr4xnSDxMaL",
      "name": "Rachel",
      "description": "American female voice",
      "category": "professional"
    },
    {
      "voice_id": "iP95p4xoKVk53Go1tcWO",
      "name": "Clyde",
      "description": "American male voice",
      "category": "professional"
    }
  ],
  "count": 2
}
```

### Get Predefined Presets

```bash
curl -X GET http://localhost:3000/api/voice/presets
```

Available presets: Rachel, Clyde, Domi

## 4. Text-to-Speech (TTS)

### Convert Text to Audio

```bash
curl -X POST http://localhost:3000/api/voice/tts \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Welcome to BuddyLoan. Press 1 for loan status.",
    "voiceId": "EXAVITQu4vr4xnSDxMaL",
    "stability": 0.5,
    "similarityBoost": 0.75
  }' \
  -o welcome.mp3
```

**Parameters:**
- `text` (required) - Text to convert to speech
- `voiceId` - Voice to use (default: Rachel)
- `stability` (0-1) - Lower = more variable, Higher = more stable (default: 0.5)
- `similarityBoost` (0-1) - How closely to match the voice (default: 0.75)

**Returns:** MP3 audio file

### Supported Voices

```javascript
// Predefined voices
const voices = {
  rachel: 'EXAVITQu4vr4xnSDxMaL',  // Female, friendly
  clyde: 'iP95p4xoKVk53Go1tcWO',   // Male, friendly
  domi: 'AZnzlk1mvXvSRwSDtXLj'     // Male, authoritative
};
```

## 5. IVR Menu Generation

### Create IVR Menu with Options

```bash
curl -X POST http://localhost:3000/api/voice/ivr-menu \
  -H "Content-Type: application/json" \
  -d '{
    "menuTitle": "Welcome to BuddyLoan support",
    "options": [
      {
        "digit": "1",
        "label": "loan status"
      },
      {
        "digit": "2",
        "label": "speak with an agent"
      },
      {
        "digit": "3",
        "label": "report a problem"
      }
    ],
    "voiceId": "EXAVITQu4vr4xnSDxMaL"
  }' \
  -o ivr_menu.mp3
```

**Generated Audio:** "Welcome to BuddyLoan support. Press 1 for loan status. Press 2 to speak with an agent. Press 3 to report a problem."

## 6. Personalized Greetings

### Generate Customer-Specific Greeting

```bash
curl -X POST http://localhost:3000/api/voice/greeting \
  -H "Content-Type: application/json" \
  -d '{
    "customerName": "John Doe",
    "loanAmount": "50000",
    "voiceId": "EXAVITQu4vr4xnSDxMaL"
  }' \
  -o greeting.mp3
```

**Generated Audio:** "Hello John Doe. We have a special loan offer for 50000 rupees. Press 1 to learn more or press 2 to speak with an agent."

### Use in OBD IVR Campaign

```javascript
import ElevenLabsClient from './lib/elevenLabsClient.js';

const voiceClient = new ElevenLabsClient();

// Generate greeting for customer
const greeting = await voiceClient.generatePersonalizedGreeting({
  customerName: 'John Doe',
  loanAmount: '50,000',
  voiceId: 'EXAVITQu4vr4xnSDxMaL'
});

if (greeting.success) {
  // Save audio to file or stream
  // Use in OBD campaign
}
```

## 7. Voice Stability & Similarity

### Parameter Tuning

**Stability (0-1):**
- `0.0` = Highly variable (emotional, expressive)
- `0.5` = Balanced (default)
- `1.0` = Very stable (monotone, robotic)

**Similarity Boost (0-1):**
- `0.5` = Less similar to original voice
- `0.75` = Balanced match (default)
- `1.0` = Perfect match to original voice

### Recommended Settings

```javascript
// Professional/formal prompts
{
  stability: 0.7,      // Stable and clear
  similarityBoost: 0.8 // Close to voice
}

// Friendly/conversational prompts
{
  stability: 0.5,      // Natural variation
  similarityBoost: 0.75 // Balanced match
}

// Dynamic/emotional prompts
{
  stability: 0.3,      // Variable tone
  similarityBoost: 0.9 // Strong voice identity
}
```

## 8. Check API Usage

### Get User Information

```bash
curl -X GET http://localhost:3000/api/voice/user
```

**Response:**
```json
{
  "success": true,
  "subscription": {
    "character_limit": 10000,
    "character_count": 2500,
    "tier": "free"
  },
  "quotaUsage": 25,
  "charactersRemaining": 7500
}
```

### Health Check

```bash
curl -X GET http://localhost:3000/api/voice/health
```

## 9. Integration with IVR Router

### Full Workflow Example

```javascript
import ElevenLabsClient from './lib/elevenLabsClient.js';
import OBDApiClient from './lib/obdApiClient.js';

const voiceClient = new ElevenLabsClient();
const obdClient = new OBDApiClient(...);

// 1. Generate IVR menu audio
const menuAudio = await voiceClient.createIVRMenu({
  menuTitle: 'Welcome to BuddyLoan',
  options: [
    { digit: '1', label: 'loan status' },
    { digit: '2', label: 'speak with an agent' }
  ]
});

// 2. Save audio to file or upload
const menuBytes = Buffer.from(menuAudio.audio);
// Upload to cloud storage or OBD server

// 3. Create OBD campaign using this audio
const campaign = await obdClient.composeCampaign({
  campaignName: 'IVR Campaign',
  campaignType: 'ivr',
  audioUrl: 'https://your-storage.com/menu.mp3',
  // ... other config
});

// 4. Monitor call results
const results = await obdClient.analyzeCampaign(campaign.campaignId);
```

### Dynamic Greeting in Campaign

```javascript
// When call connects, generate personalized greeting
app.post('/voice', async (req, res) => {
  const customerPhone = req.body.From;
  
  // Get customer from database
  const customer = await db.getCustomer(customerPhone);
  
  // Generate personalized greeting
  const greeting = await voiceClient.generatePersonalizedGreeting({
    customerName: customer.customer.name,
    loanAmount: customer.customer.metadata?.loanAmount,
    voiceId: 'EXAVITQu4vr4xnSDxMaL'
  });
  
  // Return Twilio XML with custom audio
  if (greeting.success) {
    res.type('text/xml').send(`
      <Response>
        <Play>${audioUrl}</Play>
        <Gather numDigits="1" action="/voice-action">
          <Pause length="1"/>
        </Gather>
      </Response>
    `);
  }
});
```

## 10. Multi-Language Support

### English (US)
```javascript
const model = 'eleven_monolingual_v1'; // Default
```

### Multilingual Support
```javascript
// For future: multilingual model
const model = 'eleven_multilingual_v1'; // When available
```

**Note:** Currently optimized for English. Other languages work but may be less natural.

## 11. Cost Optimization

### Character Count Tips

- 1 word ≈ 5-7 characters
- "Welcome" = 7 characters
- "Press 1 for loan status" = 23 characters

### Sample Costs

- Free tier: 10,000 characters/month
- 100 IVR menu calls (24 chars each) = 2,400 characters
- 100 personalized greetings (50 chars each) = 5,000 characters
- Total monthly: ~7,500 characters (fits in free tier)

### Optimization Strategies

1. **Reuse Common Phrases:**
   - Cache generated audio for static menus
   - Regenerate only personalized parts

2. **Shorter Prompts:**
   - "Press 1 for status" instead of "Press 1 to check your loan status"
   - Save ~10 characters per prompt

3. **Batch Generation:**
   - Generate greetings during off-peak hours
   - Pre-generate for known customer segments

## 12. Error Handling

### Common Errors

**"Missing ELEVEN_LABS_API_KEY"**
```bash
export ELEVEN_LABS_API_KEY="your_key"
```

**"Request timeout"**
- Increase timeout or reduce text length
- Very long texts may take longer to generate

**"Quota exceeded"**
- Check current usage: `GET /api/voice/user`
- Upgrade plan if needed
- Or wait for monthly quota reset

**"Invalid voice ID"**
- List available voices: `GET /api/voice/voices`
- Use correct voice ID from list

## 13. Audio Quality

### Output Format
- Format: MP3
- Bitrate: 128 kbps (default)
- Mono/Stereo: Mono

### Listening Tips
- Download MP3 and test in your phone system
- Adjust stability/similarity based on quality
- Test with real phone calls before full deployment

## 14. API Reference

### ElevenLabsClient Methods

```javascript
// Text-to-speech
await client.textToSpeech({text, voiceId, stability, similarityBoost})

// Voice management
await client.listVoices()
await client.getVoice(voiceId)
await client.getPredefinedVoices()

// IVR and greetings
await client.createIVRMenu({menuTitle, options, voiceId})
await client.generatePersonalizedGreeting({customerName, loanAmount, voiceId})

// User info
await client.getUserInfo()
await client.healthCheck()
```

### REST Endpoints

```
GET    /api/voice/voices                    - List voices
GET    /api/voice/voices/:id                - Get voice details
GET    /api/voice/presets                   - Get voice presets
GET    /api/voice/user                      - Get user info and quota

POST   /api/voice/tts                       - Text-to-speech
POST   /api/voice/ivr-menu                  - Generate IVR menu
POST   /api/voice/greeting                  - Generate greeting

GET    /api/voice/health                    - Health check
```

## 15. Next Steps

1. ✅ Create Eleven Labs account at https://elevenlabs.io
2. ✅ Copy API key to ELEVEN_LABS_API_KEY in .env
3. ✅ List voices: `GET /api/voice/voices`
4. ✅ Test TTS: `POST /api/voice/tts` with sample text
5. ✅ Generate IVR menu: `POST /api/voice/ivr-menu`
6. ✅ Check quota: `GET /api/voice/user`
7. ✅ Integrate with OBD campaigns

## Support

- **Eleven Labs Docs:** https://elevenlabs.io/docs
- **Voice Models:** https://elevenlabs.io/docs/voice-library
- **API Reference:** https://elevenlabs.io/docs/api-reference
- **IVR Router:** See code examples in `lib/elevenLabsClient.js`

---

Last Updated: 2026-08-25
