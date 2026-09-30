---
name: doctor
description: Check and fix the reels2Claude setup (yt-dlp, ffmpeg, whisper.cpp or a transcription API key). Use when the user wants to set up reels2Claude, when a reel check reports missing tools or no transcript, or when they ask to verify their transcription API key.
argument-hint: "[--check-keys]"
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/skills/reel/scripts/doctor.mjs")
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/skills/reel/scripts/doctor.mjs" *)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/skills/reel/scripts/install-whisper.mjs")
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/skills/reel/scripts/install-whisper.mjs" *)
---

# reels2Claude doctor

Run:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/reel/scripts/doctor.mjs" $ARGUMENTS
```

Then explain the result in plain language for a non-technical user:

- Say what's ready and what isn't, in a sentence or two.
- For each item under "To fix", give the exact command. Offer to run install commands for them, and
  run them only after they say yes. After installing, run the doctor again to confirm.
- **Transcription:** the default is whisper.cpp, which runs locally, is free, and uploads nothing.
  An online API (Groq, OpenAI, Gemini) is optional: it's used when the user sets
  `REELS2CLAUDE_PROVIDER` to it, or when whisper.cpp isn't installed and a key is set.
- **API keys:** never ask the user to paste a key into the chat, because the conversation isn't a
  safe place for secrets. Instead, tell them which file to put it in (the doctor prints the path,
  normally `~/.reels2claude/.env`) and the exact line to add, e.g. `GROQ_API_KEY=...`. If the file
  doesn't exist, you may create it with an empty placeholder line for them to fill in. Afterwards,
  suggest running the doctor with `--check-keys` to confirm the key works.
- If the status is "READY (partly)" (no speech-to-text set up), explain that reels can still be
  checked from the on-screen text and caption, then ask the user which they want, and wait:
  1. **Install whisper.cpp:** free and private, a one-time download of about 500 MB. After they say
     yes, run `node "${CLAUDE_PLUGIN_ROOT}/skills/reel/scripts/install-whisper.mjs"` (it takes a few
     minutes). If `ok` is false, explain `message` and any failed step's `commands`, offer to run
     them, run them only after a yes, then run the installer again.
  2. **Use an API key they already have:** follow the API-key rule above.
  3. **Neither for now:** fine; they'll be asked again at their next reel check.
