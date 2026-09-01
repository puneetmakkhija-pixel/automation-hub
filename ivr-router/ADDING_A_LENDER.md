# Adding a lender to the IVR keypress → WhatsApp flow

Adding a lender is **configuration, not code**. `lib/routes/ivrWhatsAppRoutes.js`
already accepts any variant on `POST /webhooks/ivr/whatsapp/:variant` and looks
its placeholders up in `IVR_VARIANT_PLACEHOLDERS`. Nothing in the router needs
to know a new lender exists.

## The two pieces

**1. The variant entry**, in `IVR_VARIANT_PLACEHOLDERS` on the
`ivr-voice-bot-system` service. Keyed by variant, then by DTMF digit:

```json
{
  "businessloans": { "1": [" ", "https://crmbusinessloans.com/apply"] },
  "herofincorp":   { "1": [" ", "https://loans.apps.herofincorp.com/en/personal-loan?af_xp=custom&…"] }
}
```

**2. The panel webhook.** In voice2.ivrsms.com, point the campaign at

```
https://<service-domain>/webhooks/ivr/whatsapp/<variant>?token=<ANANTA_WEBHOOK_SECRET>
```

The token goes in the query string because the panel offers a bare URL field
with no way to add a header — see `lib/middleware/verifyWebhookSecret.js`.

One webhook per destination is the sturdier arrangement: it does not depend on
`campaign_id` being included in the configured body, and it is how an operator
thinks about it. A variant with no entry falls back to `IVR_DTMF_PLACEHOLDERS`,
so a mistyped suffix sends the default link rather than nothing.

## Hero Fincorp

Panel webhook:

```
https://<service-domain>/webhooks/ivr/whatsapp/herofincorp?token=<ANANTA_WEBHOOK_SECRET>
```

Variant entry to **merge into** the existing `IVR_VARIANT_PLACEHOLDERS` — do not
replace the variable, or the other lenders configured in it are lost:

```json
{"herofincorp": {"1": [" ", "https://loans.apps.herofincorp.com/en/personal-loan?af_xp=custom&source_caller=ui&pid=Buddyloan&utm_medium=4636&utm_campaignid=IVR&is_retargeting=true&utm_source=partnership_BDL&shortlink=qtuldaei&utm_campaign=Buddyloan&af_reengagement_window=30d&c=Buddyloan_ACQ_08052025&referrer=af_tranid=Jog5Tb-3i0OzCfrWRkQShg&utm_source=partnership_BDL&af_android_url=https://loans.apps.herofincorp.com/en/personal-loan&utm_campaign=Buddyloan&c=Buddyloan_ACQ_08052025&pid=Buddyloan&af_ios_url=https://loans.apps.herofincorp.com/en/personal-loan"]}}
```

The link is 532 characters, nearly three times the Poonawalla one, so the
shortener earns its keep here more than anywhere: with `ANANTA_IS_SHORT_URL=1`
(the default) it reaches the customer as `op2.in/wt/<code>`.

Paste the AppsFlyer URL **verbatim**. It repeats `utm_source`, `utm_campaign`,
`pid` and `c`, and carries a bare `=` inside `referrer=af_tranid=…`. That looks
malformed and is not — it is how AppsFlyer deep links are built, and
"tidying" it breaks attribution. The router never parses the link; it passes the
placeholder straight through.

## Checking it

The placeholder count must match the template exactly or Ananta answers 1325 /
1327 instead of sending. After adding the entry, press 1 on a test call to that
campaign and confirm in the send log:

```sql
SELECT created_at,
       phone_number,
       metadata->>'variant'    AS variant,
       metadata->>'template'   AS template,
       metadata->>'status'     AS status,
       metadata->>'link'       AS link
  FROM public.whatsapp_messages
 WHERE metadata->>'source' = 'ivr_keypress_webhook'
   AND metadata->>'variant' = 'herofincorp'
 ORDER BY created_at DESC
 LIMIT 5;
```

`link` is the URL handed to Ananta, always full length — the shortening happens
on their side, so the log stays readable.

## What this flow does *not* use

`lib/ivr/ivrRouter.js` carries a hardcoded `poonawala` config with a
`fallback_url` for Hero Fincorp on an older campaign (`utm_medium=588`,
`utm_campaignid=IVRSMS`). It is **dead code** — reached only through
`lib/services/voiceBotService.js`, which nothing imports. It is not what a
caller receives, and editing it changes nothing. The live path is
`IVR_VARIANT_PLACEHOLDERS` plus the webhook above.
