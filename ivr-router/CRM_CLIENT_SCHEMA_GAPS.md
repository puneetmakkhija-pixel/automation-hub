# The voice side of the CRM

`lib/crmIntegrationClient.js` was written against a CRM that does not exist as
described: every method keyed on an `application_id`, and the intake method
called an RPC whose signature it had invented. None of it worked, and because
each method catches its own error and returns `{ success: false }`, nothing ever
said so out loud.

It is now keyed on the **lead**. This page records why, and what is left.

## Why the lead and not the application

Checked against the live `smecircle` database:

| Table | Rows | |
| --- | --- | --- |
| `crm.leads` | 80,034 | the book of business |
| `crm.lead_events` | 10,981 | append-only audit trail, in active use |
| `crm.applications` | **0** | has `application_id`, holds nothing |
| `crm.pbx_calls` | 0 | purpose-built for call detail, unused so far |

`crm.applications` is the only table with an `application_id`, and it is empty.
Nothing on the voice side has ever held one — the callback from a voice provider
carries a phone number, not an application. So `:ref` on every route is either a
`crm.leads.id` or a phone number, and `resolveLead()` accepts both.

Phone matching is on the **last ten digits**. The same subscriber arrives as
`9876543210`, `919876543210` and `+91 98765 43210` depending on the door, and
one phone can legitimately match several leads — the most recently updated wins,
with `matchCount` returned alongside so a caller can tell it was ambiguous.

## What each method writes

| Method | Table | Notes |
| --- | --- | --- |
| `getLead(ref)` | `crm.leads` | Read. |
| `logVoiceDisposition({ref, disposition, details, type})` | `crm.lead_events` | `type` is an enum, default `'call'`. The disposition and details are serialised into `note` — the table has no column for either, and inventing one was the original bug. |
| `recordVoiceCall({ref, providerCallId, metrics})` | `crm.pbx_calls` | Keyed on the provider's own call id, so a redelivered callback updates that call rather than adding a second. This is where duration, disposition and recording url live; `crm.leads` has no columns for them. |
| `updateLeadStage({ref, stage, substate})` | `crm.leads` + `crm.lead_events` | Reads first so the `stage_change` event can carry `from_stage`. A failed audit row is reported, not thrown — the stage really did move. |
| `healthCheck()` | `crm.leads` | |

The enums are exported as `LEAD_STAGES` and `LEAD_EVENT_TYPES`, and served at
`GET /api/crm/vocabulary`, so a rejected value can be looked up rather than
guessed. Note that `"Documents"` — the stage the old route documentation used as
its example — is not one of them.

## Lead creation is deliberately not implemented

`POST /api/crm/lead-intake-sync` and `/batch-lead-intake` answer `501`.

`crm.lead_intake_sync` is real, but it is not what the code assumed. Its actual
signature is:

```sql
crm.lead_intake_sync(p_secret text, p_rows jsonb) returns jsonb
```

It authorises against `crm.app_config` (keys `sync_secret` / `sync_secret_next`),
takes an **array** of rows carrying `mobile`, `agent_name`, `agent_ecode`,
`tl_name`, `source` and `entry_date`, upserts them into `crm.lead_intake` keyed
on (mobile, entry_date), and returns
`{ok, received, upserted, skipped_no_mobile}`. It is a **bulk agent-attribution
importer**, it creates no application, and it returns no identifier of any kind.

The old code called it with fifteen scalar `p_*` arguments, so it never ran.

Creating leads from voice therefore needs a decision that is not this module's
to make: what may write into an 80,034-row book of business, on what
deduplication rule. Until that is settled the endpoints say so rather than
silently failing.

## The `/application/...` routes

They answer `410` with the replacement path rather than `404`, so a caller that
still has one learns where to go. They are gone for the reason above: there is
no application to address.

## Not the same thing as `DSA_CRM_Data_Model.pdf`

That document models **"Grid"** — the BuddyLoan / Paisabazaar DSA CRM user
interface — reverse-engineered from three screen captures with, in its own
words, "no schema access", and marked draft pending validation. Its entities
(`LEAD_CUSTOMER`, `APPOINTMENT` keyed on a per-bank `ref_number`,
`LENDER_QUOTE`) are not the tables in this Supabase project, and its field
lists do not match `crm.leads`.

It is useful here for one thing only, and it agrees with the decision above:
there is no `application_id` in that model either. Its keys are the customer and
the per-bank case.
