// Finding and running the external programs (yt-dlp, ffmpeg, ffprobe, whisper.cpp).
// Everything is spawned without a shell, so URLs and file paths are never re-parsed.
import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { USER_CONFIG_DIR } from './config.mjs';

export const IS_WIN = process.platform === 'win32';
// Drop a downloaded whisper.cpp model here and it's found without any settings.
export const WHISPER_MODELS_DIR = join(USER_CONFIG_DIR, 'models');

// Places tools commonly land that may be missing from PATH, e.g. right after an
// install, before the terminal (or Claude Code) has been restarted.
function fallbackDirs() {
  if (IS_WIN) {
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return [
      join(local, 'Microsoft', 'WinGet', 'Links'),
      join(local, 'Programs', 'yt-dlp'),
      join(local, 'Programs', 'ffmpeg', 'bin'),
      join(local, 'Programs', 'whisper.cpp'),
      join(local, 'Programs', 'whisper.cpp', 'Release'),
      join(homedir(), 'scoop', 'shims'),
      'C:\\ProgramData\\chocolatey\\bin',
    ];
  }
  return ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', join(homedir(), '.local', 'bin'), '/snap/bin'];
}

export function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function findExecutable(names, override) {
  if (override) return isFile(override) ? override : null;
  const exts = IS_WIN ? ['.exe', '.com'] : [''];
  const dirs = [...(process.env.PATH || '').split(delimiter).filter(Boolean), ...fallbackDirs()];
  for (const name of [].concat(names)) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = join(dir, name + ext);
        if (isFile(candidate)) return candidate;
      }
    }
  }
  return null;
}

export function resolveTools(values) {
  const ffmpeg = findExecutable('ffmpeg', values.FFMPEG_PATH);
  // ffprobe ships next to ffmpeg, so look there before searching PATH.
  let ffprobe = values.FFPROBE_PATH ? findExecutable('ffprobe', values.FFPROBE_PATH) : null;
  if (!ffprobe && !values.FFPROBE_PATH && ffmpeg) {
    const sibling = join(dirname(ffmpeg), IS_WIN ? 'ffprobe.exe' : 'ffprobe');
    ffprobe = isFile(sibling) ? sibling : findExecutable('ffprobe');
  }
  return {
    ytdlp: findExecutable('yt-dlp', values.YTDLP_PATH),
    ffmpeg,
    ffprobe,
  };
}

// With several models in the folder, the biggest file is the most accurate one.
export function findWhisperModel(dir = WHISPER_MODELS_DIR) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  let best = null;
  for (const name of names) {
    if (!/^ggml-.+\.bin$/i.test(name)) continue;
    try {
      const stat = statSync(join(dir, name));
      if (stat.isFile() && (!best || stat.size > best.size)) best = { path: join(dir, name), size: stat.size };
    } catch {
      // unreadable entry: skip it
    }
  }
  return best?.path ?? null;
}

// whisper.cpp needs both its binary and a downloaded model file.
export function checkLocalWhisper(values, modelsDir = WHISPER_MODELS_DIR) {
  const bin = findExecutable(['whisper-cli', 'whisper-cpp'], values.WHISPER_CPP_BIN);
  const model = values.WHISPER_CPP_MODEL || findWhisperModel(modelsDir);
  if (!bin) {
    return {
      ok: false,
      problem: values.WHISPER_CPP_BIN
        ? `WHISPER_CPP_BIN points to "${values.WHISPER_CPP_BIN}", which doesn't exist`
        : 'whisper.cpp (whisper-cli) is not installed',
    };
  }
  if (!model) return { ok: false, problem: `no model found (put a ggml-*.bin model file in ${modelsDir})` };
  if (!isFile(model)) return { ok: false, problem: `WHISPER_CPP_MODEL points to "${model}", which doesn't exist` };
  return { ok: true, bin, model };
}

export function run(cmd, args, { timeoutMs = 120_000, cwd, env } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env, windowsHide: true });
    } catch (error) {
      resolve({ code: -1, stdout, stderr: error.message, timedOut });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + error.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export async function toolVersion(path, args = ['--version']) {
  if (!path) return null;
  const res = await run(path, args, { timeoutMs: 15_000 });
  if (res.code !== 0) return null;
  return (res.stdout || res.stderr).split(/\r?\n/)[0].trim() || null;
}
