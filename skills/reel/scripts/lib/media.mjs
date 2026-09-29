// Downloading a reel and pulling out what Claude can read: metadata, audio, and frames.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './tools.mjs';

export function detectPlatform(url) {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'web';
  }
  if (/(^|\.)tiktok\.com$/.test(host)) return 'tiktok';
  if (/(^|\.)instagram\.com$/.test(host) || host === 'instagr.am') return 'instagram';
  if (/(^|\.)youtube\.com$/.test(host) || host === 'youtu.be') return 'youtube';
  if (/(^|\.)(x|twitter)\.com$/.test(host)) return 'x';
  if (/(^|\.)facebook\.com$/.test(host) || host === 'fb.watch') return 'facebook';
  return 'web';
}

// Turns yt-dlp's error output into a reason Claude can explain to a non-technical user.
export function classifyDownloadError(stderr, platform) {
  const s = stderr.toLowerCase();
  const pick = (reason, message, hint) => ({ reason, message, hint });
  if (s.includes('unsupported url')) {
    return pick('unsupported', 'This link is not a supported video page.', 'Check the link, or screen-record the video instead.');
  }
  if (s.includes('private') && (s.includes('video') || s.includes('account') || s.includes('post'))) {
    return pick('private', 'The video is private or from a private account.', 'Screen-record it on your phone and pass the recording instead.');
  }
  if (
    s.includes('login') ||
    s.includes('cookies') ||
    s.includes('rate-limit') ||
    s.includes('rate limit') ||
    s.includes('empty media response') ||
    s.includes('requested content is not available') ||
    s.includes('http error 401') ||
    s.includes('http error 429')
  ) {
    return pick(
      'login_required',
      `${platform === 'instagram' ? 'Instagram' : 'The site'} refused to serve the video without a logged-in browser session.`,
      'Screen-record the reel and pass the recording, or opt in to using your browser login (REELS2CLAUDE_COOKIES_FROM_BROWSER=firefox).'
    );
  }
  if (s.includes('http error 404') || s.includes('not available') || s.includes('has been removed') || s.includes('does not exist')) {
    return pick('unavailable', 'The video was deleted, is region-locked, or the link is wrong.', 'Double-check the link, or screen-record the video.');
  }
  if (s.includes('unable to extract') || s.includes('unable to download') || s.includes('please report this issue')) {
    return pick(
      'extractor_broken',
      'The downloader could not read this page. The site probably changed recently.',
      'Update yt-dlp (run the doctor for the command), then try again. Meanwhile, screen-record the video.'
    );
  }
  if (s.includes('getaddrinfo') || s.includes('timed out') || s.includes('connection') || s.includes('network')) {
    return pick('network', 'The download failed because of a network problem.', 'Check the internet connection and try again.');
  }
  return pick('unknown', 'The download failed for an unrecognised reason.', 'Screen-record the video and pass the recording instead.');
}

export async function downloadVideo({ url, workDir, tools, cookiesFromBrowser }) {
  const platform = detectPlatform(url);
  const args = [
    '--no-playlist',
    '--no-progress',
    '--format', 'bv*+ba/b',
    '--format-sort', 'res:1080',
    '--merge-output-format', 'mp4',
    '--max-filesize', '500M',
    '--write-info-json',
    '--no-mtime',
    '--output', join(workDir, 'video.%(ext)s'),
  ];
  if (tools.ffmpeg) args.push('--ffmpeg-location', tools.ffmpeg);
  // YouTube needs a JavaScript runtime; Node is guaranteed to exist because it's running us.
  if (platform === 'youtube') args.push('--js-runtimes', `node:${process.execPath}`);
  if (cookiesFromBrowser) args.push('--cookies-from-browser', cookiesFromBrowser);
  // "--" stops yt-dlp from reading a crafted URL as an option.
  args.push('--', url);

  const res = await run(tools.ytdlp, args, { timeoutMs: 5 * 60_000, env: { PYTHONIOENCODING: 'utf-8' } });
  const files = existsSync(workDir) ? readdirSync(workDir) : [];
  const video = files.find((f) => f.startsWith('video.') && !/\.(info\.json|part|ytdl|temp)$/.test(f) && !f.includes('.part'));
  if (res.code !== 0 || !video) {
    const err = res.timedOut
      ? { reason: 'timeout', message: 'The download took longer than 5 minutes.', hint: 'Try again, or screen-record the video.' }
      : classifyDownloadError(res.stderr, platform);
    return { ok: false, platform, ...err, details: lastLines(res.stderr, 6) };
  }
  const infoPath = join(workDir, 'video.info.json');
  let info = {};
  if (existsSync(infoPath)) {
    try {
      info = JSON.parse(readFileSync(infoPath, 'utf8'));
    } catch {
      info = {};
    }
  }
  return { ok: true, platform, videoPath: join(workDir, video), info };
}

