#!/usr/bin/env node
// Sets up free, local speech-to-text: installs the whisper.cpp program and downloads one
// model file into ~/.reels2claude/models/. Skips whatever is already there.
// Run it only after the user has agreed to the install.
// Prints exactly one JSON object to stdout. Exit code 0 = ready to transcribe, 1 = not.
//
// Usage: node install-whisper.mjs [--model small|base|tiny|medium|large-v3-turbo]
//   Windows: downloads the official build from GitHub into %LOCALAPPDATA%\Programs\whisper.cpp
//   macOS:   brew install whisper-cpp
//   Linux:   builds from source (needs git, cmake and a C++ compiler) into ~/.local/bin
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { download, getJson, pickModel, pickRelease, windowsAssetName } from './lib/install.mjs';
import { checkLocalWhisper, findExecutable, findWhisperModel, IS_WIN, isFile, run, WHISPER_MODELS_DIR } from './lib/tools.mjs';

const DEFAULT_MODEL = 'small';

function parseArgs(argv) {
  const i = argv.indexOf('--model');
  return { model: i >= 0 ? argv[i + 1] : DEFAULT_MODEL };
}

function lastLines(text, n = 3) {
  return String(text || '').trim().split(/\r?\n/).slice(-n).join(' ');
}

// whisper.cpp is found by name on PATH and in its usual install folders.
const findWhisperBin = (values) => findExecutable(['whisper-cli', 'whisper-cpp'], values.WHISPER_CPP_BIN);

function findFile(dir, name, depth = 3) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) if (e.isFile() && e.name.toLowerCase() === name) return join(dir, e.name);
  if (depth === 0) return null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const found = findFile(join(dir, e.name), name, depth - 1);
    if (found) return found;
  }
  return null;
}

