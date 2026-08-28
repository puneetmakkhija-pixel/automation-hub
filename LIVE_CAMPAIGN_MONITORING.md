# Live Campaign Monitoring & Analytics

**Purpose:** Real-time monitoring during campaign execution + post-campaign analysis  
**Duration:** For active campaigns + 24-48 hours after completion  
**Tools:** Dashboard + Browser Console + Backend Logs

---

## 🎯 REAL-TIME MONITORING (During Campaign)

### Dashboard Live Metrics (Every 30 seconds)
Watch these 6 cards on Dashboard tab:

```
┌─────────────────────────────────────────────────────────┐
│ LIVE METRICS (Auto-refresh every 30 seconds)            │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Leads Processed    WhatsApp %    Calls Connected %     │
│  [Should match]     [Growing]     [Growing]             │
│                                                         │
│  DTMF Captured %    Interested    Not Interested        │
│  [Growing]          [Growing]     [Growing]             │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**What to Watch:**
- ✓ All numbers increasing (not stuck)
- ✓ Percentages staying within healthy ranges
- ✓ No sudden drops (indicates problem)
- ✓ WhatsApp % should reach 85%+ in 5 min

### Campaign Tab Monitoring
```
Click "Campaigns" tab
↓
Find your campaign in table
↓
Watch these columns update:
├─ Delivered: Should reach ~85 by 10 min mark
├─ Connected: Should reach ~60 by 15 min mark
├─ Interested: Should reach ~15-24 by 30 min mark
└─ Status: Should stay "active"
```

### Analytics Tab Monitoring
```
Click "Analytics" tab
↓
Watch "Conversion Funnel":
├─ Leads Sent: 100 (static)
├─ WhatsApp Delivered: ↗ Growing to ~85
├─ Calls Connected: ↗ Growing to ~60
└─ Interested: ↗ Growing to ~15-24
```

---

## 📊 EXPECTED METRICS TIMELINE

### By Minute 5
```
Leads Processed:     100
WhatsApp Delivered:  60-70% (60-70 leads)
Calls Connected:     10-20% (10-20 calls)
DTMF Captured:       5-10% (5-10 responses)
Interested:          2-5 leads
```

### By Minute 15
```
Leads Processed:     100
WhatsApp Delivered:  80-85% (80-85 leads)
Calls Connected:     50-60% (50-60 calls)
DTMF Captured:       40-50% (40-50 responses)
Interested:          10-15 leads
```

### By Minute 30
```
Leads Processed:     100
WhatsApp Delivered:  85%+ (85+ leads)
Calls Connected:     65-75% (65-75 calls)
DTMF Captured:       60%+ (60+ responses)
Interested:          15-25 leads
Not Interested:      20-30 leads
```

---

## 🚨 ALERT THRESHOLDS (Action Required)

### RED ALERTS (Immediate Action)
| Metric | Threshold | Action |
|--------|-----------|--------|
| WhatsApp delivery | <50% by 10 min | Check Ananta webhook |
| Calls connected | <30% by 15 min | Check OBD webhook |
| API errors | >5% | Restart backend service |
| Dashboard error alerts | Any | Capture screenshot, check console |

### YELLOW ALERTS (Monitor Closely)
| Metric | Threshold | Action |
|--------|-----------|--------|
| WhatsApp delivery | 50-80% by 10 min | Normal, continue monitoring |
| Calls connected | 30-60% by 15 min | Normal, check DNC list |
| Response rate | <40% by 20 min | Check voice prompt quality |

### GREEN METRICS (Healthy)
| Metric | Target | Status |
|--------|--------|--------|
| WhatsApp delivery | 85%+ | ✓ Excellent |
| Calls connected | 70%+ | ✓ Excellent |
| DTMF response | 60%+ | ✓ Good |
| Interested rate | 15-25% | ✓ Normal |
| Error rate | <1% | ✓ Healthy |

---

## 🔍 DEBUGGING DURING CAMPAIGN

### If WhatsApp Delivery Stuck at 0%
```
1. Dashboard → Settings tab
2. Check "Ananta WhatsApp" → should show "Connected"
3. If shows "Disconnected":
   - Check Ananta API credentials
   - Verify webhook URL in Ananta dashboard
   - Restart Ananta service
4. If "Connected":
   - Check browser console for errors
   - Look for API error alerts
   - Try creating test message via Ananta directly
