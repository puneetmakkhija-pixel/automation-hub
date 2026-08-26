# Monitoring & Plugins Architecture

**Purpose:** Comprehensive monitoring layer + plugin ecosystem for end-to-end visibility  
**Status:** Architecture & Integration Plan

---

## System Overview with Monitoring

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         MONITORING & OBSERVABILITY LAYER                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │ Error Track  │  │ Performance  │  │ Log Agg      │  │ Metrics      │   │
│  │ (Sentry)     │  │ (New Relic)  │  │ (ELK/Loki)   │  │ (Prometheus) │   │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘   │
│                                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │ Dashboards   │  │ Alerts       │  │ On-Call      │  │ Status Page  │   │
│  │ (Grafana)    │  │ (PagerDuty)  │  │ (PagerDuty)  │  │ (StatusPage) │   │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘   │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
                                      ▲
                                      │ (All phases emit metrics)
                                      │
┌─────────────────────────────────────────────────────────────────────────────┐
│                       IVR ROUTER + CRM AUTOMATION PLATFORM                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  Phase 1: Voice → CRM                                                       │
│  ├─ OBD Dialer → Chatsense DTMF → CRM Application                           │
│  ├─ Metrics: Calls, Pickup Rate, Disposition Split                          │
│  └─ Alerts: Failed submissions, High error rate                             │
│                                                                               │
│  Phase 2: Eligibility & Routing                                             │
│  ├─ Credit Check → Multi-Lender Eligibility → Lender Assignment             │
│  ├─ Metrics: Eligible Count, Lender Distribution, EMI Accuracy              │
│  └─ Alerts: No eligible lenders spike, Routing failures                     │
│                                                                               │
│  Phase 3: Document Collection                                               │
│  ├─ Lender-Specific Docs → Verification → Completeness Tracking             │
│  ├─ Metrics: Doc Upload Rate, Verification Time, Completion Rate            │
│  └─ Alerts: Upload failures, Verification timeouts                          │
│                                                                               │
│  Phase 4: Lender Submission & Approval                                      │
│  ├─ Format → Submit → Poll → Approve/Reject                                 │
│  ├─ Metrics: Submission Rate, Approval Rate, Decision Time                  │
│  └─ Alerts: Lender API failures, Slow decisions                             │
│                                                                               │
│  Phase 5: Disbursal & Billing                                               │
│  ├─ Disbursal → Monthly EMI → Settlement                                    │
│  ├─ Metrics: Disbursal Rate, Collection Rate, Settlement Accuracy           │
│  └─ Alerts: Disbursal failures, Payment defaults                            │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Plugin Ecosystem

### Tier 1: Core Monitoring (Free/Open-Source)

#### 1. **Sentry** (Error Tracking)
**Free Tier:** 5K events/month  
**Cost:** Free → $29/month (production)

```javascript
// Installation
npm install @sentry/node @sentry/tracing

// Usage in IVR Router (index.js)
import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1, // 10% of transactions
  integrations: [
    new Sentry.Integrations.Http({ tracing: true }),
    new Sentry.Integrations.OnUncaughtException(),
  ],
});

// Capture errors
app.use(Sentry.Handlers.errorHandler());

// In routes
try {
  // ... route logic
} catch (error) {
  Sentry.captureException(error, {
    tags: {
      phase: "phase_2",
      operation: "check_eligibility",
    },
  });
}
```

**Metrics It Captures:**
- Error rate & types
- Stack traces with source maps
- Release tracking
- Custom tags (phase, operation, lender)

**Why:** Real-time error notifications, error trends, root cause analysis

---

#### 2. **Prometheus** (Metrics Collection)
**Free & Open-Source**

