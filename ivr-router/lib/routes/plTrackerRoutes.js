import express from "express";
import SupabaseClient from "../supabaseClient.js";
import {
  fetchSummary,
  fetchDetail,
  toCsv,
  summaryRows,
  SUMMARY_COLUMNS,
  DETAIL_COLUMNS,
  istToday,
  PL_LENDERS,
} from "../plTracker.js";

/**
 * The personal-loan press-1 tracker's API.
 *
 * Mounted behind CONSOLE_SECRET in index.js. Every row here is a customer's
 * mobile number, so this is one of the routes verifyWebhookSecret's failClosed
 * mode exists for: unconfigured, it answers 503 rather than serving the book.
 */
const router = express.Router();

let db = null;
let dbUnavailable = false;

function database() {
  if (db) return db;
  if (dbUnavailable) return null;
  try {
    db = new SupabaseClient();
    return db;
  } catch (error) {
    console.warn(`[PL_TRACKER] Database unavailable: ${error.message}`);
    dbUnavailable = true;
    return null;
  }
}

/** A day parameter is either an ISO date or absent. Never a guess. */
function dayParam(req) {
  const raw = String(req.query.day ?? "").trim();
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { error: "day must be YYYY-MM-DD" };
  return raw;
}

function lenderParam(req) {
  const raw = String(req.query.lender ?? "").trim().toLowerCase();
  if (!raw || raw === "all") return null;
  if (!PL_LENDERS.includes(raw)) return { error: `lender must be one of ${PL_LENDERS.join(", ")}` };
  return raw;
}

router.get("/summary", async (req, res) => {
  const day = dayParam(req);
  if (day?.error) return res.status(400).json({ success: false, error: day.error });

  const client = database()?.client;
  if (!client) return res.status(503).json({ success: false, error: "database not configured" });

  try {
    const summary = await fetchSummary(client, day);
    return res.json({ success: true, summary });
  } catch (error) {
    console.error(`[PL_TRACKER] summary failed: ${error.message}`);
    return res.status(502).json({ success: false, error: error.message });
  }
});

router.get("/export.csv", async (req, res) => {
  const day = dayParam(req);
  if (day?.error) return res.status(400).json({ success: false, error: day.error });
  const lender = lenderParam(req);
  if (lender?.error) return res.status(400).json({ success: false, error: lender.error });

  const scope = String(req.query.scope ?? "summary").trim();
  if (scope !== "summary" && scope !== "detail") {
    return res.status(400).json({ success: false, error: "scope must be summary or detail" });
  }

  const client = database()?.client;
  if (!client) return res.status(503).json({ success: false, error: "database not configured" });

  const onDay = day ?? istToday();

  try {
    let csv;
    let name;
    if (scope === "summary") {
      const summary = await fetchSummary(client, day);
      csv = toCsv(summaryRows(summary), SUMMARY_COLUMNS);
      name = `pl-ivr-summary-${onDay}.csv`;
    } else {
      const rows = await fetchDetail(client, { day: onDay, lender });
      csv = toCsv(rows, DETAIL_COLUMNS);
      name = `pl-ivr-presses-${lender ?? "all"}-${onDay}.csv`;
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    return res.send(csv);
  } catch (error) {
    console.error(`[PL_TRACKER] export failed: ${error.message}`);
    return res.status(502).json({ success: false, error: error.message });
  }
});

export default router;