```

### If Calls Not Connecting
```
1. Dashboard → Settings tab
2. Check "OBD Voice Calls" → should show "Connected"
3. If shows "Disconnected":
   - Check OBD API credentials
   - Verify webhook IDs (539, 540, 541)
   - Restart OBD service
4. If "Connected":
   - Check if phone numbers in DNC list
   - Verify voice prompt is configured
   - Check OBD rate limiting
   - Try test call manually
```

### If DTMF Not Captured
```
1. Wait for first call to complete (takes 45-60 sec)
2. If still 0%:
   - Check OBD webhook ID 540 is live
   - Verify DTMF is enabled in voice prompt
   - Check if customers actually pressing keypad
   - Review OBD call recording
```

### If Dashboard Metrics Not Updating
```
1. F12 console → check for JavaScript errors
2. Check network tab → look for failed API calls
3. If 503 errors:
   - Backend service down (wait/restart)
   - Database query slow (optimize)
4. If 504 errors:
   - Request timeout (increase timeout)
   - Load too high (scale up)
```

---

## 📈 POST-CAMPAIGN ANALYSIS (24-48 hours after)

### Immediate Post-Campaign (30 min after completion)

**Collect Final Metrics:**
```bash
# Via Dashboard - Screenshot the final numbers
# Dashboard → Screenshot all 6 metric cards
# Analytics → Screenshot conversion funnel
# Analytics → Screenshot rejection breakdown
# Campaigns → Screenshot campaign final row
```

**Export Campaign Data:**
```javascript
// In browser console, run:
const metricsData = {
  timestamp: new Date().toISOString(),
  campaign: {
    name: "document.querySelector('table').rows[1].cells[0].textContent",
    leadsCount: 100,
    delivered: 85, // From table
    connected: 60,  // From table
    interested: 20  // From table
  },
  metrics: {
    leadsSent: 100,
    whatsappDelivery: 85,
    callsConnected: 60,
    dtmfCaptured: 50,
    interestedCount: 20,
    notInterestedCount: 30
  }
};
console.log(JSON.stringify(metricsData, null, 2));
```

### Dashboard Analytics (Check Day After)

**Conversion Funnel Analysis:**
- Leads Sent: Should equal campaign size (100)
- WhatsApp Delivered: Compare against target (85%)
- Calls Connected: Compare against target (70%)
- Interested: Check interest rate (target 20-30%)

**Rejection Breakdown:**
- CIBIL Score Low: Track % vs historical
- Too Many Inquiries: Compare to baseline
- Existing Loan: Monitor trend
- Income Low: Check vs criteria

**Key Metrics:**
- Cost per Lead: Should be ₹8
- Avg Call Duration: Should be 45-60 sec
- Webhook Success Rate: Should be 99%+
- System Uptime: Should be 99.95%+

---

## 📊 CAMPAIGN SUMMARY REPORT

Create this report 24 hours after campaign:

```markdown
# Campaign Summary Report
**Campaign Name:** [Name]
**Date:** [Date]
**Leads Processed:** 100
**Campaign Duration:** 30 minutes

## Results

### Delivery Metrics
- WhatsApp Sent: 100
- WhatsApp Delivered: 85 (85%)
- Delivery Success Rate: 100% of sent
- Failed Deliveries: 15 (reasons?)

### Voice Metrics
- Calls Initiated: 85
- Calls Connected: 60 (70.6%)
- Call Failed: 25
- Avg Call Duration: 48 seconds
- Max Call Duration: 120 seconds
- Min Call Duration: 15 seconds

### Engagement Metrics
- DTMF Captured: 50 (83% of connected)
- No Response: 10
- No DTMF: 0

### Disposition Breakdown
- Interested: 20 (40% of responses)
- Not Interested: 20 (40% of responses)
- Callback Later: 10 (20% of responses)

### Conversion Funnel
```
100 Leads Sent
  ↓ (100%)
85 WhatsApp Delivered
  ↓ (85%)
60 Calls Connected
  ↓ (70.6%)
50 DTMF Captured
  ↓ (83%)
20 Interested
  ↓ (40%)
```

### Financial Metrics
- Total Cost: 100 × ₹8 = ₹800
- Cost per Connected Call: ₹800 ÷ 60 = ₹13.3
- Cost per Interested Lead: ₹800 ÷ 20 = ₹40
- Revenue (if ₹1000 per approval): 20 × ₹1000 = ₹20,000
- ROI: (₹20,000 - ₹800) / ₹800 = 2,400%