```javascript
// Installation
npm install prom-client

// Setup in index.js
import promClient from "prom-client";

const httpRequestDurationMicroseconds = new promClient.Histogram({
  name: "http_request_duration_ms",
  help: "Duration of HTTP requests in ms",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.1, 5, 15, 50, 100, 500],
});

const leadIntakeCounter = new promClient.Counter({
  name: "lead_intake_total",
  help: "Total leads processed",
  labelNames: ["disposition", "success"],
});

const eligibilityCheckCounter = new promClient.Counter({
  name: "eligibility_check_total",
  help: "Total eligibility checks",
  labelNames: ["lender", "eligible"],
});

const routingLogsGauge = new promClient.Gauge({
  name: "routed_lenders_total",
  help: "Total applications routed per lender",
  labelNames: ["lender_id"],
});

// Middleware to track requests
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    httpRequestDurationMicroseconds
      .labels(req.method, req.route?.path || "unknown", res.statusCode)
      .observe(duration);
  });
  next();
});

// Expose metrics endpoint
app.get("/metrics", async (req, res) => {
  res.set("Content-Type", promClient.register.contentType);
  res.end(await promClient.register.metrics());
});

// Track lead intake
router.post("/lead-intake-sync", async (req, res) => {
  try {
    const result = await crmClient.leadIntakeSyncFromVoice({...});
    leadIntakeCounter.inc({
      disposition: result.disposition,
      success: result.success,
    });
  } catch (error) {
    leadIntakeCounter.inc({ disposition: "error", success: "false" });
  }
});

// Track eligibility checks
router.post("/check-eligibility", async (req, res) => {
  try {
    const result = await lenderClient.getEligibleLenders({...});
    result.allEligibleLenders.forEach(lender => {
      eligibilityCheckCounter.inc({
        lender: lender.lenderId,
        eligible: "true",
      });
    });
  } catch (error) {
    eligibilityCheckCounter.inc({ lender: "error", eligible: "false" });
  }
});
```

**Metrics Tracked:**
- API request latency (histogram)
- Lead intake success rate (counter)
- Eligibility checks per lender (counter)
- Active applications (gauge)

**Why:** Foundation for dashboards, alerting, capacity planning

---

#### 3. **Grafana** (Dashboards & Visualization)
**Free & Open-Source**

```yaml
# docker-compose.yml for local setup
version: "3"
services:
  prometheus:
    image: prom/prometheus
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml

  grafana:
    image: grafana/grafana
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    volumes:
      - grafana-storage:/var/lib/grafana

volumes:
  grafana-storage:
```

**Dashboards to Create:**

1. **Phase 1: Lead Intake Dashboard**
   ```
   - Lead Creation Rate (per hour)
   - Disposition Split (pie chart: interested / callback / rejected)
   - Pickup Rate (calls answered / calls made)
   - Average Call Duration
   - Error Rate (failed submissions)
   ```

2. **Phase 2: Eligibility & Routing Dashboard**
   ```
   - Eligibility Check Rate (per hour)
   - No Eligible Lenders % (drop-off rate)
   - Lender Distribution (bar chart: Poonawala vs HDFC vs Hero vs Bajaj)
   - Average EMI by Lender
   - Routing Latency (percentiles: p50, p95, p99)
   ```

3. **Phase 4: Lender Performance Dashboard**
   ```
   - Approval Rate by Lender (line chart over time)
   - Average Decision Time (per lender)
   - Submission Rate (per day)
   - Rejection Reasons (breakdown)
   ```

4. **Phase 5: Billing & Collections Dashboard**
   ```
   - Collection Rate (% of EMIs collected)
   - Average Days to Collection
   - Default Rate (% of EMIs not paid)
   - Lender Settlement (per lender, per month)
   ```

5. **System Health Dashboard**
   ```
   - API Uptime (99.9%?)
   - Error Rate (by phase, by type)
   - Database Query Latency (p50, p95, p99)
   - Active Connections
   ```

---

### Tier 2: Communication & Alerting

#### 4. **PagerDuty** (On-Call & Alert Management)
**Free Tier:** 1 user  
**Cost:** Free → $9/user/month

```javascript
// Installation
npm install pagerduty

// Setup alerts
const PagerDutyAlert = {
  high_error_rate: {
    severity: "critical",
    threshold: "5% error rate in 5 min",
    action: "page on-call engineer",
  },
  lender_api_down: {
    severity: "critical",
    threshold: "Lender API non-responsive",
    action: "page lender integration team",
  },
  no_eligible_lenders_spike: {
    severity: "warning",
    threshold: ">20% no-eligible spike",
    action: "notify product team",
  },
  payment_collection_drop: {
    severity: "high",
    threshold: "Collection rate <80%",
    action: "page billing team",
  },
};

// Trigger alert from Prometheus/Grafana
app.post("/api/alerts/trigger", async (req, res) => {
  const { severity, title, description } = req.body;
  
  // Send to PagerDuty
  const incident = await createPagerDutyIncident({
    title,
    description,
    urgency: severity === "critical" ? "high" : "low",
  });
  
  // Slack notification (via integration)
  await notifySlack(`🚨 ${severity.toUpperCase()}: ${title}`);
});
```

