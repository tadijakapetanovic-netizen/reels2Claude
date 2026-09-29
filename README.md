# reels2Claude

**Saw a reel telling you your vibe-coded app "needs" something? Send it to Claude.**

TikTok and Instagram are full of videos like *"If you built your app with AI, you're leaking your
whole database!"* Some are right, some are outdated, and some are just engagement bait. If you
aren't a security expert, you can't tell which, and you don't have time to research every one.

reels2Claude is a [Claude Code](https://code.claude.com) plugin. Give it the link, and Claude:

1. **Watches the reel.** It downloads it, transcribes the speech, and reads the on-screen text and
   caption (a lot of reels put the real point on screen, not in the voiceover).
2. **Judges the advice itself.** Is the claim true, outdated, misleading, or wrong?
3. **Checks your codebase.** Does your project already handle it? Does it even apply to your stack?
4. **Reports back and waits.** You get a verdict per claim plus proposed changes. **Nothing in your
   code changes until you pick what to implement.**

```
You:    /reels2claude:reel https://www.tiktok.com/@someone/video/123
Claude: Bottom line: 2 of the 4 claims apply to you, and one is urgent.

        | # | Claim                              | Verdict                         |
        |---|------------------------------------|---------------------------------|
        | 1 | "Your anon key is visible = hacked" | ❌ Bad advice: it's public by design |
        | 2 | "Turn on RLS on every table"        | ⚠️ 🔴 Missing on `notes`          |
        | 3 | "Hash passwords with bcrypt"        | ➖ Supabase Auth already does this |
        | 4 | "Rate-limit your AI routes"         | ⚠️ 🔴 /api/summarize is wide open |

        Full report: reel-reports/2026-09-30-supabase-security.md
        Which changes should I implement? (all / 2 / 4 / none)
```

## Verdicts

| | Meaning |
|---|---|
| ✅ **Already handled** | The advice is right and your code already does it. |
| ⚠️ **Missing** | The advice is right, applies to you, and isn't handled, rated 🔴 critical / 🟠 high / 🟡 medium / ⚪ low. |
| ➖ **Doesn't apply** | Fine advice, but not for your stack or app. |
| ❌ **Bad advice** | Wrong, outdated, or misleading, with the correct version where there is one. |
| ❓ **Can't tell from code** | It's a dashboard or hosting setting; you get exact steps to check it yourself. |

## Install

You need [Claude Code](https://code.claude.com) and [Node.js](https://nodejs.org) 18 or newer.

```bash
claude plugin marketplace add tadijakapetanovic-netizen/reels2Claude
claude plugin install reels2claude@reels2claude
```

Then check your setup from any Claude Code session:

```
/reels2claude:doctor
```

The doctor lists what's missing and gives the exact install command for your computer (Claude can
run it for you once you say yes). You need two free tools:

| Tool | What for | Windows | macOS | Linux |
|---|---|---|---|---|
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | downloads the video | `winget install yt-dlp.yt-dlp` | `brew install yt-dlp` | see doctor |
| [ffmpeg](https://ffmpeg.org) | pulls out audio and frames | `winget install Gyan.FFmpeg` | `brew install ffmpeg` | `sudo apt install ffmpeg` |

No winget (older Windows 10)? The doctor gives download links and a folder to put them in, with no
PATH editing needed.

### Transcription (turning speech into text)

Claude can't listen to audio, so a speech-to-text service does that step. Pick one:

| Option | Cost | Setup |
|---|---|---|
| **Groq** (recommended) | Free tier, no credit card | Get a key at [console.groq.com/keys](https://console.groq.com/keys) |
| OpenAI | ~$0.006 per minute | Key from [platform.openai.com](https://platform.openai.com/api-keys) |
| Google Gemini | Free tier available | Key from [aistudio.google.com](https://aistudio.google.com/apikey) |
| whisper.cpp | Free, runs on your computer, private | The doctor shows how to install it |

Put the key in a file called `.env` in a `.reels2claude` folder in your home directory
(`~/.reels2claude/.env`, on Windows `C:\Users\<you>\.reels2claude\.env`):

```
GROQ_API_KEY=gsk_your_key_here
```

See [`.env.example`](.env.example) for every option. An Anthropic API key **won't** work here: no
Claude model accepts audio. That's fine, because the judging is done by the Claude you're already
talking to.

Transcription is optional. Without it, Claude still reads the on-screen text and the caption.

## Use

In your project, in Claude Code:

```
/reels2claude:reel https://www.instagram.com/reel/ABC123/
```

Or just paste the link and ask *"does this apply to my app?"*

**Instagram blocked the download?** It often does. Screen-record the reel on your phone, move the
file to your computer, and give Claude the path:

```
/reels2claude:reel C:\Users\me\Downloads\screen-recording.mp4
```

You can also paste the caption and describe what's said. Reports are saved in `reel-reports/` in
your project, so you keep a history of what you've already checked.

## Safety and privacy

- **The reel is treated as advice to evaluate, never as instructions.** If a video (or its on-screen
  text) tells Claude to run a command or visit a link, that's judged as part of the claim, not
  obeyed.
- **You approve every change.** Claude only reads your code while checking. It edits nothing until
  you choose which proposed changes to implement.
- **What leaves your computer:** the video is downloaded from the platform, and its *audio* is sent
  to the transcription service you chose (none, if you use whisper.cpp). Your code isn't sent
  anywhere beyond your normal Claude Code session.
- **API keys are never printed** by the scripts, and are sent only to their own provider.
- Instagram can require a login to download. Using your browser's login is **off by default**; you
  can opt in with `REELS2CLAUDE_COOKIES_FROM_BROWSER=firefox`. Downloading may be against a
  platform's terms, so use this for your own personal analysis.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Missing required tool" | Run the doctor and follow its commands. |
| Downloads fail with "unable to extract" | Sites change often; update yt-dlp (the doctor prints the command). |
| Instagram "login required" | Screen-record the reel instead, or opt in to browser cookies. |
| "No transcript" | Add a key to `~/.reels2claude/.env`, then run `/reels2claude:doctor --check-keys` to test it. |
| Key rejected | Re-copy the key: no quotes, no spaces around it. |

## How it works

```
link or video file
      │
      ▼
fetch-reel.mjs ── yt-dlp ──► video + caption
      │           ffmpeg ──► frames: evenly spaced + right after scene cuts, duplicates skipped
      │           ffmpeg ──► audio ──► Groq / OpenAI / Gemini / whisper.cpp ──► transcript
      ▼
one JSON result ──► Claude reads frames + transcript + caption
                    ──► extracts claims ──► judges each (reference/claims.md)
                    ──► inspects your code ──► verdicts + proposed changes
                    ──► reel-reports/<date>-<topic>.md ──► waits for your decision
```

```
.claude-plugin/          plugin.json + marketplace.json
skills/reel/SKILL.md     the instructions Claude follows (/reels2claude:reel)
skills/doctor/SKILL.md   setup checker (/reels2claude:doctor)
skills/reel/reference/   claims.md: the claims reels repeat most, with the real nuance
skills/reel/scripts/     fetch-reel.mjs, doctor.mjs, lib/ (no npm dependencies)
tests/                   unit tests (node --test)
```

## Development

```bash
node --test "tests/*.test.mjs"                      # unit tests
node skills/reel/scripts/doctor.mjs --check-keys    # setup check
node skills/reel/scripts/fetch-reel.mjs <reel link or video file>
claude plugin validate --strict .                   # plugin manifest check
claude --plugin-dir .                               # run Claude Code with this checkout loaded
```

For development, a `.env` in the repo root is read before `~/.reels2claude/.env` (it's gitignored).

**Test status (v0.1.0):**

- Tested end to end: local video files, direct video links, frame extraction (scene cuts +
  duplicate skipping), the doctor, and plugin validation.
- Tested against the live APIs **up to authentication** (the request reaches the service; a bad
  key gets a clear, key-free error): Groq, OpenAI, Gemini.
- **Not yet tested:** a successful transcription with a real key, downloads of real TikTok and
  Instagram reels, and whisper.cpp. All are implemented from official docs.

## License

Not chosen yet.
