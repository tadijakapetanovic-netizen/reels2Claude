#!/usr/bin/env node
// Turns a reel URL (or a local screen recording) into things Claude can read:
// the caption, a transcript of the speech, and a set of still frames for on-screen text.
// Multi-slide posts (Instagram carousels) work too: each picture slide becomes one image, and
// each video slide is handled like a reel.
// Prints exactly one JSON object to stdout. Exit code 0 = usable result, 1 = failed.
//
// Usage: node fetch-reel.mjs <url-or-video-file> [--out DIR] [--provider local|groq|openai|gemini|none]
//                            [--cookies-from-browser BROWSER] [--keep-media]
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { loadConfig, PROVIDERS, selectProvider, USER_CONFIG_DIR } from './lib/config.mjs';
import {
  detectPlatform,
  detectSceneChanges,
  downloadPost,
  extractAudio,
  extractFrames,
  formatClock,
  isTikTokPhotoPost,
  metaFromInfo,
  pickFrameTimes,
  probe,
  saveImage,
} from './lib/media.mjs';
import { checkLocalWhisper, resolveTools } from './lib/tools.mjs';
import { providerLabel, transcribe } from './lib/transcribe.mjs';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic', '.bmp']);
const SCREENSHOT_FALLBACK = 'Take screenshots of every slide and share those instead.';

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

const pad2 = (n) => String(n).padStart(2, '0');

function makeWorkDir(outBase, label) {
  const now = new Date();
  const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  let dir = join(outBase, `${stamp}-${label}`);
  for (let n = 2; existsSync(dir); n++) dir = join(outBase, `${stamp}-${label}-${n}`);
  mkdirSync(join(dir, 'frames'), { recursive: true });
  return dir;
}

function timestamped(segments, text) {
  if (!segments?.length) return text;
  return segments.map((s) => `[${formatClock(s.start)}] ${s.text}`).join('\n');
}

// Frames and transcript for one video: the whole reel, or one video slide of a post.
async function processVideo({ videoPath, workDir, tools, config, choice, prefix, platform }) {
  const info = await probe(videoPath, tools.ffprobe);
  if (!info.ok) return { ok: false, error: info.error };
  const out = { ok: true, durationSec: info.durationSec, frames: [], duplicates: 0, transcript: null, note: null, warnings: [] };
  if (info.durationSec && info.durationSec > 15 * 60) {
    out.warnings.push(`This video is ${Math.round(info.durationSec / 60)} minutes long; reels are usually under 3. Frames are spread thinly.`);
  }

  // Frames, for on-screen text and code
  if (info.hasVideo) {
    const scenes = await detectSceneChanges({ ffmpeg: tools.ffmpeg, input: videoPath });
    const { frames, duplicates } = await extractFrames({
      ffmpeg: tools.ffmpeg,
      input: videoPath,
      times: pickFrameTimes(info.durationSec, scenes),
      outDir: join(workDir, 'frames'),
      width: info.width,
      height: info.height,
      prefix,
    });
    out.frames = frames;
    out.duplicates = duplicates;
    if (!frames.length) out.warnings.push('No frames could be extracted, so on-screen text is not available.');
  } else if (platform === 'tiktok') {
    out.warnings.push(`Only sound was downloaded. If this is a TikTok photo slideshow, its pictures can't be downloaded: ${SCREENSHOT_FALLBACK.toLowerCase()}`);
  } else {
    out.warnings.push('The file has no video track, so there is no on-screen text to read.');
  }

  // Transcript of the speech
  if (!info.hasAudio) {
    out.note = 'The video has no audio track; rely on the frames and caption.';
  } else if (choice.name === 'none') {
    out.note = choice.reason;
  } else {
    const attempt = await transcribeWith(choice, { videoPath, workDir, config, tools, prefix, durationSec: info.durationSec });
    let result = attempt.result;
    let used = choice;
    let note = attempt.error;
    // An API that fails (bad key, quota, outage) falls back to whisper.cpp when it's installed.
    if (!result && attempt.apiFailed) {
      const local = checkLocalWhisper(config.values);
      if (local.ok) {
        used = { name: 'local', model: local.model, bin: local.bin };
        const retry = await transcribeWith(used, { videoPath, workDir, config, tools, prefix, durationSec: info.durationSec });
        result = retry.result;
        note = result
          ? `${providerLabel(choice.name)} failed (${attempt.error}), so the local whisper.cpp was used instead.`
          : `${attempt.error} The local whisper.cpp fallback also failed: ${retry.error}`;
      }
    }
    if (result) {
      out.transcript = {
        provider: used.name,
        providerLabel: providerLabel(used.name),
        model: used.name === 'local' ? basename(used.model) : used.model,
        language: result.language,
        text: result.text,
        timestamped: timestamped(result.segments, result.text),
      };
      out.note = result.text ? (note ?? null) : 'The transcript is empty: the audio is probably just music.';
    } else {
      out.note = `No transcript: ${note}`;
    }
  }
  return out;
}