export function metaFromInfo(info, fallbackUrl) {
  const date = typeof info.upload_date === 'string' && /^\d{8}$/.test(info.upload_date)
    ? `${info.upload_date.slice(0, 4)}-${info.upload_date.slice(4, 6)}-${info.upload_date.slice(6, 8)}`
    : null;
  const caption = info.description || null;
  // TikTok and Instagram often repeat the caption as the title, or use "Video by <user>".
  const title = info.title && info.title !== caption ? info.title : null;
  return {
    id: info.id ?? null,
    url: info.webpage_url || fallbackUrl || null,
    title,
    caption,
    uploader: info.uploader || info.channel || info.uploader_id || null,
    uploaderHandle: info.uploader_id || info.channel_id || null,
    uploadDate: date,
    durationSec: typeof info.duration === 'number' ? info.duration : null,
    viewCount: info.view_count ?? null,
    likeCount: info.like_count ?? null,
    tags: Array.isArray(info.tags) && info.tags.length ? info.tags.slice(0, 30) : null,
  };
}

export async function probe(file, ffprobe) {
  const res = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], {
    timeoutMs: 30_000,
  });
  if (res.code !== 0) return { ok: false, error: lastLines(res.stderr, 3) };
  let data;
  try {
    data = JSON.parse(res.stdout);
  } catch {
    return { ok: false, error: 'ffprobe returned unreadable output' };
  }
  const streams = data.streams || [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === 'audio');
  const duration = Number(data.format?.duration ?? video?.duration ?? audio?.duration);
  return {
    ok: true,
    durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: video?.width ?? null,
    height: video?.height ?? null,
  };
}

export async function extractAudio({ ffmpeg, input, output, format }) {
  const codec =
    format === 'wav'
      ? ['-c:a', 'pcm_s16le']
      : ['-c:a', 'libmp3lame', '-b:a', '48k'];
  const res = await run(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', ...codec, output],
    { timeoutMs: 3 * 60_000 }
  );
  if (res.code !== 0 || !existsSync(output) || statSync(output).size === 0) {
    return { ok: false, error: lastLines(res.stderr, 3) || 'ffmpeg could not extract the audio' };
  }
  return { ok: true, path: output };
}

// Scene cuts are where text cards and code screenshots usually change. The threshold is
// deliberately low: a cut between two similarly dark text cards scores as little as 0.04,
// while camera footage produces many small scores. Callers keep only the strongest.
export async function detectSceneChanges({ ffmpeg, input, threshold = 0.03 }) {
  const res = await run(
    ffmpeg,
    [
      '-hide_banner', '-loglevel', 'error', '-i', input, '-an',
      '-vf', `scale=160:-2,select='gt(scene,${threshold})',metadata=print:key=lavfi.scene_score:file=-`,
      '-f', 'null', '-',
    ],
    { timeoutMs: 2 * 60_000 }
  );
  if (res.code !== 0) return [];
  const cuts = [];
  let t = null;
  for (const line of res.stdout.split(/\r?\n/)) {
    const time = line.match(/pts_time:\s*([\d.]+)/);
    const score = line.match(/lavfi\.scene_score=([\d.]+)/);
    if (time) t = Number(time[1]);
    else if (score && Number.isFinite(t)) cuts.push({ t, score: Number(score[1]) });
  }
  return cuts;
}