**Alerts to Configure:**
- Error rate > 5% in 5 minutes
- Lender API down
- No eligible lenders spike (>20% increase)
- Payment collection drop (< 80%)
- Database connection errors
- Disbursal failures

---

#### 5. **Slack Integration** (Team Notifications)
**Free Tier:** 90-day message history  
**Cost:** Free → $12.5/user/month

```javascript
// Installation
npm install @slack/web-api

// Setup
import { WebClient } from "@slack/web-api";
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// Send notifications on key events
async function notifySlack(channel, message, severity = "info") {
  const colors = {
    info: "#0099FF",
    success: "#36A64F",
    warning: "#FFA500",
    error: "#FF0000",
  };

  await slack.chat.postMessage({
    channel,
    attachments: [
      {
        color: colors[severity],
        title: message.title,
        text: message.description,
        fields: message.fields || [],
        footer: "BuddyLoan Automation",
        ts: Math.floor(Date.now() / 1000),
      },
    ],
  });
}

// Phase 1: Lead intake notification
router.post("/api/crm/lead-intake-sync", async (req, res) => {
  const result = await crmClient.leadIntakeSyncFromVoice({...});
  
  if (result.success) {
    await notifySlack("#leads-intake", {
      title: "✅ Lead Created",
      description: `${result.applicationId} - ${req.body.name}`,
      fields: [
        { title: "Phone", value: req.body.phone, short: true },
        { title: "Disposition", value: req.body.disposition, short: true },
        { title: "Income", value: `₹${req.body.income}`, short: true },
        { title: "CIBIL", value: req.body.cibilScore || "N/A", short: true },
      ],
    }, "success");
  } else {
    await notifySlack("#alerts", {
      title: "❌ Lead Intake Failed",
      description: result.error,
    }, "error");
  }
});

// Phase 2: Routing notification (daily digest)
setInterval(async () => {
  const routing = await getRoutingStats(); // Query routing_logs
  
  await notifySlack("#daily-digest", {
    title: "📊 Daily Routing Summary",
    description: `${routing.totalChecks} eligibility checks`,
    fields: [
      { title: "Poonawala", value: `${routing.poonawala}`, short: true },
      { title: "HDFC", value: `${routing.hdfc}`, short: true },
      { title: "Hero", value: `${routing.hero}`, short: true },
      { title: "Bajaj", value: `${routing.bajaj}`, short: true },
      { title: "No Eligible", value: `${routing.noEligible}`, short: true },
      { title: "Success Rate", value: `${routing.successRate}%`, short: true },
    ],
  }, "info");
}, 24 * 60 * 60 * 1000); // Daily
```

**Channels to Create:**
- `#leads-intake` - Phase 1 events (new leads)
- `#eligibility-routing` - Phase 2 events (routing decisions)
- `#document-collection` - Phase 3 events (doc uploads)
- `#lender-decisions` - Phase 4 events (approvals/rejections)
- `#billing-collections` - Phase 5 events (payments, defaults)
- `#alerts` - Critical errors & incidents
- `#daily-digest` - Daily summary reports

---

### Tier 3: Customer Communication & Analytics

#### 6. **SendGrid** (Email Notifications)
**Free Tier:** 100 emails/day  
**Cost:** Free → $9.99/month (50K emails)

