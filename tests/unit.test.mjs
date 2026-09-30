// Unit tests for the pure parts of the pipeline. Run: node --test tests/
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, parseEnv, readTextFile, selectProvider } from '../skills/reel/scripts/lib/config.mjs';
import {
  classifyDownloadError,
  collectDownloads,
  formatClock,
  frameDifference,
  isInstagramUrl,
  metaFromInfo,
  pickFrameTimes,
} from '../skills/reel/scripts/lib/media.mjs';
import { pickModel, pickRelease, windowsAssetName } from '../skills/reel/scripts/lib/install.mjs';
import { findWhisperModel } from '../skills/reel/scripts/lib/tools.mjs';
import { parseTimestampedLines, redact, whisperTimeoutMs } from '../skills/reel/scripts/lib/transcribe.mjs';

const noLocal = () => ({ ok: false, problem: 'whisper.cpp (whisper-cli) is not installed' });
const withLocal = () => ({ ok: true, bin: '/bin/whisper-cli', model: '/models/ggml-base.bin' });

test('parseEnv handles comments, quotes, export and inline comments', () => {
  const env = parseEnv(
    [
      '# comment',
      'GROQ_API_KEY=gsk_abc',
      'export OPENAI_API_KEY="sk-with #hash"',
      "GEMINI_API_KEY='AIza lit'",
      'EMPTY=',
      'TRAILING=value # note',
      'not a line',
      '  SPACED = x  ',
    ].join('\r\n')
  );
  assert.deepEqual(env, {
    GROQ_API_KEY: 'gsk_abc',
    OPENAI_API_KEY: 'sk-with #hash',
    GEMINI_API_KEY: 'AIza lit',
    EMPTY: '',
    TRAILING: 'value',
    SPACED: 'x',
  });
});

