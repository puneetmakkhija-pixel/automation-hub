import test from "node:test";
import assert from "node:assert/strict";
import {
  OBD_ALLOWED_HOSTS,
  assertAllowedObdHost,
  obdClient,
} from "./lib/flexiloansCampaignOrchestrator.js";

// The vendor's own panel composes against obd3api.expressivr.com. This service
// posts to obdapi2.ivrsms.com, where uploads succeed and compose answers 400
// with an empty body. So compose needs testing against the other host -- which
// means obdClient takes a baseUrl, and THAT is a credential-exfiltration vector
// if taken on trust: the client logs in before every call, so an unchecked host
// would have this server post OBD_USERNAME and OBD_PASSWORD wherever asked.

test("both real OBD hosts are allowed", () => {
  assert.equal(assertAllowedObdHost("https://obdapi2.ivrsms.com"), "https://obdapi2.ivrsms.com");
  assert.equal(
    assertAllowedObdHost("https://obd3api.expressivr.com"),
    "https://obd3api.expressivr.com"
  );
});

test("a path on an allowed host is still allowed", () => {
  assert.equal(
    assertAllowedObdHost("https://obd3api.expressivr.com/api"),
    "https://obd3api.expressivr.com/api"
  );
});

test("an unknown host is refused, and the refusal names it", () => {
  assert.throws(
    () => assertAllowedObdHost("https://evil.test"),
    /Refusing to send OBD credentials to evil\.test/
  );
});

test("a host that merely CONTAINS an allowed name is refused", () => {
  // The whole reason this matches on host rather than substring:
  // obdapi2.ivrsms.com.evil.test contains the allowed string and is somebody
  // else's machine.
  for (const bad of [
    "https://obdapi2.ivrsms.com.evil.test",
    "https://evil.test/obdapi2.ivrsms.com",
    "https://obd3api.expressivr.com.attacker.example/api",
  ]) {
    assert.throws(() => assertAllowedObdHost(bad), /Refusing to send OBD credentials/, bad);
  }
});

test("credentials-in-the-URL trickery is refused", () => {
  // https://obdapi2.ivrsms.com@evil.test parses with host evil.test -- it reads
  // like the allowed host to a human skimming the string.
  assert.throws(
    () => assertAllowedObdHost("https://obdapi2.ivrsms.com@evil.test/"),
    /Refusing to send OBD credentials to evil\.test/
  );
});

test("garbage is refused as invalid rather than passed through", () => {
  for (const bad of ["not a url", "", "/api/obd", null]) {
    assert.throws(() => assertAllowedObdHost(bad), /Not a valid OBD base URL/, String(bad));
  }
});

test("omitting baseUrl keeps the configured host and checks nothing", () => {
  process.env.OBD_BASE_URL = "https://whatever-is-configured.test";
  assert.equal(obdClient().baseUrl, "https://whatever-is-configured.test");
});

test("passing an allowed baseUrl overrides the configured one", () => {
  process.env.OBD_BASE_URL = "https://obdapi2.ivrsms.com";
  assert.equal(obdClient("https://obd3api.expressivr.com").baseUrl, "https://obd3api.expressivr.com");
});

test("passing a refused baseUrl throws rather than falling back to the default", () => {
  // Falling back would be the dangerous failure: the caller asked for one host,
  // got another, and the result would be attributed to the wrong machine.
  process.env.OBD_BASE_URL = "https://obdapi2.ivrsms.com";
  assert.throws(() => obdClient("https://evil.test"), /Refusing to send OBD credentials/);
});

test("the allowlist is frozen", () => {
  assert.throws(() => OBD_ALLOWED_HOSTS.push("https://evil.test"), TypeError);
});