// Evenly spaced frames guarantee coverage; the strongest scene cuts add frames that catch
// short-lived on-screen text between them. `scenes` holds numbers or { t, score } objects.
export function pickFrameTimes(durationSec, scenes = [], { perSeconds = 4, min = 6, max = 16, extra = 6, minGap = 1.5 } = {}) {
  if (!durationSec) return [0.5, 2, 4, 6, 8, 10, 12, 15];
  if (durationSec < 1) return [durationSec / 2];
  const count = Math.min(max, Math.max(min, Math.ceil(durationSec / perSeconds)));
  const times = Array.from({ length: count }, (_, i) => ((i + 0.5) * durationSec) / count);
  const cuts = scenes
    .map((s) => (typeof s === 'number' ? { t: s, score: 0 } : s))
    .sort((a, b) => b.score - a.score || a.t - b.t);
  let added = 0;
  for (const cut of cuts) {
    if (added >= extra) break;
    // Nudge past the cut itself: overlay text tends to fade in a moment later.
    const t = cut.t + 0.4;
    if (t <= 0.2 || t >= durationSec - 0.2) continue;
    // Frames before the cut still show the old scene, so only a frame shortly after it
    // means this scene is already covered.
    if (!times.some((x) => x >= cut.t && x <= t + minGap)) {
      times.push(t);
      added++;
    }
  }
  return times.sort((a, b) => a - b).map((x) => Math.round(x * 100) / 100);
}

// Mean absolute difference between two 64x64 grayscale thumbnails (0-255).
export function frameDifference(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

// Frames that look the same as the previous kept frame are dropped so Claude doesn't read
// the same text card twice. The threshold is strict on purpose: changed text on an
// otherwise identical background must still count as a new frame. Measured: two captures
// of one card differ by 0.00; a one-letter change in 60px text differs by 0.95.
export async function extractFrames({ ffmpeg, input, times, outDir, width, height, duplicateThreshold = 0.25 }) {
  // Keep the long side at most 1280px: enough to read on-screen text, cheap to look at.
  let scale = 'scale=720:-2';
  if (width && height) {
    scale = width >= height ? `scale=${Math.min(1280, even(width))}:-2` : `scale=-2:${Math.min(1280, even(height))}`;
  }
  const frames = [];
  let duplicates = 0;
  let previous = null;
  for (const [i, t] of times.entries()) {
    const name = `frame-${String(i + 1).padStart(2, '0')}-at-${formatClock(t).replace(':', 'm')}s.jpg`;
    const out = join(outDir, name);
    const thumb = join(outDir, `${name}.gray`);
    const res = await run(
      ffmpeg,
      [
        '-hide_banner', '-loglevel', 'error', '-y', '-ss', String(t), '-i', input,
        '-frames:v', '1', '-vf', scale, '-q:v', '4', out,
        '-frames:v', '1', '-vf', 'scale=64:64,format=gray', '-f', 'rawvideo', thumb,
      ],
      { timeoutMs: 60_000 }
    );
    const signature = existsSync(thumb) ? readFileSync(thumb) : null;
    if (existsSync(thumb)) rmSync(thumb, { force: true });
    if (res.code !== 0 || !existsSync(out) || statSync(out).size === 0) continue;
    if (previous && signature && frameDifference(previous, signature) < duplicateThreshold) {
      rmSync(out, { force: true });
      duplicates++;
      continue;
    }
    previous = signature;
    frames.push({ path: out, atSec: t, at: formatClock(t) });
  }
  return { frames, duplicates };
}

export function formatClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function even(n) {
  return n % 2 === 0 ? n : n - 1;
}

export function lastLines(text, n) {
  return (text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join('\n');
}