test('readTextFile decodes UTF-8 BOM and UTF-16 LE (Windows Notepad)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2c-test-'));
  try {
    const bom = join(dir, 'bom.env');
    writeFileSync(bom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('GROQ_API_KEY=a\n')]));
    assert.equal(parseEnv(readTextFile(bom)).GROQ_API_KEY, 'a');
    const utf16 = join(dir, 'u16.env');
    writeFileSync(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('GROQ_API_KEY=b\r\n', 'utf16le')]));
    assert.equal(parseEnv(readTextFile(utf16)).GROQ_API_KEY, 'b');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig: first file wins, environment beats files, empty values are ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2c-test-'));
  try {
    const a = join(dir, 'a.env');
    const b = join(dir, 'b.env');
    writeFileSync(a, 'GROQ_API_KEY=from-a\nOPENAI_API_KEY=\n');
    writeFileSync(b, 'GROQ_API_KEY=from-b\nOPENAI_API_KEY=from-b\nGEMINI_API_KEY=from-b\n');
    const cfg = loadConfig({ env: { GEMINI_API_KEY: 'from-env' }, files: [a, b, join(dir, 'missing.env')] });
    assert.equal(cfg.values.GROQ_API_KEY, 'from-a');
    assert.equal(cfg.values.OPENAI_API_KEY, 'from-b');
    assert.equal(cfg.values.GEMINI_API_KEY, 'from-env');
    assert.equal(cfg.origin.GEMINI_API_KEY, 'environment');
    assert.deepEqual(cfg.filesFound, [a, b]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('selectProvider: whisper.cpp first, then groq, openai, gemini', () => {
  assert.equal(selectProvider({}, withLocal).name, 'local');
  assert.equal(selectProvider({ GROQ_API_KEY: 'y', OPENAI_API_KEY: 'x' }, withLocal).name, 'local');
  assert.equal(selectProvider({ OPENAI_API_KEY: 'x', GROQ_API_KEY: 'y' }, noLocal).name, 'groq');
  assert.equal(selectProvider({ OPENAI_API_KEY: 'x', GEMINI_API_KEY: 'z' }, noLocal).name, 'openai');
  assert.equal(selectProvider({ GEMINI_API_KEY: 'z' }, noLocal).name, 'gemini');
  assert.equal(selectProvider({}, noLocal).name, null);
});

test('selectProvider: explicit choice, "none", unknown and unready providers', () => {
  assert.equal(selectProvider({ GROQ_API_KEY: 'y', REELS2CLAUDE_PROVIDER: 'groq' }, withLocal).name, 'groq');
  assert.equal(selectProvider({ GROQ_API_KEY: 'y' }, withLocal, 'groq').name, 'groq');
  assert.equal(selectProvider({ GROQ_API_KEY: 'y' }, noLocal, 'none').name, 'none');
  const unknown = selectProvider({}, noLocal, 'whisperx');
  assert.equal(unknown.name, null);
  assert.match(unknown.reason, /Unknown provider/);
  const unready = selectProvider({}, noLocal, 'openai');
  assert.equal(unready.name, null);
  assert.match(unready.reason, /OPENAI_API_KEY is not set/);
});

test('selectProvider: model override applies to API providers', () => {
  const choice = selectProvider({ GROQ_API_KEY: 'y', REELS2CLAUDE_TRANSCRIBE_MODEL: 'whisper-large-v3' }, noLocal);
  assert.equal(choice.model, 'whisper-large-v3');
  assert.equal(selectProvider({ GROQ_API_KEY: 'y' }, noLocal).model, 'whisper-large-v3-turbo');
});

test('isInstagramUrl accepts Instagram links only', () => {
  assert.ok(isInstagramUrl('https://www.instagram.com/reel/ABC/?igsh=x'));
  assert.ok(isInstagramUrl('https://instagram.com/p/ABC/'));
  assert.ok(isInstagramUrl('http://instagr.am/p/ABC/'));
  assert.ok(!isInstagramUrl('https://www.tiktok.com/@a/video/1'));
  assert.ok(!isInstagramUrl('https://youtube.com/shorts/xyz'));
  assert.ok(!isInstagramUrl('https://notinstagram.com/reel/ABC/'));
  assert.ok(!isInstagramUrl('https://instagram.com.evil.example/reel/ABC/'));
  assert.ok(!isInstagramUrl('ftp://instagram.com/reel/ABC/'));
  assert.ok(!isInstagramUrl('not a url'));
});

test('classifyDownloadError maps yt-dlp errors to plain reasons', () => {
  const ig = classifyDownloadError(
    'ERROR: [Instagram] ABC: Requested content is not available, rate-limit reached or login required. Use --cookies-from-browser'
  );
  assert.equal(ig.reason, 'login_required');
  assert.match(ig.message, /Instagram/);
  assert.equal(classifyDownloadError('ERROR: Unsupported URL: https://www.instagram.com/someone/').reason, 'unsupported');
  assert.equal(classifyDownloadError('ERROR: [Instagram] ABC: This account is private').reason, 'private');
  assert.equal(classifyDownloadError('ERROR: [Instagram] ABC: Unable to extract shared data').reason, 'extractor_broken');
  assert.equal(classifyDownloadError('ERROR: HTTP Error 404: Not Found').reason, 'unavailable');
  assert.equal(classifyDownloadError('something odd').reason, 'unknown');
  // A picture post whose pictures didn't arrive is not a broken downloader (don't say "update yt-dlp").
  const pics = classifyDownloadError(
    'ERROR: [Instagram] DbD55mhMwDF: No video formats found!; please report this issue on https://github.com/yt-dlp/yt-dlp/issues'
  );
  assert.equal(pics.reason, 'no_media');
  assert.match(pics.hint, /screenshots/);
});

// Mirrors what yt-dlp saved in real runs (2026-09-29): a 9-picture Instagram carousel and a reel.
function fakeDownload(files) {
  return collectDownloads(Object.keys(files), (f) => files[f]);
}

test('collectDownloads: carousel of pictures, in slide order, post info from item-0', () => {
  const picture = { _type: 'video', formats: [] };
  const files = { 'item-0.info.json': { _type: 'playlist', description: 'caption' } };
  for (const n of [1, 2, 10]) {
    files[`item-${n}.info.json`] = picture;
    files[`item-${n}.jpg`] = null;
  }
  const r = fakeDownload(files);
  assert.equal(r.isPost, true);
  assert.equal(r.post.description, 'caption');
  assert.deepEqual(r.items.map((i) => [i.index, i.kind, i.file]), [
    [1, 'image', 'item-1.jpg'],
    [2, 'image', 'item-2.jpg'],
    [10, 'image', 'item-10.jpg'],
  ]);
  assert.equal(r.failed, 0);
});

test('collectDownloads: single reel uses the video, not its cover picture', () => {
  const r = fakeDownload({
    'item-0.info.json': { _type: 'video', formats: [{}], description: 'reel caption' },
    'item-0.mp4': null,
    'item-0.jpg': null,
  });
  assert.equal(r.isPost, false);
  assert.equal(r.post.description, 'reel caption');
  assert.deepEqual(r.items.map((i) => [i.kind, i.file]), [['video', 'item-0.mp4']]);
});

test('collectDownloads: a video that failed is never passed off as its cover', () => {
  const r = fakeDownload({
    'item-0.info.json': { _type: 'video', formats: [{}] },
    'item-0.jpg': null,
    'item-0.f137.mp4': null, // unmerged piece
    'item-0.mp4.part': null,
  });
  assert.equal(r.items.length, 0);
  assert.equal(r.failed, 1);
});

test('collectDownloads: mixed carousel and a single-picture post', () => {
  const mixed = fakeDownload({
    'item-0.info.json': { _type: 'playlist' },
    'item-1.info.json': { formats: [] },
    'item-1.webp': null,
    'item-2.info.json': { formats: [{}] },
    'item-2.mp4': null,
    'item-2.jpg': null,
    'item-3.info.json': { formats: [{}] }, // video slide that failed to download
    'item-3.jpg': null,
  });
  assert.deepEqual(mixed.items.map((i) => [i.index, i.kind]), [[1, 'image'], [2, 'video']]);
  assert.equal(mixed.failed, 1);
  const single = fakeDownload({ 'item-0.info.json': { _type: 'video', formats: [] }, 'item-0.jpg': null });
  assert.equal(single.isPost, false);
  assert.deepEqual(single.items.map((i) => [i.index, i.kind]), [[0, 'image']]);
});

test('pickFrameTimes: spacing, bounds, and scene-change extras', () => {
  const plain = pickFrameTimes(40);
  assert.equal(plain.length, 11, '10 evenly spaced + 1 at the very end');
  assert.ok(plain.every((t) => t > 0 && t < 40));
  assert.equal(plain.at(-1), 39.5, 'the final state of a list reel is captured');
  assert.equal(pickFrameTimes(10).length, 6, 'short videos still get the minimum; the last one is already near the end');
  assert.equal(pickFrameTimes(600).length, 17, 'long videos are capped (+ end frame)');
  const withScenes = pickFrameTimes(40, [2.0, 2.1, 7.9, 39.9]);
  assert.ok(withScenes.includes(8.3), 'scene cut away from grid frames is added (nudged +0.4s)');
  assert.ok(!withScenes.some((t) => t > 39.8), 'cuts at the very end are skipped');
  assert.deepEqual(pickFrameTimes(0.5), [0.25]);
  assert.equal(pickFrameTimes(null).length, 8);
  const sorted = [...withScenes].sort((a, b) => a - b);
  assert.deepEqual(withScenes, sorted);
});

test('pickFrameTimes prefers the strongest scene cuts when there are more than it can add', () => {
  // A 60s video has grid frames every 4s; offer 10 candidate cuts that each fit between grid frames.
  const cuts = Array.from({ length: 10 }, (_, i) => ({ t: 4 + i * 4, score: i === 7 ? 0.9 : 0.05 + i * 0.001 }));
  const times = pickFrameTimes(60, cuts, { extra: 1 });
  assert.equal(times.length, 17);
  assert.ok(times.includes(32.4), 'the 0.9-score cut at 32s wins over earlier, weaker cuts');
});

test('pickFrameTimes: a frame just BEFORE a cut does not count as covering the new scene', () => {
  // 50.24s reel: grid frames at 25.12 and 28.98 straddle a cut at 25.93. A short card
  // shown only between them must still get its own frame.
  const times = pickFrameTimes(50.24, [{ t: 25.93, score: 0.045 }]);
  assert.ok(times.includes(26.33));
  // ...but a frame shortly AFTER a cut does cover it.
  const covered = pickFrameTimes(50.24, [{ t: 32.39, score: 0.04 }]);
  assert.ok(!covered.includes(32.79), 'grid frame at 32.85 already shows the new scene');
});

test('frameDifference: identical is 0, different sizes are never duplicates', () => {
  const a = Buffer.from([10, 20, 30, 40]);
  assert.equal(frameDifference(a, Buffer.from(a)), 0);
  assert.equal(frameDifference(a, Buffer.from([12, 18, 30, 40])), 1);
  assert.equal(frameDifference(a, Buffer.from([1, 2])), Infinity);
  assert.equal(frameDifference(null, a), Infinity);
});

test('metaFromInfo maps yt-dlp info and drops a title that duplicates the caption', () => {
  const meta = metaFromInfo({
    id: '123',
    webpage_url: 'https://www.instagram.com/reel/123/',
    title: 'You need RLS #supabase',
    description: 'You need RLS #supabase',
    uploader: 'dev',
    upload_date: '20260915',
    duration: 42.5,
    tags: ['supabase'],
  });
  assert.equal(meta.title, null);
  assert.equal(meta.caption, 'You need RLS #supabase');
  assert.equal(meta.uploadDate, '2026-09-15');
  assert.equal(meta.durationSec, 42.5);
  assert.deepEqual(meta.tags, ['supabase']);
});

test('formatClock', () => {
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(7.9), '0:07');
  assert.equal(formatClock(75), '1:15');
});

test('parseTimestampedLines reads [m:ss] and [h:mm:ss] lines', () => {
  const segs = parseTimestampedLines('[0:03] First.\nno stamp\n[1:02:05] Later.\n[0:10]   ');
  assert.deepEqual(segs, [
    { start: 3, end: null, text: 'First.' },
    { start: 3725, end: null, text: 'Later.' },
  ]);
});

test('redact removes every occurrence of the key', () => {
  assert.equal(redact('bad key gsk_123 (gsk_123)', 'gsk_123'), 'bad key [redacted] ([redacted])');
  assert.equal(redact('nothing', undefined), 'nothing');
});

test('findWhisperModel picks the biggest ggml-*.bin and ignores everything else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2c-test-'));
  try {
    assert.equal(findWhisperModel(join(dir, 'missing')), null);
    assert.equal(findWhisperModel(dir), null);
    writeFileSync(join(dir, 'ggml-base.bin'), Buffer.alloc(10));
    writeFileSync(join(dir, 'ggml-small.bin'), Buffer.alloc(30));
    writeFileSync(join(dir, 'ggml-large.bin.part'), Buffer.alloc(99));
    writeFileSync(join(dir, 'notes.bin'), Buffer.alloc(99));
    mkdirSync(join(dir, 'ggml-folder.bin'));
    assert.equal(findWhisperModel(dir), join(dir, 'ggml-small.bin'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('whisperTimeoutMs: at least 15 minutes, 20 s per second of audio for long videos', () => {
  assert.equal(whisperTimeoutMs(null), 15 * 60_000);
  assert.equal(whisperTimeoutMs(30), 15 * 60_000);
  assert.equal(whisperTimeoutMs(180), 60 * 60_000);
});

// Shape of GitHub's release list for ggml-org/whisper.cpp in Sept 2026: the newest version
// tag has no files, the build releases next to it do.
const asset = (name, digest) => ({ name, size: 1, digest, browser_download_url: `https://example/${name}` });
const RELEASES = [
  { tag_name: 'v1.9.4', draft: false, prerelease: false, assets: [] },
  { tag_name: 'b5130', draft: false, prerelease: true, assets: [asset('whisper-bin-x64.zip', 'sha256:' + 'a'.repeat(64)), asset('whisper-bin-win-cpu-arm64.zip')] },
  { tag_name: 'b4938', draft: false, prerelease: false, assets: [asset('whisper-bin-x64.zip', 'sha256:' + 'B'.repeat(64))] },
];

test('pickRelease: newest full release that has the file, pre-release only as a fallback', () => {
  const x64 = pickRelease(RELEASES, 'whisper-bin-x64.zip');
  assert.equal(x64.tag, 'b4938');
  assert.equal(x64.sha256, 'b'.repeat(64));
  const arm = pickRelease(RELEASES, 'whisper-bin-win-cpu-arm64.zip');
  assert.equal(arm.tag, 'b5130');
  assert.equal(arm.sha256, null);
  assert.equal(pickRelease(RELEASES, 'nope.zip'), null);
  assert.equal(windowsAssetName('x64'), 'whisper-bin-x64.zip');
  assert.equal(windowsAssetName('arm64'), 'whisper-bin-win-cpu-arm64.zip');
});

test('pickModel: exact file name, Hugging Face checksum and size', () => {
  const files = [
    { path: 'ggml-small.en.bin', size: 1, lfs: { oid: 'x', size: 2 } },
    { path: 'ggml-small.bin', size: 135, lfs: { oid: 'c'.repeat(64), size: 487601967 } },
  ];
  const m = pickModel(files, 'small');
  assert.equal(m.file, 'ggml-small.bin');
  assert.equal(m.sha256, 'c'.repeat(64));
  assert.equal(m.size, 487601967);
  assert.ok(m.url.endsWith('/resolve/main/ggml-small.bin'));
  assert.equal(pickModel(files, 'huge'), null);
});
