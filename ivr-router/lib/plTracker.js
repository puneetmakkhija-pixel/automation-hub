/**
 * Press-1 tracking for the personal-loan IVR campaigns.
 *
 * Poonawalla and Hero Fincorp are a different product from Business Loans. The
 * press sends the customer into that lender's own journey, so the lead never
 * enters the CRM and no cockpit screen reports on it — public.whatsapp_messages,
 * written by this service's own keypress webhook, is the only record that the
 * call happened at all.
 *
 * The aggregation lives in public.pl_ivr_tracker() rather than here. At roughly
 * 6,700 presses a day, counting a month in Node would mean pulling ~200,000 rows
 * per page load, and PostgREST cannot group.
 *
 * ── the lender is the link, not the variant ────────────────────────────────
 *
 * Two rows in the send log carry variant 'herofincorp' and a Poonawalla link.
 * The variant is the slug the panel was pointed at; the link is where the
 * customer actually went. Only one of those is what happened to a person, so
 * lenderOfLink() reads the link, and the disagreement is surfaced as a count
 * rather than resolved silently — one lender's customers arriving in another
 * lender's journey is the most expensive mistake this webhook can make, and
 * nothing else in the system would notice.
 */

/**
 * Where the customer was actually sent.
 *
 * Mirrors public.pl_press_lender() in the database (migration 005), which is
 * what pl_ivr_tracker() and the enrichment job read. Change the two together
 * or the sheet and the header count start disagreeing about the same day.
 */
export function lenderOfLink(link) {
  const l = String(link || "").toLowerCase();
  if (l.includes("poonawallafincorp")) return "poonawalla";
  if (l.includes("herofincorp")) return "herofincorp";
  if (l.includes("crmbusinessloans")) return "businessloans";
  // Poonawalla behind the Whistleloop affiliate shortener, which never carries
  // the lender's own domain. On 03-04 Sep 2026 this shape accounted for 3,740
  // presses that read as "unknown" and dropped out of Poonawalla's numbers —
  // 4 Sep showed ~952 against an actual ~4,568.
  //
  // Keyed on the offer id, not on the PFL_% campaign name: all 3,740 carried
  // offerid=1351 and nothing else, while the campaign name is typed by hand in
  // the IVR panel and one of those rows was not named PFL at all. A new offer
  // id for the same lender will read as "unknown" rather than be guessed at.
  if (l.includes("whistleloop") && l.includes("offerid=1351")) return "poonawalla";
  return "unknown";
}

/** Personal loans. businessloans is excluded — that product has the CRM. */
export const PL_LENDERS = ["poonawalla", "herofincorp", "unknown"];

export const LENDER_LABELS = {
  poonawalla: "Poonawalla Fincorp",
  herofincorp: "Hero Fincorp",
  unknown: "Unrecognised link",
};

/** IST is fixed at +05:30 — India has no daylight saving. */
const IST = "+05:30";

/** ISO bounds for one IST calendar day, as PostgREST wants them. */
export function istDayBounds(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ""))) {
    throw new Error(`bad day: ${day}`);
  }
  const next = new Date(`${day}T00:00:00${IST}`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { from: `${day}T00:00:00${IST}`, to: next.toISOString() };
}

/** Today in IST, as YYYY-MM-DD. */
export function istToday(now = new Date()) {
  return new Date(now.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export async function fetchSummary(client, day = null) {
  const { data, error } = await client.rpc("pl_ivr_tracker", { p_day: day });
  if (error) throw new Error(error.message);
  return data;
}

/**
 * The presses themselves, for one IST day.
 *
 * Bounded to a day on purpose: this is the sheet a lender desk works from, and
 * an unbounded export of every mobile we ever messaged is both useless to them
 * and the kind of file that ends up somewhere it should not.
 */
export async function fetchDetail(client, { day, lender = null, limit = 20000 }) {
  const { from, to } = istDayBounds(day);
  const { data, error } = await client
    .from("whatsapp_messages")
    .select("phone_number,created_at,metadata")
    .gte("created_at", from)
    .lt("created_at", to)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);

  return (data ?? [])
    .filter((r) => r.metadata && r.metadata.digit === "1")
    .map((r) => {
      const m = r.metadata ?? {};
      const resolved = lenderOfLink(m.link);
      return {
        lender: resolved,
        lender_name: LENDER_LABELS[resolved] ?? resolved,
        mobile: String(r.phone_number ?? "").replace(/\D/g, "").slice(-10),
        campaign: m.campaign_name ?? "(unnamed campaign)",
        // Kept beside the resolved lender so a mismatch is visible in the sheet,
        // not only in the header count.
        variant: m.variant ?? "",
        variant_matches_link: !m.variant || m.variant === resolved ? "yes" : "NO",
        status: m.status ?? "sent",
        template: m.template ?? "",
        customer_id: m.customer_id ?? "",
        message_id: m.message_id ?? "",
        sent_at_ist: new Date(new Date(r.created_at).getTime() + 5.5 * 3600 * 1000)
          .toISOString()
          .replace("T", " ")
          .slice(0, 19),
        link: m.link ?? "",
      };
    })
    .filter((r) => PL_LENDERS.includes(r.lender))
    .filter((r) => !lender || r.lender === lender);
}

export const DETAIL_COLUMNS = [
  "sent_at_ist",
  "lender_name",
  "campaign",
  "mobile",
  "status",
  "variant",
  "variant_matches_link",
  "customer_id",
  "template",
  "message_id",
  "link",
];

/**
 * CSV, not .xlsx.
 *
 * Excel opens this directly and it costs no dependency in a service that has
 * nine. The BOM is what stops Excel mangling a UTF-8 name into mojibake, and
 * the leading apostrophe rule is what stops it turning a 10-digit mobile into
 * 9.81235e+09 — both are the difference between a file someone can use and a
 * file they send back.
 */
export function toCsv(rows, columns) {
  const cell = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    // A bare = + - @ leads Excel to evaluate the cell as a formula.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((c) => cell(row[c])).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** Summary as a flat sheet: one row per lender per campaign. */
export function summaryRows(summary) {
  const byLender = new Map((summary?.lenders ?? []).map((l) => [l.lender, l]));
  return (summary?.campaigns ?? []).map((c) => ({
    lender_name: LENDER_LABELS[c.lender] ?? c.lender,
    campaign: c.campaign,
    presses_today: c.ftd_presses,
    presses_mtd: c.presses,
    distinct_phones_mtd: c.phones,
    first_press_ist: String(c.first_at ?? "").replace("T", " "),
    last_press_ist: String(c.last_at ?? "").replace("T", " "),
    lender_presses_today: byLender.get(c.lender)?.ftd_presses ?? 0,
    lender_presses_mtd: byLender.get(c.lender)?.mtd_presses ?? 0,
  }));
}

export const SUMMARY_COLUMNS = [
  "lender_name",
  "campaign",
  "presses_today",
  "presses_mtd",
  "distinct_phones_mtd",
  "first_press_ist",
  "last_press_ist",
  "lender_presses_today",
  "lender_presses_mtd",
];
