# reels2Claude

**Saw a reel telling you your vibe-coded app "needs" something? Send it to Claude.**

TikTok and Instagram are full of videos like *"If you built your app with AI, you're leaking your
whole database!"* Some are right, some are outdated, and some are just engagement bait. If you
aren't a security expert, you can't tell which, and you don't have time to research every one.

reels2Claude is a [Claude Code](https://code.claude.com) plugin. Give it the link, and Claude:

1. **Watches the reel.** It downloads it, transcribes the speech, and reads the on-screen text and
   caption (a lot of reels put the real point on screen, not in the voiceover). Instagram carousel
   posts work too: it reads every slide.
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

Claude can't listen to audio, so a speech-to-text step does that. **You don't need to set this up
in advance:** the first time you check a reel (or run the doctor), Claude asks which you prefer,
before anything is downloaded:

1. **Install whisper.cpp** (the default): **free, private, and it runs on your own computer**, so
   no extra subscription and nothing is uploaded. Say yes and Claude installs
   [whisper.cpp](https://github.com/ggml-org/whisper.cpp) plus a speech model (about 500 MB,
   checksum-verified) into `~/.reels2claude/models/`.
2. **Use an API key you already have** (Groq, OpenAI or Google Gemini). Claude tells you which file
   to put it in; never paste a key into the chat.
3. **Skip it for now.** Claude uses the on-screen text and caption only, and asks again next time.

Already have whisper.cpp? It's detected and nothing is reinstalled. Any `ggml-*.bin` model in
`~/.reels2claude/models/` (on Windows `C:\Users\<you>\.reels2claude\models\`) is found
automatically.

Speed depends on your computer: a modern laptop is quick, while a 2012 desktop CPU needs about
4 seconds per second of audio.

**Switching to an online service later:** put the key in
`~/.reels2claude/.env` (e.g. `GROQ_API_KEY=...`) and, if whisper.cpp is also installed, add
`REELS2CLAUDE_PROVIDER=groq` (or `openai` / `gemini`) to choose it. If the online service fails
(bad key, quota, outage), whisper.cpp is used instead when it's installed. See
[`.env.example`](.env.example) for every option. An Anthropic API key **won't** work here: no Claude
model accepts audio. That's fine, because the judging is done by the Claude you're already talking to.

## Use

In your project, in Claude Code:

```
/reels2claude:reel https://www.instagram.com/reel/ABC123/
```

Carousel posts (`instagram.com/p/...`) work the same way. Or just paste the link and ask
*"does this apply to my app?"*

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
  to an online transcription service only if you chose one (with the default whisper.cpp, it
  never leaves your computer). Your code isn't sent
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
| TikTok photo slideshow, or a picture post that won't download | Take screenshots of every slide and give them to Claude. |
| "No transcript" | Run the doctor: it shows whether whisper.cpp and a model are found, and Claude can install them. |
| Transcription is slow | Normal on older CPUs. Use a smaller model (`ggml-base.bin`) or an online service. |
| API key rejected | Re-copy the key: no quotes, no spaces around it. Test it with `/reels2claude:doctor --check-keys`. |

## How it works

```
link or video file
      │
      ▼
fetch-reel.mjs ── yt-dlp ──► video (or every carousel slide) + caption
      │           ffmpeg ──► frames: evenly spaced + right after scene cuts, duplicates skipped
      │           ffmpeg ──► audio ──► whisper.cpp (or Groq / OpenAI / Gemini) ──► transcript
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
skills/reel/scripts/     fetch-reel.mjs, doctor.mjs, install-whisper.mjs, lib/ (no npm dependencies)
tests/                   unit tests (node --test)
```

## Development

```bash
node --test "tests/*.test.mjs"                      # unit tests
node skills/reel/scripts/doctor.mjs --check-keys    # setup check
node skills/reel/scripts/install-whisper.mjs        # whisper.cpp + model (--model small|base|tiny)
node skills/reel/scripts/fetch-reel.mjs <reel link or video file>
claude plugin validate --strict .                   # plugin manifest check
claude --plugin-dir .                               # run Claude Code with this checkout loaded
```

For development, a `.env` in the repo root is read before `~/.reels2claude/.env` (it's gitignored).

**Test status (v0.1.0):**

- Tested end to end: local video files, direct video links, real Instagram reels and carousel
  posts (no login needed in our tests), frame extraction (scene cuts + duplicate skipping), the
  doctor, plugin validation, and local transcription with whisper.cpp (`ggml-small.bin`, Windows),
  including a fresh automatic install of it on Windows.
- Tested against the live APIs **up to authentication** (the request reaches the service; a bad
  key gets a clear, key-free error): Groq, OpenAI, Gemini.
- **Not yet tested:** a successful transcription with a real API key, downloads of real TikTok
  videos, and installing/running whisper.cpp on macOS and Linux. All are implemented from official
  docs.

## License

Not chosen yet.
