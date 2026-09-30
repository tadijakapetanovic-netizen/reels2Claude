// Speech-to-text providers. Each returns { text, language, segments: [{ start, end, text }] }.
// API keys are only ever sent to their own provider and never printed.
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { PROVIDERS } from './config.mjs';
import { run } from './tools.mjs';

export class TranscriptionError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

export async function transcribe({ provider, model, values, audioPath, workDir, localBin, durationSec }) {
  switch (provider) {
    case 'groq':
      return openAiCompatible({
        endpoint: 'https://api.groq.com/openai/v1/audio/transcriptions',
        key: values.GROQ_API_KEY,
        model,
        audioPath,
        verbose: true,
        label: 'Groq',
      });
    case 'openai':
      return openAiCompatible({
        endpoint: 'https://api.openai.com/v1/audio/transcriptions',
        key: values.OPENAI_API_KEY,
        model,
        audioPath,
        // Only whisper-1 supports timestamped (verbose_json) output on OpenAI.
        verbose: model === 'whisper-1',
        label: 'OpenAI',
      });
    case 'gemini':
      return gemini({ key: values.GEMINI_API_KEY, model, audioPath });
    case 'local':
      return whisperCpp({ bin: localBin, model, audioPath, workDir, durationSec });
    default:
      throw new TranscriptionError(`Unknown provider "${provider}".`);
  }
}

async function openAiCompatible({ endpoint, key, model, audioPath, verbose, label }) {
  const form = new FormData();
  form.append('file', new Blob([await readFile(audioPath)], { type: 'audio/mpeg' }), 'audio.mp3');
  form.append('model', model);
  form.append('response_format', verbose ? 'verbose_json' : 'json');
  form.append('temperature', '0');
  const json = await postJson(endpoint, { headers: { Authorization: `Bearer ${key}` }, body: form }, key, label);
  return {
    text: (json.text || '').trim(),
    language: json.language || null,
    segments: (json.segments || []).map((s) => ({ start: s.start, end: s.end, text: String(s.text || '').trim() })),
  };
}

async function gemini({ key, model, audioPath }) {
  const parts = [{ inlineData: { mimeType: 'audio/mp3', data: (await readFile(audioPath)).toString('base64') } }];
  // General-purpose Gemini models need to be told what to do; the dedicated transcribe model doesn't.
  if (!/transcribe/i.test(model)) {
    parts.unshift({
      text:
        'Transcribe this audio verbatim in its original language. Output only the transcript, ' +
        'starting each sentence on a new line with a [m:ss] timestamp.',
    });
  }
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const json = await postJson(
    endpoint,
    {
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts }] }),
    },
    key,
    'Gemini'
  );
  const text = (json.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text)
    .filter(Boolean)
    .join('')
    .trim();
  if (!text) {
    const why = json.promptFeedback?.blockReason || json.candidates?.[0]?.finishReason || 'empty response';
    throw new TranscriptionError(`Gemini returned no transcript (${why}).`);
  }
  return { text: stripTimestamps(text), language: null, segments: parseTimestampedLines(text) };
}

// On a 2012 CPU the small model needs about 4 s per second of audio; newer CPUs are much faster.
// availableParallelism() arrived in Node 18.14.
const cpuThreads = () => os.availableParallelism?.() ?? (os.cpus().length || 4);

export function whisperTimeoutMs(durationSec) {
  return Math.max(15 * 60_000, Math.ceil((durationSec || 0) * 20) * 1000);
}

async function whisperCpp({ bin, model, audioPath, workDir, durationSec }) {
  const outBase = join(workDir, 'whisper');
  const timeoutMs = whisperTimeoutMs(durationSec);
  // All CPU threads (whisper.cpp uses 4 by default) and greedy decoding: in our tests about twice as
  // fast as the defaults, with the same transcript.
  const args = ['-m', model, '-f', audioPath, '-l', 'auto', '-t', String(cpuThreads()), '-bs', '1', '-bo', '1'];
  const res = await run(bin, [...args, '-oj', '-otxt', '-of', outBase, '-np'], { timeoutMs });
  if (res.code !== 0) {
    throw new TranscriptionError(
      `whisper.cpp failed: ${(res.stderr || res.stdout).trim().split(/\r?\n/).slice(-2).join(' ')}`,
      res.timedOut
        ? `It ran for ${Math.round(timeoutMs / 60_000)} minutes; try a smaller model such as ggml-base.bin.`
        : 'Run the doctor to check the whisper.cpp setup.'
    );
  }
  if (existsSync(`${outBase}.json`)) {
    try {
      const json = JSON.parse(readFileSync(`${outBase}.json`, 'utf8'));
      const segments = (json.transcription || []).map((s) => ({
        start: (s.offsets?.from ?? 0) / 1000,
        end: (s.offsets?.to ?? 0) / 1000,
        text: String(s.text || '').trim(),
      }));
      return { text: segments.map((s) => s.text).join(' ').trim(), language: json.result?.language || null, segments };
    } catch {
      // whisper.cpp can split multi-byte characters across tokens and emit invalid JSON; use the text file.
    }
  }
  if (existsSync(`${outBase}.txt`)) {
    return { text: readFileSync(`${outBase}.txt`, 'utf8').trim(), language: null, segments: [] };
  }
  throw new TranscriptionError('whisper.cpp finished but wrote no transcript.');
}

async function postJson(endpoint, init, key, label) {
  let res;
  try {
    res = await fetch(endpoint, { method: 'POST', ...init, signal: AbortSignal.timeout(3 * 60_000) });
  } catch (error) {
    throw new TranscriptionError(
      `Could not reach ${label}: ${redact(error.cause?.message || error.message, key)}`,
      'Check the internet connection and try again.'
    );
  }
  const body = await res.text();
  if (!res.ok) {
    const message = redact(summarise(body), key);
    // Gemini reports a bad key as 400 rather than 401.
    const status = res.status === 400 && /api key/i.test(message) ? 401 : res.status;
    throw new TranscriptionError(`${label} returned HTTP ${res.status}: ${message}`, hintForStatus(status, label));
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new TranscriptionError(`${label} returned a response that isn't JSON.`);
  }
}

function hintForStatus(status, label) {
  if (status === 401 || status === 403) return `The ${label} API key was rejected. Check it was copied completely, with no spaces.`;
  if (status === 413) return 'The audio is too large for this provider. Try a shorter clip.';
  if (status === 429) return `${label} rate limit or free quota reached. Wait a bit and retry, or use another provider.`;
  if (status >= 500) return `${label} is having problems right now. Try again later or use another provider.`;
  return undefined;
}

function summarise(body) {
  try {
    const json = JSON.parse(body);
    return json.error?.message || json.message || JSON.stringify(json).slice(0, 300);
  } catch {
    return body.slice(0, 300);
  }
}

export function redact(text, key) {
  return key ? String(text).split(key).join('[redacted]') : String(text);
}

const STAMP = /^\s*\[(\d+):(\d{1,2})(?::(\d{1,2}))?\]\s*/;

export function parseTimestampedLines(text) {
  const segments = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(STAMP);
    if (!m) continue;
    const start = m[3] !== undefined ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
    const content = line.replace(STAMP, '').trim();
    if (content) segments.push({ start, end: null, text: content });
  }
  return segments;
}

function stripTimestamps(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(STAMP, '').trim())
    .filter(Boolean)
    .join(' ');
}

export function providerLabel(name) {
  return PROVIDERS[name]?.label || name;
}
