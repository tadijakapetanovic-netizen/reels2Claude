---
name: doctor
description: Check and fix the reels2Claude setup (yt-dlp, ffmpeg, a transcription key). Use when the user wants to set up reels2Claude, when a reel check reports missing tools or no transcript, or when they ask to verify their transcription API key.
argument-hint: "[--check-keys]"
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/skills/reel/scripts/doctor.mjs")
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/skills/reel/scripts/doctor.mjs" *)
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
- **API keys:** never ask the user to paste a key into the chat, because the conversation isn't a
  safe place for secrets. Instead, tell them which file to put it in (the doctor prints the path,
  normally `~/.reels2claude/.env`) and the exact line to add, e.g. `GROQ_API_KEY=...`. If the file
  doesn't exist, you may create it with an empty placeholder line for them to fill in. Afterwards,
  suggest running the doctor with `--check-keys` to confirm the key works.
- If the status is "READY (partly)", explain that reels can still be checked from the on-screen text
  and caption, but speech won't be transcribed until a provider is set up. Recommend Groq (free, no
  credit card).