```javascript
// Installation
npm install @sendgrid/mail

// Setup
import sgMail from "@sendgrid/mail";
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Send customer notifications
async function sendCustomerEmail(email, phase, data) {
  const templates = {
    phase1_approval: {
      subject: "✅ Your loan application has been accepted",
      text: `Thank you for applying. We've received your information.`,
    },
    phase2_eligibility: {
      subject: "🎯 We found the best rates for you",
      text: `Based on your profile, you're eligible for:
        Poonawala Fincorp: ₹${data.poonawala.emi}/month @ ${data.poonawala.rate}%
        HDFC Jumbo: ₹${data.hdfc.emi}/month @ ${data.hdfc.rate}%`,
    },
    phase3_docs: {
      subject: "📄 Documents needed for approval",
      text: `Please upload: ITR, Bank Statement, ID Proof, Address Proof`,
    },
    phase4_approved: {
      subject: "🎉 Your loan has been approved!",
      text: `Congratulations! Your loan of ₹${data.amount} @ ${data.rate}% p.a. for ${data.tenor} months has been approved.`,
    },
    phase5_disbursed: {
      subject: "💰 Loan amount transferred to your account",
      text: `₹${data.amount} has been transferred. Your first EMI of ₹${data.emi} is due on ${data.dueDate}.`,
    },
  };

  await sgMail.send({
    to: email,
    from: "noreply@buddyloan.com",
    subject: templates[phase].subject,
    text: templates[phase].text,
  });
}
```

---

#### 7. **Segment** (Customer Analytics)
**Free Tier:** 1000 tracked users  
**Cost:** Free → $300+/month (analytics.js)

```javascript
// Installation
npm install @segment/analytics-node

// Setup
import Analytics from "@segment/analytics-node";
const analytics = new Analytics({
  writeKey: process.env.SEGMENT_WRITE_KEY,
});

// Track user journey
app.post("/api/crm/lead-intake-sync", async (req, res) => {
  const result = await crmClient.leadIntakeSyncFromVoice({...});
  
  // Track Phase 1 completion
  analytics.track({
    userId: result.applicationId,
    event: "phase_1_lead_intake_complete",
    properties: {
      phone: req.body.phone,
      disposition: req.body.disposition,
      channel: req.body.channel,
      campaign_id: req.body.campaignId,
    },
  });
});

app.post("/api/routing/check-eligibility", async (req, res) => {
  const result = await lenderClient.getEligibleLenders({...});
  
  // Track Phase 2 completion
  analytics.track({
    userId: req.body.phone,
    event: "phase_2_eligibility_complete",
    properties: {
      total_eligible: result.totalEligible,
      primary_lender: result.primaryLender?.lenderId,
      loan_amount: req.body.loanAmount,
    },
  });
});
```

**Events to Track:**
- `phase_1_lead_intake_complete` - Lead created
- `phase_2_eligibility_complete` - Routed to lender
- `phase_3_document_upload` - Doc uploaded
- `phase_4_lender_submission` - Submitted to lender
- `phase_4_loan_approved` - Loan approved
- `phase_5_loan_disbursed` - Funds transferred
- `phase_5_payment_received` - EMI paid
- `churn_payment_default` - Payment default

---

### Tier 4: API Management & Testing

#### 8. **Postman** (API Documentation & Testing)
**Free Tier:** Unlimited  
**Cost:** Free

```json
// Postman Collection Export (automation-hub.postman_collection.json)
{
  "info": {
    "name": "BuddyLoan Automation Hub",
    "description": "Complete API collection for lead intake → disbursal",
    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  },
  "item": [
    {
      "name": "Phase 1: Lead Intake",
      "item": [
        {
          "name": "Create Lead",
          "request": {
            "method": "POST",
            "url": "{{base_url}}/api/crm/lead-intake-sync",
            "body": {
              "phone": "919876543210",
              "name": "Rajesh Kumar",
              "age": 32,
              "income": 500000,
              "disposition": "interested"
            }
          },
          "tests": [
            "pm.test('Status is 201', function() { pm.response.to.have.status(201); });",
            "pm.test('Has applicationId', function() { pm.expect(pm.response.json().applicationId).to.exist; });"
          ]
        }
      ]
    },
    {
      "name": "Phase 2: Eligibility",
      "item": [
        {
          "name": "Check Eligibility",
          "request": {
            "method": "POST",
            "url": "{{base_url}}/api/routing/check-eligibility",
            "body": {
              "phone": "919876543210",
              "age": 32,
              "income": 500000,
              "cibilScore": 750,
              "hunterScore": 880,
              "loanAmount": 500000
            }
          },
          "tests": [
            "pm.test('Has eligible lenders', function() { pm.expect(pm.response.json().totalEligible).to.be.greaterThan(0); });"
          ]
        }
      ]
    }
  ]
}
```

**Use Cases:**
- API testing in CI/CD pipeline
- Manual testing before deployment
- Load testing (unlimited free tier)
- API documentation for partners

---

### Tier 5: Logging & Observability

#### 9. **ELK Stack** (Elasticsearch, Logstash, Kibana)
**Free & Open-Source** (Self-hosted) | **Elastic Cloud: $55+/month**

```javascript
// Installation
npm install winston winston-elasticsearch