### Issues & Resolutions
1. [Issue]: [Resolution]
2. [Issue]: [Resolution]

### Learnings & Improvements
- What worked well
- What could be improved
- Recommended changes for next campaign
- Optimization opportunities

### Next Steps
- [ ] Archive campaign data
- [ ] Update business rules based on results
- [ ] Schedule follow-up for interested leads
- [ ] Plan next campaign (date: ___)
```

---

## 🔄 CONTINUOUS MONITORING (After Campaign)

### Daily Dashboard Checks (7 days after)
```bash
# Day 1 Post: Check final dispositions
# Day 2 Post: Verify database consistency
# Day 3 Post: Check re-engagement metrics
# Day 4-7: Monitor any follow-up actions
```

### Weekly Analytics Review
```
1. Compare this campaign to previous campaigns
2. Identify trends (delivery rate, conversion rate)
3. Spot anomalies (unexpected drops)
4. Update success metrics in PROJECT_MASTER_REFERENCE.md
```

### Monthly Optimization
```
Based on all campaigns run:
- Update cost per lead (if changed)
- Adjust target delivery/connection rates
- Modify lead criteria (if patterns emerged)
- Plan next month's campaigns
```

---

## 📱 MONITORING ALERTS Setup (Optional)

### Browser Notification (If available)
```javascript
// Add to dashboard.js for real-time alerts
if (Notification.permission === 'granted') {
  if (metricsData.whatsappDelivery < 50) {
    new Notification('Warning: WhatsApp delivery low!');
  }
}
```

### Console Notifications
```javascript
// Logs to browser console with time
console.warn('[09:15:23] WhatsApp delivery rate low: 45%');
console.error('[09:16:45] Ananta webhook disconnected');
```

### Email Alerts (Manual)
```
Setup email notifications:
1. Create alert email template
2. When metric crosses threshold, send email
3. Include: metric value, time, recommended action
```

---

## 📝 MONITORING CHECKLIST

**During Campaign:**
- [ ] Dashboard metrics loading
- [ ] All numbers increasing
- [ ] No error alerts appearing
- [ ] Browser console clean (no errors)
- [ ] Metrics within healthy ranges
- [ ] Campaign status stays "active"

**After Campaign (30 min):**
- [ ] Collect final metrics
- [ ] Screenshot analytics
- [ ] Check for any error messages
- [ ] Verify database has all records

**Next Day:**
- [ ] Generate summary report
- [ ] Compare to targets
- [ ] Identify issues/improvements
- [ ] Plan optimizations

**One Week Later:**
- [ ] Review all metrics
- [ ] Check if rejections processed correctly
- [ ] Verify re-engagement setup
- [ ] Plan next campaign

---

## 🎓 KEY METRICS TO UNDERSTAND

### WhatsApp Delivery Rate
- **Definition:** % of leads that received WhatsApp message
- **Target:** 85%+
- **Reason for failures:** Invalid number, opted out, service down
- **How to improve:** Validate numbers, check DNC list, verify Ananta service

### Call Connection Rate
- **Definition:** % of WhatsApp recipients who received voice call
- **Target:** 70%+
- **Reason for failures:** Do Not Call, network busy, customer rejected
- **How to improve:** Update DNC list, stagger calls, improve timing

### DTMF Response Rate
- **Definition:** % of connected calls where customer pressed keypad
- **Target:** 60%+
- **Reason for failures:** Customer hung up, didn't understand prompt, network issue
- **How to improve:** Improve voice prompt, increase call duration, verify DTMF capture

### Interest Rate
- **Definition:** % of DTMF responses indicating interest (pressed 1)
- **Target:** 20-30%
- **Reason for variance:** Loan amount, interest rate, eligibility criteria
- **How to improve:** Adjust target criteria, improve messaging, offer better rates

### Cost Per Lead
- **Definition:** Total campaign cost ÷ leads sent
- **Target:** ₹8 (fixed)
- **Components:** Ananta cost + OBD cost + Infrastructure
- **How to optimize:** Bulk discounts, negotiate rates, improve efficiency

---

**Use this guide during and after every campaign to monitor health and optimize future campaigns.**