async function installWindows(values) {
  const assetName = windowsAssetName();
  const release = pickRelease(await getJson('https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=30'), assetName);
  if (!release) throw new Error(`no whisper.cpp release offers ${assetName} right now`);
  const target = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', 'whisper.cpp');
  const temp = mkdtempSync(join(tmpdir(), 'r2c-whisper-'));
  try {
    const zip = join(temp, assetName);
    const { verified } = await download(release.url, zip, release.sha256);
    mkdirSync(target, { recursive: true });
    // Windows 10+ ships a tar.exe that unpacks zip files; PowerShell is the fallback.
    const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    let res = await run(tar, ['-xf', zip, '-C', target], { timeoutMs: 5 * 60_000 });
    if (res.code !== 0) {
      const quote = (p) => `'${p.replace(/'/g, "''")}'`;
      res = await run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(target)} -Force`],
        { timeoutMs: 5 * 60_000 }
      );
    }
    if (res.code !== 0) throw new Error(`could not unzip the download: ${lastLines(res.stderr || res.stdout)}`);
    const bin = findWhisperBin(values) || findFile(target, 'whisper-cli.exe');
    if (!bin) throw new Error(`unzipped to ${target}, but whisper-cli.exe was not in it`);
    return {
      path: bin,
      detail: `whisper.cpp ${release.tag} (${verified ? 'checksum verified' : 'no checksum published'})`,
      // Unusual folder layout: tell the user how to point to it.
      ...(findWhisperBin(values) ? {} : { note: `Set WHISPER_CPP_BIN=${bin} in ~/.reels2claude/.env` }),
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function installMac(values) {
  const brew = findExecutable('brew');
  if (!brew) {
    throw Object.assign(new Error('Homebrew is needed to install whisper.cpp on macOS'), {
      commands: ['Install Homebrew from https://brew.sh, then run this again.'],
    });
  }
  const res = await run(brew, ['install', 'whisper-cpp'], { timeoutMs: 30 * 60_000 });
  const bin = findWhisperBin(values);
  if (!bin) throw new Error(`brew install whisper-cpp failed: ${lastLines(res.stderr || res.stdout)}`);
  return { path: bin, detail: 'installed with Homebrew' };
}

const LINUX_SRC = join(homedir(), '.local', 'src', 'whisper.cpp');
const LINUX_BIN = join(homedir(), '.local', 'bin');

async function installLinux(values) {
  const needed = { git: findExecutable('git'), cmake: findExecutable('cmake'), 'C++ compiler': findExecutable(['c++', 'g++', 'clang++']) };
  const missing = Object.keys(needed).filter((k) => !needed[k]);
  if (missing.length) {
    throw Object.assign(new Error(`building whisper.cpp needs ${missing.join(', ')}`), {
      commands: [
        'Debian/Ubuntu: sudo apt install git cmake build-essential',
        'Fedora: sudo dnf install git cmake gcc-c++',
        'Arch: sudo pacman -S git cmake base-devel',
        'Then run this again.',
      ],
    });
  }
  const build = join(LINUX_SRC, 'build');
  const steps = [
    existsSync(join(LINUX_SRC, '.git'))
      ? [needed.git, ['-C', LINUX_SRC, 'pull', '--ff-only']]
      : [needed.git, ['clone', '--depth', '1', 'https://github.com/ggml-org/whisper.cpp', LINUX_SRC]],
    // Static libraries, so the program still works after being copied to ~/.local/bin.
    [needed.cmake, ['-S', LINUX_SRC, '-B', build, '-DBUILD_SHARED_LIBS=OFF', '-DCMAKE_BUILD_TYPE=Release']],
    [needed.cmake, ['--build', build, '-j', '--config', 'Release', '--target', 'whisper-cli']],
    [needed.cmake, ['-E', 'make_directory', LINUX_BIN]],
    [needed.cmake, ['-E', 'copy', join(build, 'bin', 'whisper-cli'), join(LINUX_BIN, 'whisper-cli')]],
  ];
  for (const [cmd, args] of steps) {
    const res = await run(cmd, args, { timeoutMs: 30 * 60_000 });
    if (res.code !== 0) throw new Error(`building whisper.cpp failed at "${args.slice(0, 2).join(' ')}": ${lastLines(res.stderr || res.stdout)}`);
  }
  const bin = findWhisperBin(values);
  if (!bin) throw new Error(`built whisper-cli, but it was not found in ${LINUX_BIN}`);
  return { path: bin, detail: 'built from source' };
}

async function installModel(name) {
  const model = pickModel(await getJson('https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/main'), name);
  if (!model) throw new Error(`unknown model "${name}"; try small, base or tiny`);
  mkdirSync(WHISPER_MODELS_DIR, { recursive: true });
  const dest = join(WHISPER_MODELS_DIR, model.file);
  const { verified } = await download(model.url, dest, model.sha256);
  return { path: dest, detail: `${model.file}, ${Math.round(model.size / 1e6)} MB (${verified ? 'checksum verified' : 'no checksum published'})` };
}

async function step(name, already, install) {
  if (already) return { step: name, status: 'already_installed', path: already };
  try {
    return { step: name, status: 'installed', ...(await install()) };
  } catch (error) {
    return { step: name, status: 'failed', message: error.message, ...(error.commands ? { commands: error.commands } : {}) };
  }
}

async function main() {
  const { model } = parseArgs(process.argv.slice(2));
  if (!/^[a-z0-9.-]+$/i.test(model || '')) {
    return emit({ ok: false, message: 'Usage: node install-whisper.mjs [--model small|base|tiny]' });
  }
  const { values } = loadConfig();
  const installProgram = IS_WIN ? installWindows : process.platform === 'darwin' ? installMac : installLinux;
  const steps = [
    await step('program', findWhisperBin(values), () => installProgram(values)),
    await step('model', isFile(values.WHISPER_CPP_MODEL || '') ? values.WHISPER_CPP_MODEL : findWhisperModel(), () => installModel(model)),
  ];
  const ready = checkLocalWhisper(loadConfig().values);
  emit({
    ok: ready.ok,
    steps,
    ...(ready.ok
      ? { message: 'whisper.cpp is ready: reels will be transcribed on this computer.' }
      : { message: `whisper.cpp is not ready yet: ${ready.problem}.` }),
  });
}

function emit(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

main().catch((error) => emit({ ok: false, message: `Unexpected error: ${error.message}` }));