// Setup logging
import winston from "winston";
import * as Elasticsearch from "winston-elasticsearch";

const esTransport = new Elasticsearch.ElasticsearchTransport({
  level: "info",
  clientOpts: {
    node: process.env.ELASTICSEARCH_URL,
  },
});

const logger = winston.createLogger({
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    esTransport,
  ],
});

// Log all critical operations
logger.info("Lead intake started", {
  phone: req.body.phone,
  phase: "phase_1",
  timestamp: new Date(),
});

logger.error("Eligibility check failed", {
  phone: req.body.phone,
  phase: "phase_2",
  error: error.message,
  stack: error.stack,
});
```

**Kibana Dashboards:**
- Error frequency by phase
- Latency distribution (histograms)
- Request patterns by time of day
- Database slow query log

---

#### 10. **Loki** (Log Aggregation - Lighter Alternative)
**Free & Open-Source**

```yaml
# loki-config.yml
auth_enabled: false

ingester:
  chunk_idle_period: 3m
  max_chunk_age: 1h
  max_streams_per_user: 100000

limits_config:
  enforce_metric_name: false

schema_config:
  configs:
    - from: 2020-10-24
      store: boltdb-shipper
      object_store: filesystem
      schema:
        version: v11
        index:
          prefix: index_
          period: 24h

server:
  http_listen_port: 3100
  log_level: info
```

---

## Recommended Free Tools & Integrations

### 1. **StatusPage.io** (Status Dashboard)
**Cost:** Free tier available

```
Public status page showing:
├─ IVR Router: ✅ Operational
├─ CRM Database: ✅ Operational
├─ Lender APIs: ✅ All up
├─ Payment Gateway: ✅ Operational
└─ Incident History
```

---

### 2. **Healthcheck.io** (Uptime Monitoring)
**Free Tier:** 50 checks

```bash
# Add health checks to Express
app.get("/health/crm", async (req, res) => {
  const health = await crmClient.healthCheck();
  res.status(health.success ? 200 : 503).json(health);
});

app.get("/health/routing", async (req, res) => {
  const health = await lenderClient.healthCheck();
  res.status(health.success ? 200 : 503).json(health);
});

# Monitor via healthcheck.io
https://hc-ping.com/[YOUR-UUID]  # Ping this endpoint
```

---

### 3. **Better Stack** (Uptime Monitoring + Status Page)
**Free Tier:** 3 monitors  
**Cost:** Free

```yaml
Monitors:
  - Name: IVR Router Health
    URL: https://ivr-router.buddyloan.com/health
    Check Interval: 60 seconds
    Alert on: Downtime > 5 min
    
  - Name: CRM Health
    URL: https://api.buddyloan.com/api/crm/health
    Check Interval: 60 seconds
    Alert on: Downtime > 5 min
    
  - Name: Lender Routing
    URL: https://api.buddyloan.com/api/routing/health
    Check Interval: 120 seconds
    Alert on: Response time > 2 sec
```

---

### 4. **Vercel** or **Render** (Hosting + Monitoring)
**Free Tier:** Generous  
**Cost:** Free → $20+/month

```yaml
# Deploy Phase by Phase
Phase 1: IVR Router
├─ Vercel Deploy
├─ Auto-generated status dashboard
├─ Automatic SSL
├─ Analytics included
└─ Free tier: 100GB bandwidth/month

Environment Variables:
├─ SUPABASE_URL
├─ SUPABASE_SERVICE_ROLE_KEY
├─ SENTRY_DSN
├─ SLACK_BOT_TOKEN
├─ SENDGRID_API_KEY
└─ Automatic secret management
```

---

### 5. **Datadog** (All-in-One Monitoring)
**Free Tier:** 5 hosts, limited history  
**Cost:** Free → $15/host/month (production)

```javascript
// Installation
npm install dd-trace

// Setup
import tracer from "dd-trace";
tracer.init({
  logInjection: true,
  env: process.env.NODE_ENV,
  service: "ivr-router",
  version: "1.0.0",
});

// Automatic tracking of:
// - Express routes
// - Database queries
// - External API calls
// - Errors & exceptions
```

---

## Complete Setup: Docker Compose Stack

```yaml
# docker-compose.yml - Local Development Stack

