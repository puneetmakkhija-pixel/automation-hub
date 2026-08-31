import crypto from "crypto";

/**
 * A stable customer id per mobile number.
 *
 * Minted the first time a number reaches us and reused for every contact
 * afterwards, so one person has one id across campaigns, application links and
 * message history.
 *
 * Deliberately NOT a dedupe key. Dedupe has to identify a call; this
 * identifies a caller. The same person ringing twice is two calls and one
 * customer, so keying dedupe on this would permanently suppress a genuine
 * second press. Call-level dedupe stays on unique_id from the IVR panel.
 */

const PREFIX = process.env.IVR_CUSTOMER_ID_PREFIX || "BL";

/**
 * Random rather than sequential. A sequential id leaks how many customers
 * exist and how fast they arrive, and these ids are meant to travel in
 * application URLs where an outsider can read them. 12 hex characters is 48
 * bits — collision odds stay negligible at this scale, and the UNIQUE
 * constraint would reject one anyway rather than merge two people.
 */
function mint() {
  return `${PREFIX}${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
}

/**
 * @param {object} client   a supabase-js client, or null when unconfigured
 * @param {string} phone    the normalised 10-digit number
 * @param {{campaignId?: string, variant?: string}} [context]
 * @returns {Promise<string|null>} the id, or null if it could not be resolved
 *
 * Never throws and never blocks a send. Every failure path returns null: the
 * message still goes out, just without an id attached. A missing identifier on
 * one message is a smaller loss than a customer who pressed 1 and heard
 * nothing because the database was unreachable.
 */
export async function resolveCustomerId(client, phone, context = {}) {
  if (!client || !phone) return null;

  try {
    // The common case: a number we have seen before. One round trip.
    const existing = await client
      .from("ivr_customers")
      .select("customer_id")
      .eq("phone_number", phone)
      .limit(1);

    if (existing.error) {
      console.error(`[IVR_WA] Customer id lookup failed: ${existing.error.message}`);
      return null;
    }
    if (existing.data?.length) return existing.data[0].customer_id;

    // First contact. ignoreDuplicates makes the insert a no-op when another
    // request registered this number a moment ago, rather than an error.
    const inserted = await client
      .from("ivr_customers")
      .upsert(
        [
          {
            phone_number: phone,
            customer_id: mint(),
            first_campaign_id: context.campaignId ?? null,
            first_variant: context.variant ?? null,
          },
        ],
        { onConflict: "phone_number", ignoreDuplicates: true }
      )
      .select("customer_id");

    if (inserted.error) {
      console.error(`[IVR_WA] Customer id mint failed: ${inserted.error.message}`);
      return null;
    }
    if (inserted.data?.length) {
      console.log(`[IVR_WA] New customer ${inserted.data[0].customer_id} for ${phone}`);
      return inserted.data[0].customer_id;
    }

    // Lost the race: the other request's id is the one that counts.
    const winner = await client
      .from("ivr_customers")
      .select("customer_id")
      .eq("phone_number", phone)
      .limit(1);

    if (winner.error) {
      console.error(`[IVR_WA] Customer id re-read failed: ${winner.error.message}`);
      return null;
    }
    return winner.data?.[0]?.customer_id ?? null;
  } catch (error) {
    console.error(`[IVR_WA] Customer id resolution threw: ${error.message}`);
    return null;
  }
}

export default resolveCustomerId;
