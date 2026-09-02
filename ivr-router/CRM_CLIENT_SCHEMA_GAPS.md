# `crmIntegrationClient.js` vs. the real CRM schema

`lib/crmIntegrationClient.js` was written against a CRM that does not exist as
described. Correcting `.from("crm.leads")` to `.schema("crm").from("leads")`
made the client reach the right tables; it did not make most of its methods
work, because the columns underneath are different too.

This page records what was checked against the live `smecircle` database so the
remaining work can be scoped without re-deriving it.

## What `crm.leads` actually has

```
id, channel, dsa_partner_id, agent_user_id, lender_id, application_number,
client_reference_id, lan_id, customer_name, phone, pincode, gst_no,
business_name, stage, lender_status, rejection_reason, loan_amount_req,
approved_amount, disbursed_amount, loan_case_id, score, grade, score_json,
scored_at, next_action, source, created_by, created_at, updated_at,
stage_substate, sanction_amount, pan
```

There is **no `application_id`**, and no call-metric columns at all. `stage` and
`channel` are enums:

- `lead_stage`: `new, contacted, docs_pending, docs_received, digitap_submitted, bre_review, lender_assigned, logged_in, move_to_credit, approved, disbursed, rejected, dropped`
- `lead_channel`: `call_center, dsa`

`crm.lead_events` is `id, lead_id (bigint NOT NULL), type (lead_event_type NOT
NULL), from_stage, to_stage, note, actor, created_at, from_substate,
to_substate`, where `lead_event_type` is `created, stage_change, call, note,
doc_update, status_sync, assignment`.

## Method by method

| Method | State | What is wrong |
| --- | --- | --- |
| `healthCheck` | **works now** | Only needed the schema fix. |
| `leadIntakeSyncFromVoice` | broken | Calls `lead_intake_sync` with fifteen scalar `p_*` arguments. The real function is `crm.lead_intake_sync(p_secret text, p_rows jsonb)` — a different signature, and in the `crm` schema, so a default-schema `.rpc()` would not find it either. |
| `updateApplicationWithCallMetrics` | broken | Writes `call_duration`, `call_disposition`, `dtmf_choice`, `answered`, `call_recording_url` — none exist on `crm.leads`. Filters on `application_id`, which does not exist. Only `updated_at` is real. |
| `logVoiceDisposition` | broken | Inserts `application_id`, `event_type`, `event_data` into `crm.lead_events`. None of the three exist; the table wants `lead_id` and an enum `type`, with free text in `note`. |
| `getApplication` | broken | Selects `application_id`, `name`, `substage`, `eligible_lenders`, `best_lender` — none exist. `phone`, `stage` and `created_at` do; `name` is `customer_name` and `substage` is `stage_substate`. |
| `updateApplicationStage` | broken | `substage` should be `stage_substate`, and the `application_id` filter does not exist. |

All six are reachable over HTTP through `lib/crmIntegrationRoutes.js`, so these
are live endpoints returning `{ success: false }`, not dead code.

## What has to be decided before fixing the rest

1. **What is `applicationId`?** Callers pass it to four methods. `crm.leads` has
   `id` (bigint), `application_number` (text) and `client_reference_id` (text).
   Which one the IVR side holds decides every filter and the `lead_events.lead_id`
   foreign key.
2. **Where do call metrics go?** There is no home for duration, disposition,
   DTMF choice or a recording URL on `crm.leads`. `crm.voice_call_events` now
   takes exactly this shape per provider, and `crm.call_outcome` and
   `crm.pbx_calls` also exist. Either the metrics move to one of those, or
   `crm.leads` needs the columns added.
3. **Where does the `lead_intake_sync` secret come from?** The real function
   takes `p_secret` and a `p_rows` batch. Nothing in this repo holds that
   secret or builds that batch.

Until those are settled the honest state is: the schema prefix is right, the
health check works, and the other five methods fail with a precise column error
instead of a misleading "relation does not exist".