version: "3.9"

services:
  # === MONITORING STACK ===
  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus-data:/prometheus
    command:
      - "--config.file=/etc/prometheus/prometheus.yml"

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
      - GF_USERS_ALLOW_SIGN_UP=false
    volumes:
      - grafana-data:/var/lib/grafana
      - ./grafana/dashboards:/etc/grafana/provisioning/dashboards
    depends_on:
      - prometheus

  # === LOGGING STACK ===
  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.0.0
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false
    ports:
      - "9200:9200"
    volumes:
      - elasticsearch-data:/usr/share/elasticsearch/data

  kibana:
    image: docker.elastic.co/kibana/kibana:8.0.0
    ports:
      - "5601:5601"
    environment:
      - ELASTICSEARCH_HOSTS=http://elasticsearch:9200
    depends_on:
      - elasticsearch

  loki:
    image: grafana/loki:latest
    ports:
      - "3100:3100"
    volumes:
      - ./loki-config.yml:/etc/loki/local-config.yml
      - loki-data:/loki

  # === APPLICATION ===
  ivr-router:
    build: ./ivr-router
    ports:
      - "3000:3000"
    environment:
      - SUPABASE_URL=${SUPABASE_URL}
      - SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}
      - SENTRY_DSN=${SENTRY_DSN}
      - SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN}
      - ELASTICSEARCH_URL=http://elasticsearch:9200
    depends_on:
      - prometheus
      - elasticsearch
      - loki

volumes:
  prometheus-data:
  grafana-data:
  elasticsearch-data:
  loki-data:
```

---

## Implementation Roadmap

### Week 1: Core Monitoring
- [ ] Deploy Sentry
- [ ] Configure Prometheus + Grafana
- [ ] Create 5 dashboards (Phase 1-5)
- [ ] Setup PagerDuty alerts

### Week 2: Communication Layer
- [ ] Slack integration (6 channels)
- [ ] SendGrid email setup
- [ ] Segment analytics implementation
- [ ] Status page (StatusPage.io)

### Week 3: Logging & Analysis
- [ ] Deploy ELK stack
- [ ] Create Kibana dashboards
- [ ] Setup centralized logging
- [ ] Configure log retention policies

### Week 4: Testing & Hardening
- [ ] Export Postman collection
- [ ] Create API tests (automated)
- [ ] Load testing (Postman)
- [ ] Chaos engineering test (fail lender API)

---

## KPI Dashboards

### Executive Dashboard
```
KPI                          | Target      | Current
─────────────────────────────────────────────────────
Leads Created (Daily)        | 50,000      | 48,500
Lead → CRM (Latency)         | 30 sec      | 22 sec
Eligibility Routing Rate      | 95%         | 97%
Approval Rate (Avg Lender)   | 70%         | 68%
Collection Rate              | 85%         | 82%
System Uptime               | 99.9%       | 99.95%
```

### Operations Dashboard
```
Alert                        | Threshold   | Status
─────────────────────────────────────────────────────
Error Rate                  | < 5%        | ✅ 2.3%
API Latency (p99)          | < 2 sec     | ✅ 1.8 sec
Database CPU                | < 80%       | ✅ 45%
Elasticsearch Disk          | < 80%       | ✅ 62%
Unhandled Exceptions        | 0           | ✅ 0
```

---

## Budget Estimate (Monthly)

| Service | Free Tier | Paid Tier | Use Case |
|---------|-----------|-----------|----------|
| Sentry | 5K events | $29+ | Error tracking |
| Prometheus | ∞ | $0 | Metrics (self-hosted) |
| Grafana Cloud | 3 dashboards | $9+ | Dashboards |
| PagerDuty | 1 user | $9/user | On-call |
| Slack | 90-day history | $12.5/user | Communication |
| SendGrid | 100/day | $9.99 | Email |
| Datadog | 5 hosts | $15/host | All-in-one |
| ELK Cloud | Limited | $55+ | Log aggregation |
| **TOTAL** | **FREE** | **$150-300** | **Production** |

**Recommendation:** Start with free tier (Prometheus + Grafana + Sentry + Slack), upgrade to paid as volume increases.

---

This monitoring layer ensures complete visibility into all 5 phases with automatic alerting, dashboards, and seamless integration across the platform.

