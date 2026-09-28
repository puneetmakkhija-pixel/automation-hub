import { argv } from "node:process";
import { pathToFileURL } from "node:url";
import { pollVoiceOutcomes } from "../lib/voiceOutcomePoll.js";

// The scheduled half of lib/voiceOutcomePoll.js. Its own header said "behind
// an operator endpoint and, later, a schedule" -- this is that schedule.
// Nothing else ever called it: crm.journey_run_log.voice_status stayed "sent"
// forever on any call ElevenLabs didn't ring, invisible to anything (in this
// repo or in dsa-business-crm) that reads voice_disposition to decide whether
// a lead needs a redial.
//
// Deployed as its own Railway service (root directory `ivr-router`, Railpack,
// `npm run voice-poll:cron`), the same pattern as data-jobs' three cron
// services -- see README.md's service table. pollVoiceOutcomes() never
// throws and every write is conditioned on the row still being unclaimed, so
// a run overlapping the next one, or the /api/voice-poll/run console route,
// is safe.

async function main() {
  const result = await pollVoiceOutcomes();
  console.log(`[voice-poll-cron] ${JSON.stringify(result)}`);
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  main().catch((error) => {
    console.error("[voice-poll-cron]", error.message);
    process.exit(1);
  });
}
