# recordings/

The mp3s we have already paid ElevenLabs to say, kept so nothing generates
them twice.

`manifest.json` is the index: a key per recording, and the exact inputs the
audio was made with. The key is a hash of **text + voice + model + stability +
similarity** — everything that changes how a line sounds. Change any of them
and it is a different recording, because it is a different sound.

## Adding one

```bash
ELEVEN_LABS_API_KEY=... node scripts/add-recording.mjs \
  --text-file ./my-script.txt \
  --voice dVTC43Yewy5fAIcmsISI \
  --model eleven_flash_v2_5
```

Then **play the file**, and commit both the mp3 and the manifest.

Playing it is the point, not a formality. On 26 Aug 2026 a campaign uploaded
`[object Object]` to the dialler and the only symptom was a vague rejection
after the upload. A file sitting in the tree gets listened to before 50,000
people hear it.

`--dry-run` prints the key and filename without spending a generation.
`--text` takes the script inline instead of from a file.

## Why they are committed

Railway's filesystem is ephemeral. Anything the running service writes is gone
at the next deploy and was never visible to another instance, so the service
can read this directory but cannot usefully add to it. The library is the
repository; the server is a reader.

A miss at runtime still generates and still dials — nothing breaks — but it
logs `[RECORDINGS] miss for <key>`, which means that prompt is being paid for
on every run and belongs in here.

## Size

These are IVR prompts: a handful of lines, each a few seconds, reused across
hundreds of thousands of calls. That is the shape that belongs in git. If this
ever grows to per-customer audio, it does not — move to object storage and keep
only the manifest here.
