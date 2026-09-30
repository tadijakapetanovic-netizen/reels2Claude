// Settings for the reel scripts: where .env files live, how they're parsed,
// and which transcription provider gets picked.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// This file lives at <plugin root>/skills/reel/scripts/lib/config.mjs
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const USER_CONFIG_DIR = join(homedir(), '.reels2claude');

// Earlier files win over later ones; real environment variables beat both.
// The plugin-root .env is for people developing this repo; the home-directory
// one survives plugin updates, so that's where installed users put their keys.
export function envFileCandidates() {
  return [join(PLUGIN_ROOT, '.env'), join(USER_CONFIG_DIR, '.env')];
}

// Windows Notepad may save with a UTF-8 BOM or as UTF-16; accept all three.
export function readTextFile(file) {
  const buf = readFileSync(file);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}

export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    const dq = value.match(/^"((?:[^"\\]|\\.)*)"/);
    const sq = value.match(/^'([^']*)'/);
    if (dq) value = dq[1].replace(/\\n/g, '\n').replace(/\\(["\\])/g, '$1');
    else if (sq) value = sq[1];
    else value = value.replace(/\s+#.*$/, '').trim();
    out[m[1]] = value;
  }
  return out;
}

// Returns every setting plus where each one came from (a file path or "environment").
export function loadConfig({ env = process.env, files = envFileCandidates() } = {}) {
  const values = {};
  const origin = {};
  const filesFound = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    filesFound.push(file);
    for (const [key, value] of Object.entries(parseEnv(readTextFile(file)))) {
      if (value !== '' && !(key in values)) {
        values[key] = value;
        origin[key] = file;
      }
    }
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== '') {
      values[key] = value;
      origin[key] = 'environment';
    }
  }
  return { values, origin, filesFound, filesChecked: files };
}

export const PROVIDERS = {
  groq: { label: 'Groq', keyVar: 'GROQ_API_KEY', defaultModel: 'whisper-large-v3-turbo', audio: 'mp3' },
  openai: { label: 'OpenAI', keyVar: 'OPENAI_API_KEY', defaultModel: 'whisper-1', audio: 'mp3' },
  gemini: { label: 'Google Gemini', keyVar: 'GEMINI_API_KEY', defaultModel: 'gemini-3.5-transcribe', audio: 'mp3' },
  local: { label: 'whisper.cpp (local)', keyVar: null, defaultModel: null, audio: 'wav' },
};
// Local first: free and private. An API is used when the user picks one with
// REELS2CLAUDE_PROVIDER, or when whisper.cpp isn't installed but a key is set.
export const PROVIDER_ORDER = ['local', 'groq', 'openai', 'gemini'];

// `localCheck` reports whether whisper.cpp is usable; it's passed in so this
// module stays free of lookups for binaries.
export function providerStatus(name, values, localCheck) {
  if (name === 'local') {
    const local = localCheck(values);
    return local.ok ? { ready: true, model: local.model, bin: local.bin } : { ready: false, problem: local.problem };
  }
  const p = PROVIDERS[name];
  if (!values[p.keyVar]) return { ready: false, problem: `${p.keyVar} is not set` };
  return { ready: true, model: values.REELS2CLAUDE_TRANSCRIBE_MODEL || p.defaultModel };
}

export function selectProvider(values, localCheck, override) {
  const forced = (override || values.REELS2CLAUDE_PROVIDER || '').trim().toLowerCase();
  if (forced === 'none') return { name: 'none', reason: 'Transcription is turned off (provider "none").' };
  if (forced) {
    if (!PROVIDERS[forced]) {
      return { name: null, reason: `Unknown provider "${forced}". Use one of: ${PROVIDER_ORDER.join(', ')}, none.` };
    }
    const status = providerStatus(forced, values, localCheck);
    return status.ready
      ? { name: forced, ...status }
      : { name: null, reason: `Provider "${forced}" was requested, but ${status.problem}.` };
  }
  for (const name of PROVIDER_ORDER) {
    const status = providerStatus(name, values, localCheck);
    if (status.ready) return { name, ...status };
  }
  return { name: null, reason: 'No transcription is set up (whisper.cpp is not installed and no API key is set).' };
}