// Returns { result } or { error, apiFailed } (apiFailed: the provider itself failed, not the audio).
async function transcribeWith(choice, { videoPath, workDir, config, tools, prefix, durationSec }) {
  const format = PROVIDERS[choice.name].audio;
  const output = join(workDir, `audio${prefix ? `-${prefix.slice(0, -1)}` : ''}.${format}`);
  const audio = await extractAudio({ ffmpeg: tools.ffmpeg, input: videoPath, output, format });
  if (!audio.ok) return { error: `the audio could not be extracted (${audio.error}).` };
  try {
    const result = await transcribe({
      provider: choice.name,
      model: choice.model,
      values: config.values,
      audioPath: audio.path,
      workDir,
      localBin: choice.bin,
      durationSec,
    });
    return { result };
  } catch (error) {
    const message = /[.!?]$/.test(error.message) ? error.message : `${error.message}.`;
    return { error: `${message}${error.hint ? ` ${error.hint}` : ''}`, apiFailed: choice.name !== 'local' };
  }
}

// One transcript per video slide becomes one transcript, labelled by slide.
function mergeTranscripts(parts) {
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0];
  return {
    ...parts[0],
    text: parts.map((p) => `[slide ${p.slide}] ${p.text}`).join('\n'),
    timestamped: parts.map((p) => `--- slide ${p.slide} ---\n${p.timestamped}`).join('\n'),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.input) {
    return fail('input', 'Usage: node fetch-reel.mjs <reel URL or path to a video file> [--provider local|groq|openai|gemini|none]');
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
  } else if (isTikTokPhotoPost(opts.input)) {
    return fail('download', "TikTok photo slideshows can't be downloaded (the downloader only gets their background music).", {
      reason: 'photo_post',
      platform: 'tiktok',
      hint: SCREENSHOT_FALLBACK,
      fallbacks: [SCREENSHOT_FALLBACK, 'Paste the caption and type out what the slides say.'],
    });
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

  // No transcription set up: stop before downloading anything, so the user can choose first.
  const choice = selectProvider(config.values, checkLocalWhisper, opts.provider);
  if (!choice.name) {
    return fail('transcription', `Speech can't be transcribed yet: ${choice.reason}`, {
      reason: 'not_set_up',
      choices: [
        { id: 'install_whisper', label: 'Install whisper.cpp: free, private, runs on this computer (about 500 MB download)', run: 'install-whisper.mjs' },
        { id: 'api_key', label: 'Use an API key the user already has (Groq, OpenAI or Google Gemini)', keyFile: join(USER_CONFIG_DIR, '.env') },
        { id: 'skip', label: 'Skip transcription this time: use on-screen text and caption only', rerunWith: '--no-transcribe' },
      ],
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

  // 1. Get the media: one video, or the slides of a post
  let items = [{ index: 0, kind: 'video', path: inputPath }];
  let isPost = false;
  let meta = { url: null, title: basename(inputPath ?? ''), caption: null, uploader: null, uploadDate: null, durationSec: null };
  if (isUrl) {
    const cookies = opts.cookies || config.values.REELS2CLAUDE_COOKIES_FROM_BROWSER || null;
    const dl = await downloadPost({ url: opts.input, workDir, tools, cookiesFromBrowser: cookies });
    if (!dl.ok) {
      rmSync(workDir, { recursive: true, force: true });
      const screenshots = dl.reason === 'no_media';
      return fail('download', dl.message, {
        reason: dl.reason,
        platform: dl.platform,
        hint: dl.hint,
        usedBrowserCookies: Boolean(cookies),
        details: dl.details,
        fallbacks: [
          screenshots ? SCREENSHOT_FALLBACK : 'Screen-record the video (phone or computer) and pass the recording file instead of the link.',
          'Paste the caption and describe or type out what is said and shown.',
          ...(dl.platform === 'instagram' && !cookies
            ? ['Opt in to using a browser login: set REELS2CLAUDE_COOKIES_FROM_BROWSER=firefox (while logged in to Instagram in Firefox).']
            : []),
        ],
      });
    }
    items = dl.items;
    isPost = dl.isPost || items.some((item) => item.kind === 'image');
    meta = metaFromInfo(dl.info, opts.input);
    if (dl.failed) {
      warnings.push(`${dl.failed} of ${dl.failed + items.length} slides could not be downloaded; the rest are included.`);
    }
  }

  // 2. Frames (or pictures) and transcripts
  const frames = [];
  const transcripts = [];
  const notes = [];
  let duplicateFramesSkipped = 0;
  let durationSec = null;
  for (const item of items) {
    const slide = item.index || 1;
    if (item.kind === 'image') {
      const saved = await saveImage({ ffmpeg: tools.ffmpeg, input: item.path, output: join(workDir, 'frames', `slide-${pad2(slide)}.jpg`) });
      if (saved.ok) frames.push({ path: saved.path, slide });
      else warnings.push(`Slide ${slide} could not be read as a picture (${saved.error}).`);
      continue;
    }
    const video = await processVideo({
      videoPath: item.path,
      workDir,
      tools,
      config,
      choice,
      prefix: isPost ? `slide-${pad2(slide)}-` : '',
      platform,
    });
    if (!video.ok) {
      if (!isPost) {
        rmSync(workDir, { recursive: true, force: true });
        return fail('probe', 'The file could not be read as a video.', { details: video.error });
      }
      warnings.push(`Slide ${slide} could not be read as a video.`);
      continue;
    }
    if (!isPost) durationSec = video.durationSec ?? meta.durationSec;
    frames.push(...video.frames.map(({ path, at }) => (isPost ? { path, slide, at } : { path, at })));
    duplicateFramesSkipped += video.duplicates;
    warnings.push(...video.warnings.map((w) => (isPost ? `Slide ${slide}: ${w}` : w)));
    if (video.transcript) transcripts.push({ slide, ...video.transcript });
    if (video.note) notes.push(isPost ? `Slide ${slide}: ${video.note}` : video.note);
  }
  const transcript = mergeTranscripts(transcripts);
  const videoSlides = items.filter((item) => item.kind === 'video').length;
  const transcriptNote = notes.length
    ? notes.join(' ')
    : isPost && !videoSlides
      ? 'This post is pictures only, so there is no speech to transcribe.'
      : null;

  // 3. Save everything next to the frames, then tidy up the heavy files
  const manifest = {
    ok: true,
    workDir,
    source: { kind: isUrl ? 'url' : 'file', input: opts.input, platform },
    meta: {
      ...meta,
      durationSec,
      ...(isPost ? { post: { slides: items.length, pictures: items.length - videoSlides, videos: videoSlides } } : {}),
    },
    transcript,
    transcriptNote,
    frames,
    duplicateFramesSkipped,
    warnings,
    next: !frames.length
      ? 'Continue with the skill using the transcript and caption.'
      : isPost
        ? 'This is a multi-slide post. Read every image listed in frames, in slide order (each picture slide is one image), then continue with the skill.'
        : 'Read every frame image listed above (on-screen text is often the main point), then continue with the skill.',
  };
  if (transcript) {
    writeFileSync(join(workDir, 'transcript.txt'), `${transcript.timestamped}\n`);
  }
  writeFileSync(join(workDir, 'reel.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  if (!opts.keepMedia) {
    for (const f of readdirSync(workDir)) {
      if (/^(item-|audio[.-]|whisper\.)/.test(f)) rmSync(join(workDir, f), { force: true });
    }
  }
  emit(manifest);
}

main().catch((error) => fail('internal', `Unexpected error: ${error.message}`));
