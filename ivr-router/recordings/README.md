# recordings/

The mp3s we have already paid ElevenLabs to say, kept so nothing generates
them twice.

`manifest.json` is the index: a key per recording, and the exact inputs the
audio was made with. The key is a hash of **text + voice + model + stability +
similarity** — everything that changes how a line sounds. Change any of them
and it is a different recording, because it is a different sound.

## Importing what ElevenLabs already has

ElevenLabs keeps every generation and its audio. Those are already paid for, so
importing them is the cheapest way to fill this directory — nothing is generated
and nothing is billed.

```bash
# ALWAYS look first. Lists what would be imported; downloads nothing.
ELEVEN_LABS_API_KEY=... node scripts/import-history.mjs --dry-run

# then narrow it and run for real
ELEVEN_LABS_API_KEY=... node scripts/import-history.mjs --voice dVTC43Yewy5fAIcmsISI
```

Filters: `--voice`, `--model`, `--contains <text>`, `--since YYYY-MM-DD`,
`--limit`, `--max-pages`. History is usually mostly experiments, so the dry run
and a filter matter more than they look.

Re-running is safe — anything already in the manifest is skipped, so an
interrupted import continues where it stopped.

One caveat the script warns about: a history item that does not report the voice
settings it was made with is keyed on this library's defaults (0.5 / 0.75). If a
run still misses such a prompt, regenerate that one with `add-recording.mjs`.

## Adding one

```bash
ELEVEN_LABS_API_KEY=... node scripts/add-recording.mjs \
  --text-file ./my-script.txt \
  --voice dVTC43Yewy5fAIcmsISI \
  --model eleven_multilingual_v2   # the campaign's model, and the default
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
