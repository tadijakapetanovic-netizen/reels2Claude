// Downloading a reel and pulling out what Claude can read: metadata, audio, and frames.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './tools.mjs';

export function isInstagramUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
    const host = hostname.toLowerCase();
    return /^https?:$/.test(protocol) && (/(^|\.)instagram\.com$/.test(host) || host === 'instagr.am');
  } catch {
    return false;
  }
}

// Turns yt-dlp's error output into a reason Claude can explain to a non-technical user.
export function classifyDownloadError(stderr) {
  const s = stderr.toLowerCase();
  const pick = (reason, message, hint) => ({ reason, message, hint });
  if (s.includes('no video formats found')) {
    return pick(
      'no_media',
      'This post has no video, and its pictures could not be downloaded.',
      'Take screenshots of the post (every slide) and share those instead.'
    );
  }
  if (s.includes('unsupported url')) {
    return pick('unsupported', 'This link is not an Instagram reel or post.', 'Check the link, or screen-record the video instead.');
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
      'Instagram refused to serve the video without a logged-in browser session.',
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

const IMAGE_FILE = /\.(jpe?g|png|webp|gif|heic|bmp)$/i;

// One yt-dlp call handles both a single video and a multi-slide post (Instagram carousel).
// Every item is saved as item-<n>.<ext> with item-<n>.info.json beside it: n = 0 for a single
// video, 1..N for slides (item-0.info.json then describes the whole post). An image slide has
// no video formats, so yt-dlp saves the picture itself as the "thumbnail" and reports an error
// for that slide even though the picture arrived. Success is therefore judged by the files.
export async function downloadPost({ url, workDir, tools, cookiesFromBrowser }) {
  const args = [
    '--no-playlist',
    '--no-progress',
    '--ignore-no-formats-error',
    '--format', 'bv*+ba/b',
    '--format-sort', 'res:1080',
    '--merge-output-format', 'mp4',
    '--max-filesize', '500M',
    '--write-info-json',
    '--write-thumbnail',
    '--no-mtime',
    '--output', join(workDir, 'item-%(playlist_index|0)s.%(ext)s'),
  ];
  if (tools.ffmpeg) args.push('--ffmpeg-location', tools.ffmpeg);
  if (cookiesFromBrowser) args.push('--cookies-from-browser', cookiesFromBrowser);
  // "--" stops yt-dlp from reading a crafted URL as an option.
  args.push('--', url);

  const res = await run(tools.ytdlp, args, { timeoutMs: 5 * 60_000, env: { PYTHONIOENCODING: 'utf-8' } });
  if (res.timedOut) {
    return {
      ok: false,
      reason: 'timeout',
      message: 'The download took longer than 5 minutes.',
      hint: 'Try again, or screen-record the video.',
      details: lastLines(res.stderr, 6),
    };
  }
  const { post, isPost, items, failed } = collectDownloads(existsSync(workDir) ? readdirSync(workDir) : [], (f) =>
    readJson(join(workDir, f))
  );
  if (!items.length) {
    return { ok: false, ...classifyDownloadError(res.stderr), details: lastLines(res.stderr, 6) };
  }
  return {
    ok: true,
    info: post,
    isPost,
    items: items.map((item) => ({ ...item, path: join(workDir, item.file) })),
    failed,
  };
}

// Sorts what yt-dlp saved into the post's info and its items, in slide order. An item is a
// video (or audio) when a media file arrived, and an image when it had no formats and its
// picture arrived. A video that failed to download is never passed off as its cover image.
export function collectDownloads(files, readInfo) {
  const byIndex = new Map();
  for (const f of files) {
    const m = /^item-(\d+)\.(info\.json|[a-z0-9]+)$/i.exec(f);
    if (!m) continue; // skips partial downloads and unmerged pieces (item-1.f137.mp4, *.part)
    const entry = byIndex.get(Number(m[1])) ?? {};
    if (m[2] === 'info.json') entry.infoFile = f;
    else if (IMAGE_FILE.test(f)) entry.image = f;
    else entry.media = f;
    byIndex.set(Number(m[1]), entry);
  }
  const first = byIndex.get(0)?.infoFile ? readInfo(byIndex.get(0).infoFile) : null;
  const isPost = first?._type === 'playlist';
  const post = first ?? {};
  const items = [];
  let failed = 0;
  for (const [index, entry] of [...byIndex].sort((a, b) => a[0] - b[0])) {
    if (isPost && index === 0) continue;
    const info = entry.infoFile ? readInfo(entry.infoFile) ?? {} : {};
    const hasFormats = (Array.isArray(info.formats) && info.formats.length > 0) || Boolean(info.url);
    if (entry.media) items.push({ index, kind: 'video', file: entry.media, info });
    else if (entry.image && !hasFormats) items.push({ index, kind: 'image', file: entry.image, info });
    else failed++;
  }
  return { post: isPost ? post : items[0]?.info ?? post, isPost, items, failed };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function metaFromInfo(info, fallbackUrl) {
  const date = typeof info.upload_date === 'string' && /^\d{8}$/.test(info.upload_date)
    ? `${info.upload_date.slice(0, 4)}-${info.upload_date.slice(4, 6)}-${info.upload_date.slice(6, 8)}`
    : null;
  const caption = info.description || null;
  // Instagram often repeats the caption as the title, or uses "Video by <user>".
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
  // List reels build up on screen and show their last item in the final second or two, so
  // the very end is often the most complete frame.
  const end = durationSec - 0.5;
  if (end > 0 && !times.some((x) => x >= end - 0.5)) times.push(end);
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
export async function extractFrames({ ffmpeg, input, times, outDir, width, height, prefix = '', duplicateThreshold = 0.25 }) {
  // Keep the long side at most 1280px: enough to read on-screen text, cheap to look at.
  let scale = 'scale=720:-2';
  if (width && height) {
    scale = width >= height ? `scale=${Math.min(1280, even(width))}:-2` : `scale=-2:${Math.min(1280, even(height))}`;
  }
  const frames = [];
  let duplicates = 0;
  let previous = null;
  for (const [i, t] of times.entries()) {
    const name = `${prefix}frame-${String(i + 1).padStart(2, '0')}-at-${formatClock(t).replace(':', 'm')}s.jpg`;
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

// Image slides get the same treatment as video frames: JPEG, long side at most 1280px.
export async function saveImage({ ffmpeg, input, output }) {
  const res = await run(
    ffmpeg,
    [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-frames:v', '1',
      '-vf', "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease", '-q:v', '3', output,
    ],
    { timeoutMs: 60_000 }
  );
  if (res.code !== 0 || !existsSync(output) || statSync(output).size === 0) {
    return { ok: false, error: lastLines(res.stderr, 3) || 'ffmpeg could not read the image' };
  }
  return { ok: true, path: output };
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
