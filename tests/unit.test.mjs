// Unit tests for the pure parts of the pipeline. Run: node --test tests/
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, parseEnv, readTextFile, selectProvider } from '../skills/reel/scripts/lib/config.mjs';
import {
  classifyDownloadError,
  detectPlatform,
  formatClock,
  frameDifference,
  metaFromInfo,
  pickFrameTimes,
} from '../skills/reel/scripts/lib/media.mjs';
import { parseTimestampedLines, redact } from '../skills/reel/scripts/lib/transcribe.mjs';

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

test('selectProvider: auto order is groq, openai, gemini, local', () => {
  assert.equal(selectProvider({ OPENAI_API_KEY: 'x', GROQ_API_KEY: 'y' }, noLocal).name, 'groq');
  assert.equal(selectProvider({ OPENAI_API_KEY: 'x', GEMINI_API_KEY: 'z' }, noLocal).name, 'openai');
  assert.equal(selectProvider({ GEMINI_API_KEY: 'z' }, noLocal).name, 'gemini');
  assert.equal(selectProvider({}, withLocal).name, 'local');
  assert.equal(selectProvider({}, noLocal).name, null);
});

test('selectProvider: explicit choice, "none", unknown and unready providers', () => {
  assert.equal(selectProvider({ GROQ_API_KEY: 'y', REELS2CLAUDE_PROVIDER: 'local' }, withLocal).name, 'local');
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

test('detectPlatform', () => {
  assert.equal(detectPlatform('https://www.tiktok.com/@a/video/1'), 'tiktok');
  assert.equal(detectPlatform('https://vm.tiktok.com/ZMabc/'), 'tiktok');
  assert.equal(detectPlatform('https://www.instagram.com/reel/ABC/?igsh=x'), 'instagram');
  assert.equal(detectPlatform('https://youtube.com/shorts/xyz'), 'youtube');
  assert.equal(detectPlatform('https://youtu.be/xyz'), 'youtube');
  assert.equal(detectPlatform('https://x.com/a/status/1'), 'x');
  assert.equal(detectPlatform('https://example.com/v.mp4'), 'web');
  assert.equal(detectPlatform('not a url'), 'web');
});

test('classifyDownloadError maps yt-dlp errors to plain reasons', () => {
  const ig = classifyDownloadError(
    'ERROR: [Instagram] ABC: Requested content is not available, rate-limit reached or login required. Use --cookies-from-browser',
    'instagram'
  );
  assert.equal(ig.reason, 'login_required');
  assert.match(ig.message, /Instagram/);
  assert.equal(classifyDownloadError('ERROR: Unsupported URL: https://x', 'web').reason, 'unsupported');
  assert.equal(classifyDownloadError('ERROR: [TikTok] 1: This video is private', 'tiktok').reason, 'private');
  assert.equal(classifyDownloadError('ERROR: [TikTok] 1: Unable to extract universal data', 'tiktok').reason, 'extractor_broken');
  assert.equal(classifyDownloadError('ERROR: HTTP Error 404: Not Found', 'tiktok').reason, 'unavailable');
  assert.equal(classifyDownloadError('something odd', 'tiktok').reason, 'unknown');
});

test('pickFrameTimes: spacing, bounds, and scene-change extras', () => {
  const plain = pickFrameTimes(40);
  assert.equal(plain.length, 10);
  assert.ok(plain.every((t) => t > 0 && t < 40));
  assert.equal(pickFrameTimes(10).length, 6, 'short videos still get the minimum');
  assert.equal(pickFrameTimes(600).length, 16, 'long videos are capped');
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
  assert.equal(times.length, 16);
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
    webpage_url: 'https://www.tiktok.com/@dev/video/123',
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
