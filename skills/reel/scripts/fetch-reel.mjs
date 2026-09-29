#!/usr/bin/env node
// Turns a reel URL (or a local screen recording) into things Claude can read:
// the caption, a transcript of the speech, and a set of still frames for on-screen text.
// Prints exactly one JSON object to stdout. Exit code 0 = usable result, 1 = failed.
//
// Usage: node fetch-reel.mjs <url-or-video-file> [--out DIR] [--provider groq|openai|gemini|local|none]
//                            [--cookies-from-browser BROWSER] [--keep-media]
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { loadConfig, PROVIDERS, selectProvider } from './lib/config.mjs';
import {
  detectPlatform,
  detectSceneChanges,
  downloadVideo,
  extractAudio,
  extractFrames,
  formatClock,
  metaFromInfo,
  pickFrameTimes,
  probe,
} from './lib/media.mjs';
import { checkLocalWhisper, resolveTools } from './lib/tools.mjs';
import { providerLabel, transcribe } from './lib/transcribe.mjs';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic', '.bmp']);

function parseArgs(argv) {
  const opts = { input: null, out: null, provider: null, cookies: null, keepMedia: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--provider') opts.provider = argv[++i];
    else if (a === '--no-transcribe') opts.provider = 'none';
    else if (a === '--cookies-from-browser') opts.cookies = argv[++i];
    else if (a === '--keep-media') opts.keepMedia = true;
    else if (!opts.input) opts.input = a;
  }
  return opts;
}

function emit(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

function fail(stage, message, extra = {}) {
  emit({ ok: false, stage, message, ...extra });
}

function makeWorkDir(outBase, label) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  let dir = join(outBase, `${stamp}-${label}`);
  for (let n = 2; existsSync(dir); n++) dir = join(outBase, `${stamp}-${label}-${n}`);
  mkdirSync(join(dir, 'frames'), { recursive: true });
  return dir;
}

