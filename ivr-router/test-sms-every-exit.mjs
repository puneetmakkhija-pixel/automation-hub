import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// SMS is only worth having if it fires on the exit that matters. The outage it
// was built for -- Meta pausing the template on 16 Sep, 724 callers reaching
// nothing -- ends at the PERMANENT branch, which is the one an author adding a
// new early return is least likely to think about.
//
// Inspected as source rather than exercised through the route: the handler
// needs Ananta, Supabase, the CRM and a live template to reach any of these
// branches, and a test that cannot reach the branch cannot guard it.

const SRC = readFileSync(new URL("./lib/routes/ivrWhatsAppRoutes.js", import.meta.url), "utf8");

/** The line index of each response that ENDS the send path. */
function sendPathExits() {
  const lines = SRC.split("\n");
  const marks = [];
  lines.forEach((line, i) => {
    if (/return res\s*$|return res\.(json|status)\(/.test(line)) marks.push({ i, line });
  });
  return { lines, marks };
}

test("every exit that follows a send attempt dispatches SMS first", () => {
  const { lines } = sendPathExits();

  // The three terminal outcomes of the send, by their distinguishing text.
  const exits = [
    { name: "success", find: (l) => l.includes("sent: true,") },
    { name: "permanent", find: (l) => l.includes("permanent: true,") },
    { name: "transient", find: (l) => l.includes('error: "Ananta send failed"') },
  ];

  for (const exit of exits) {
    const at = lines.findIndex(exit.find);
    assert.notEqual(at, -1, `could not find the ${exit.name} exit — has it been renamed?`);

    // Look back a small window for the dispatch.
    const window = lines.slice(Math.max(0, at - 25), at).join("\n");
    assert.match(
      window,
      /dispatchSms\(/,
      `the ${exit.name} exit returns without dispatching SMS. Every send-path exit ` +
        `must call dispatchSms, or a caller silently gets neither channel.`
    );
  }
});

test("the permanent exit dispatches with whatsappSent = false", () => {
  const { lines } = sendPathExits();
  const at = lines.findIndex((l) => l.includes("permanent: true,"));
  const window = lines.slice(Math.max(0, at - 25), at).join("\n");
  // Passing true here would mean "WhatsApp handled it" on the exact branch
  // where WhatsApp handled nothing, and fallback mode would send nothing.
  assert.match(window, /dispatchSms\(false,/);
});

test("the success exit dispatches with whatsappSent = true", () => {
  const { lines } = sendPathExits();
  const at = lines.findIndex((l) => l.includes("sent: true,"));
  const window = lines.slice(Math.max(0, at - 25), at).join("\n");
  // And false here would double-send on every successful lead in fallback mode.
  assert.match(window, /dispatchSms\(true,/);
});

test("dispatchSms is never awaited", () => {
  // Awaiting it would put a second gateway on the webhook's critical path,
  // which is what the fire-and-forget shape exists to avoid.
  assert.doesNotMatch(SRC, /await\s+dispatchSms\(/);
});
