import test from "node:test";
import assert from "node:assert/strict";
import OBDApiClient from "./lib/obdApiClient.js";

// Compose stopped explaining itself:
//
//   {"ok":false,"error":"Compose campaign failed: HTTP 400","steps":[
//     {"step":"base","people":1,"test":true},
//     {"step":"tts","bytes":351129},
//     {"step":"prompt","id":"68339",...},
//     {"step":"contacts","id":"2774773",...}]}
//
// Four steps green, and a 400 with an EMPTY body on the fifth. Every earlier
// field was found by reading the dialler's complaint; there is no complaint to
// read now, so the request itself has to become visible.

function clientAnswering({ status = 200, body = "{}" } = {}, capture = {}) {
  const obd = new OBDApiClient("https://obd.test", "u", "p");
  obd.token = "tok";
  obd.userId = "501756";
  obd.tokenExpiry = Date.now() + 3600000;
  globalThis.fetch = async (url, init) => {
    capture.url = url;
    capture.body = JSON.parse(init.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async () => JSON.parse(body),
    };
  };
  return obd;
}

test("the raw compose hands back the bytes the dialler sent, empty ones included", async () => {
  const obd = clientAnswering({ status: 400, body: "" });
  const out = await obd.composeCampaignRaw({ campaignName: "P", baseId: "1" });
  assert.equal(out.status, 400);
  assert.equal(out.ok, false);
  // The whole point: an empty body is DATA, reported as such, not an exception
  // and not a missing field.
  assert.equal(out.text, "");
});

test("the raw compose does not throw on a refusal", async () => {
  const obd = clientAnswering({ status: 400, body: '{"message":"locationList is missing"}' });
  const out = await obd.composeCampaignRaw({ campaignName: "P" });
  assert.equal(out.status, 400);
  assert.match(out.text, /locationList is missing/);
});

test("the raw compose reports the exact payload that went out", async () => {
  const obd = clientAnswering();
  const out = await obd.composeCampaignRaw({ campaignName: "P", baseId: "2774773" });
  // Without this the probe can say what came back and not what provoked it,
  // which is the half of the conversation the last four rounds were missing.
  assert.equal(out.payload.campaignName, "P");
  assert.equal(out.payload.baseId, "2774773");
  assert.equal(out.payload.userId, "501756");
});

test("a 400 with no body says so, rather than dying on the parse", async () => {
  const obd = clientAnswering({ status: 400, body: "" });
  const err = await obd.composeCampaign({ campaignName: "P" }).then(() => null, (e) => e);
  assert.match(err.message, /Compose campaign failed: HTTP 400/);
  // No trailing dash: there was nothing to quote, and inventing punctuation
  // around an empty string reads like the dialler said something.
  assert.doesNotMatch(err.message, /\u2014/);
});

test("a 200 with no body is not a SyntaxError", async () => {
  // This is where the empty-body guard actually earns its place: the 400 path
  // throws before any parse, so only a SUCCESS with an empty body reaches
  // JSON.parse(""), and that raises "Unexpected end of JSON input" -- which
  // reads like this client is broken rather than like the dialler said nothing.
  const obd = clientAnswering({ status: 200, body: "" });
  const body = await obd.composeCampaign({ campaignName: "P" });
  assert.deepEqual(body, {});
});

test("compose still names the detail when the dialler gives one", async () => {
  const obd = clientAnswering({ status: 400, body: '{"message":"locationList is missing"}' });
  const err = await obd.composeCampaign({ campaignName: "P" }).then(() => null, (e) => e);
  assert.match(err.message, /HTTP 400 — .*locationList is missing/);
});

test("compose still refuses a 200 whose body says it failed", async () => {
  const obd = clientAnswering({ status: 200, body: '{"message":"Campaign Creation Failed"}' });
  const err = await obd.composeCampaign({ campaignName: "P" }).then(() => null, (e) => e);
  assert.match(err.message, /Campaign Creation Failed/);
});

test("compose still returns the body on a real success", async () => {
  const obd = clientAnswering({ status: 200, body: '{"campaignId":"c-42"}' });
  const body = await obd.composeCampaign({ campaignName: "P" });
  assert.equal(body.campaignId, "c-42");
});

test("the probe and a campaign send through the same function", async () => {
  // A probe that built its own payload would be answering a question nobody
  // asked. Both paths go through composeCampaignRaw, so what the probe learns
  // is true of the run.
  const capture = {};
  const obd = clientAnswering({ status: 200, body: '{"campaignId":"c-1"}' }, capture);
  await obd.composeCampaign({ campaignName: "VIA_COMPOSE", baseId: "9" });
  const viaCompose = capture.body;
  await obd.composeCampaignRaw({ campaignName: "VIA_COMPOSE", baseId: "9" });
  assert.deepEqual(capture.body, viaCompose);
  assert.match(capture.url, /\/api\/obd\/campaign\/compose$/);
});