function timestamped(segments, text) {
  if (!segments?.length) return text;
  return segments.map((s) => `[${formatClock(s.start)}] ${s.text}`).join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.input) {
    return fail('input', 'Usage: node fetch-reel.mjs <reel URL or path to a video file> [--provider groq|openai|gemini|local|none]');
  }

  const config = loadConfig();
  const tools = resolveTools(config.values);
  const isUrl = /^https?:\/\//i.test(opts.input);
  const inputPath = isUrl ? null : resolve(opts.input);

  if (!isUrl) {
    if (!existsSync(inputPath)) {
      return fail('input', `"${opts.input}" is neither a web link (http/https) nor an existing file.`);
    }
    if (IMAGE_EXT.has(extname(inputPath).toLowerCase())) {
      return fail('input', 'This is an image, not a video.', {
        hint: 'Images need no processing: read the screenshot directly.',
        imagePath: inputPath,
      });
    }
  }

  const missing = [];
  if (isUrl && !tools.ytdlp) missing.push('yt-dlp');
  if (!tools.ffmpeg) missing.push('ffmpeg');
  if (!tools.ffprobe) missing.push('ffprobe');
  if (missing.length) {
    return fail('setup', `Missing required tool(s): ${missing.join(', ')}.`, {
      missing,
      hint: 'Run the doctor script to get the exact install commands for this computer.',
    });
  }

  const defaultBase = resolve(process.cwd(), 'reel-reports', '.work');
  const outBase = opts.out ? resolve(opts.out) : defaultBase;
  mkdirSync(outBase, { recursive: true });
  // Keep the scratch folder (frames, transcripts of someone else's video) out of the user's git history.
  if (outBase === defaultBase && !existsSync(join(outBase, '.gitignore'))) {
    writeFileSync(join(outBase, '.gitignore'), '*\n');
  }

  const platform = isUrl ? detectPlatform(opts.input) : 'local';
  const workDir = makeWorkDir(outBase, platform);
  const warnings = [];

  // 1. Get the video file
  let videoPath = inputPath;
  let meta = { url: null, title: null, caption: null, uploader: null, uploadDate: null, durationSec: null };
  if (isUrl) {
    const cookies = opts.cookies || config.values.REELS2CLAUDE_COOKIES_FROM_BROWSER || null;
    const dl = await downloadVideo({ url: opts.input, workDir, tools, cookiesFromBrowser: cookies });
    if (!dl.ok) {
      rmSync(workDir, { recursive: true, force: true });
      return fail('download', dl.message, {
        reason: dl.reason,
        platform: dl.platform,
        hint: dl.hint,
        usedBrowserCookies: Boolean(cookies),
        details: dl.details,
        fallbacks: [
          'Screen-record the video (phone or computer) and pass the recording file instead of the link.',
          'Paste the caption and describe or type out what is said and shown.',
          ...(dl.platform === 'instagram' && !cookies
            ? ['Opt in to using a browser login: set REELS2CLAUDE_COOKIES_FROM_BROWSER=firefox (while logged in to Instagram in Firefox).']
            : []),
        ],
      });
    }
    videoPath = dl.videoPath;
    meta = metaFromInfo(dl.info, opts.input);
  } else {
    meta.title = basename(inputPath);
  }

  // 2. Inspect it
  const info = await probe(videoPath, tools.ffprobe);
  if (!info.ok) {
    rmSync(workDir, { recursive: true, force: true });
    return fail('probe', 'The file could not be read as a video.', { details: info.error });
  }
  const durationSec = info.durationSec ?? meta.durationSec;
  if (durationSec && durationSec > 15 * 60) {
    warnings.push(`This video is ${Math.round(durationSec / 60)} minutes long; reels are usually under 3. Frames are spread thinly.`);
  }

  // 3. Frames, for on-screen text and code
  let frames = [];
  let duplicateFramesSkipped = 0;
  if (info.hasVideo) {
    const scenes = await detectSceneChanges({ ffmpeg: tools.ffmpeg, input: videoPath });
    const times = pickFrameTimes(durationSec, scenes);
    ({ frames, duplicates: duplicateFramesSkipped } = await extractFrames({
      ffmpeg: tools.ffmpeg,
      input: videoPath,
      times,
      outDir: join(workDir, 'frames'),
      width: info.width,
      height: info.height,
    }));
    if (!frames.length) warnings.push('No frames could be extracted, so on-screen text is not available.');
  } else {
    warnings.push('The file has no video track, so there is no on-screen text to read.');
  }

  // 4. Transcript of the speech
  let transcript = null;
  let transcriptNote = null;
  if (!info.hasAudio) {
    transcriptNote = 'The video has no audio track; rely on the frames and caption.';
  } else {
    const choice = selectProvider(config.values, checkLocalWhisper, opts.provider);
    if (!choice.name) {
      transcriptNote = `No transcript: ${choice.reason} Run the doctor script for setup steps. Frames and caption are still available.`;
    } else if (choice.name === 'none') {
      transcriptNote = choice.reason;
    } else {
      const format = PROVIDERS[choice.name].audio;
      const audio = await extractAudio({ ffmpeg: tools.ffmpeg, input: videoPath, output: join(workDir, `audio.${format}`), format });
      if (!audio.ok) {
        transcriptNote = `No transcript: the audio could not be extracted (${audio.error}).`;
      } else {
        try {
          const result = await transcribe({
            provider: choice.name,
            model: choice.model,
            values: config.values,
            audioPath: audio.path,
            workDir,
            localBin: choice.bin,
          });
          transcript = {
            provider: choice.name,
            providerLabel: providerLabel(choice.name),
            model: choice.name === 'local' ? basename(choice.model) : choice.model,
            language: result.language,
            text: result.text,
            timestamped: timestamped(result.segments, result.text),
            segments: result.segments,
          };
          if (!result.text) transcriptNote = 'The transcript is empty: the audio is probably just music.';
        } catch (error) {
          transcriptNote = `No transcript: ${error.message}${error.hint ? ` ${error.hint}` : ''}`;
        }
      }
    }
  }

  // 5. Save everything next to the frames, then tidy up the heavy files
  const manifest = {
    ok: true,
    workDir,
    source: { kind: isUrl ? 'url' : 'file', input: opts.input, platform },
    meta: { ...meta, durationSec: durationSec ?? null },
    transcript: transcript && { ...transcript, segments: undefined },
    transcriptNote,
    frames: frames.map(({ path, at }) => ({ path, at })),
    duplicateFramesSkipped,
    warnings,
    next: frames.length
      ? 'Read every frame image listed above (on-screen text is often the main point), then continue with the skill.'
      : 'Continue with the skill using the transcript and caption.',
  };
  if (transcript) {
    writeFileSync(join(workDir, 'transcript.txt'), `${transcript.timestamped}\n`);
  }
  writeFileSync(join(workDir, 'reel.json'), `${JSON.stringify({ ...manifest, transcript }, null, 2)}\n`);

  if (!opts.keepMedia) {
    for (const f of readdirSync(workDir)) {
      if (/^(video\.|audio\.|whisper\.)/.test(f)) rmSync(join(workDir, f), { force: true });
    }
  }
  emit(manifest);
}

main().catch((error) => fail('internal', `Unexpected error: ${error.message}`));
