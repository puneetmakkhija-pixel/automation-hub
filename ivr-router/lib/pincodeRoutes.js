import express from "express";
import PincodeGatingClient from "./pincodeGatingClient.js";

const router = express.Router();
let gatingClient = null;

try {
  gatingClient = new PincodeGatingClient();
} catch (error) {
  console.warn('⚠️ Pincode Gating Client initialization failed:', error.message);
  console.warn('   Pincode validation features will be unavailable until Supabase is configured');
}

// Guard: Check if gating client is available
router.use((req, res, next) => {
  if (!gatingClient) {
    return res.status(503).json({
      success: false,
      error: 'Pincode Gating Client not initialized - Supabase configuration required',
    });
  }
  next();
});

router.get("/health", async (_req, res) => {
  try {
    const result = await gatingClient.healthCheck();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post("/validate", async (req, res) => {
  try {
    const { pincode, lenderType = "poonawala" } = req.body;

    if (!pincode) {
      return res.status(400).json({ success: false, error: "Pincode is required" });
    }

    const result = await gatingClient.validatePincode(pincode, lenderType);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post("/check-eligibility", async (req, res) => {
  try {
    const { customerData, lenderType = "poonawala" } = req.body;

    if (!customerData) {
      return res.status(400).json({ success: false, error: "Customer data is required" });
    }

    const eligibility = await gatingClient.checkEligibility(customerData, lenderType);

    await gatingClient.createGatingLog(customerData.phone, eligibility, lenderType);

    res.json({
      success: true,
      eligible: eligibility.eligible,
      eligibility,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post("/bulk-upload-pincodes", async (req, res) => {
  try {
    const { pincodes, lenderType = "poonawala" } = req.body;

    if (!pincodes || !Array.isArray(pincodes) || pincodes.length === 0) {
      return res.status(400).json({ success: false, error: "Pincodes array is required" });
    }

    const result = await gatingClient.bulkUploadPincodes(pincodes, lenderType);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/stats", async (req, res) => {
  try {
    const { lenderType = "poonawala" } = req.query;
    const stats = await gatingClient.getPincodeStats(lenderType);
    res.json({ success: true, ...stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/pincodes", async (req, res) => {
  try {
    const { lenderType = "poonawala", limit = 50, offset = 0 } = req.query;

    const { data, error } = await gatingClient.supabase
      .from("serviceable_pincodes")
      .select("*")
      .eq("lender_type", lenderType)
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (error) throw error;

    res.json({
      success: true,
      lenderType,
      pincodes: data || [],
      limit: parseInt(limit),
      offset: parseInt(offset),
      count: data?.length || 0,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post("/search-pincode", async (req, res) => {
  try {
    const { pincode, lenderType = "poonawala" } = req.body;

    if (!pincode) {
      return res.status(400).json({ success: false, error: "Pincode is required" });
    }

    const { data, error } = await gatingClient.supabase
      .from("serviceable_pincodes")
      .select("*")
      .eq("pincode", String(pincode).padStart(6, "0"))
      .eq("lender_type", lenderType);

    if (error) throw error;

    res.json({
      success: true,
      pincode,
      found: (data?.length || 0) > 0,
      data: data || [],
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
