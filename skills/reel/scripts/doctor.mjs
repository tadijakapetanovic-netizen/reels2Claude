#!/usr/bin/env node
// Checks everything reels2Claude needs and prints exact, copy-pasteable fixes for this computer.
// Never prints API key values.
//
// Usage: node doctor.mjs [--json] [--check-keys]
//   --check-keys  makes one free, read-only request per configured key to confirm it's accepted
import { loadConfig, PROVIDER_ORDER, PROVIDERS, selectProvider, USER_CONFIG_DIR } from './lib/config.mjs';
import { redact } from './lib/transcribe.mjs';
import { checkLocalWhisper, IS_WIN, resolveTools, toolVersion } from './lib/tools.mjs';
import { join } from 'node:path';

const args = new Set(process.argv.slice(2));
const OS = IS_WIN ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
const MIN_NODE_MAJOR = 18;

const INSTALL = {
  'yt-dlp': {
    windows: [
      'winget install yt-dlp.yt-dlp',
      'No winget? In PowerShell:',
      '  New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\\Programs\\yt-dlp" | Out-Null',
      '  Invoke-WebRequest https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe -OutFile "$env:LOCALAPPDATA\\Programs\\yt-dlp\\yt-dlp.exe"',
    ],
    mac: ['brew install yt-dlp', 'No Homebrew? Install it first from https://brew.sh'],
    linux: [
      'mkdir -p ~/.local/bin && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o ~/.local/bin/yt-dlp && chmod a+rx ~/.local/bin/yt-dlp',
      '(Distro packages of yt-dlp are often too old to download from TikTok/Instagram.)',
    ],
  },
  ffmpeg: {
    windows: [
      'winget install Gyan.FFmpeg',
      'No winget? Download https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip, unzip it,',
      '  rename the folder inside to "ffmpeg" and move it to %LOCALAPPDATA%\\Programs\\',
      '  (so that %LOCALAPPDATA%\\Programs\\ffmpeg\\bin\\ffmpeg.exe exists). No PATH changes needed.',
    ],
    mac: ['brew install ffmpeg'],
    linux: ['Debian/Ubuntu: sudo apt install ffmpeg', 'Fedora: sudo dnf install ffmpeg', 'Arch: sudo pacman -S ffmpeg'],
  },
  whisper: {
    windows: [
      'Download whisper-bin-x64.zip from https://github.com/ggml-org/whisper.cpp/releases',
      '  and unzip it to %LOCALAPPDATA%\\Programs\\whisper.cpp',
    ],
    mac: ['brew install whisper-cpp'],
    linux: [
      'git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp',
      'cmake -B build && cmake --build build -j --config Release   # binary: build/bin/whisper-cli',
    ],
  },
};

const KEY_PREFIX = { groq: 'gsk_', openai: 'sk-', gemini: 'AIza' };

async function keyCheck(name, key) {
  const requests = {
    groq: ['https://api.groq.com/openai/v1/models', { Authorization: `Bearer ${key}` }],
    openai: ['https://api.openai.com/v1/models', { Authorization: `Bearer ${key}` }],
    gemini: ['https://generativelanguage.googleapis.com/v1beta/models', { 'x-goog-api-key': key }],
  };
  const [url, headers] = requests[name];
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (res.ok) return { ok: true, message: 'key accepted' };
    // Gemini reports a bad key as 400 rather than 401.
    if (res.status === 401 || res.status === 403 || (name === 'gemini' && res.status === 400)) {
      return { ok: false, message: 'key REJECTED (check it was copied completely)' };
    }
    return { ok: false, message: `unexpected HTTP ${res.status}` };
  } catch (error) {
    return { ok: false, message: `could not reach the provider: ${redact(error.cause?.message || error.message, key)}` };
  }
}

function ytdlpUpdateCommand(path) {
  if (/winget/i.test(path)) return 'winget upgrade yt-dlp.yt-dlp';
  if (/homebrew|Cellar/i.test(path)) return 'brew upgrade yt-dlp';
  return `"${path}" -U`;
}

function ytdlpAgeDays(version) {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(version || '');
  if (!m) return null;
  return Math.floor((Date.now() - Date.UTC(+m[1], +m[2] - 1, +m[3])) / 86_400_000);
}

async function main() {
  const config = loadConfig();
  const tools = resolveTools(config.values);
  const nodeMajor = Number(process.versions.node.split('.')[0]);

  const report = {
    os: `${process.platform} ${process.arch}`,
    node: { version: process.versions.node, ok: nodeMajor >= MIN_NODE_MAJOR },
    tools: {},
    transcription: { providers: {}, selected: null },
    settings: { filesChecked: config.filesChecked, filesFound: config.filesFound, suggestedFile: join(USER_CONFIG_DIR, '.env') },
    cookiesFromBrowser: config.values.REELS2CLAUDE_COOKIES_FROM_BROWSER || null,
    fixes: [],
    warnings: [],
  };

  const [ytdlpVersion, ffmpegVersion, ffprobeVersion] = await Promise.all([
    toolVersion(tools.ytdlp),
    toolVersion(tools.ffmpeg, ['-version']),
    toolVersion(tools.ffprobe, ['-version']),
  ]);
  report.tools['yt-dlp'] = { path: tools.ytdlp, version: ytdlpVersion, ok: Boolean(ytdlpVersion) };
  report.tools.ffmpeg = { path: tools.ffmpeg, version: ffmpegVersion?.replace(/ Copyright.*$/, ''), ok: Boolean(ffmpegVersion) };
  report.tools.ffprobe = { path: tools.ffprobe, version: ffprobeVersion?.replace(/ Copyright.*$/, ''), ok: Boolean(ffprobeVersion) };

  if (!report.node.ok) report.fixes.push({ what: `Node.js ${MIN_NODE_MAJOR} or newer`, commands: ['Install the LTS version from https://nodejs.org'] });
  if (!report.tools['yt-dlp'].ok) report.fixes.push({ what: 'Install yt-dlp (downloads the video)', commands: INSTALL['yt-dlp'][OS] });
  if (!report.tools.ffmpeg.ok || !report.tools.ffprobe.ok) {
    report.fixes.push({ what: 'Install ffmpeg (extracts audio and frames; includes ffprobe)', commands: INSTALL.ffmpeg[OS] });
  }
  const age = ytdlpAgeDays(ytdlpVersion);
  if (age !== null && age > 60) {
    report.warnings.push(
      `yt-dlp is ${age} days old. TikTok and Instagram change often, so old versions break. Update: ${ytdlpUpdateCommand(tools.ytdlp)}`
    );
  }

  for (const name of PROVIDER_ORDER) {
    const p = PROVIDERS[name];
    if (name === 'local') {
      const local = checkLocalWhisper(config.values);
      report.transcription.providers.local = local.ok
        ? { configured: true, bin: local.bin, model: local.model }
        : { configured: false, problem: local.problem };
      continue;
    }
    const key = config.values[p.keyVar];
    const entry = { configured: Boolean(key), keyVar: p.keyVar, from: key ? config.origin[p.keyVar] : null };
    if (key) {
      if (/^\s|\s$|^["']/.test(key)) entry.warning = 'the key has spaces or quotes around it; remove them';
      else if (!key.startsWith(KEY_PREFIX[name])) entry.warning = `${p.label} keys normally start with "${KEY_PREFIX[name]}"; check it's the right key`;
      if (args.has('--check-keys')) entry.check = await keyCheck(name, key.trim());
    }
    report.transcription.providers[name] = entry;
  }
  const choice = selectProvider(config.values, checkLocalWhisper);
  report.transcription.selected = choice.name ? { name: choice.name, label: PROVIDERS[choice.name]?.label ?? 'none', model: choice.model } : null;
  if (!choice.name) {
    report.transcription.problem = choice.reason;
    report.fixes.push({
      what: 'Set up transcription (optional, but without it only on-screen text and the caption are used)',
      commands: [
        'Easiest and free: create a Groq key at https://console.groq.com/keys',
        `then put this line in ${join(USER_CONFIG_DIR, '.env')} (create the file if needed):`,
        '  GROQ_API_KEY=your-key-here',
        'Alternatives: OPENAI_API_KEY or GEMINI_API_KEY in the same file, or local whisper.cpp:',
        ...INSTALL.whisper[OS].map((l) => `  ${l}`),
        '  then download a model, e.g. https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
        '  and set WHISPER_CPP_MODEL=<path to that file> (and WHISPER_CPP_BIN if whisper-cli is not found).',
      ],
    });
  }

  const toolsOk = report.node.ok && Object.values(report.tools).every((t) => t.ok);
  report.status = !toolsOk ? 'not_ready' : choice.name ? 'ready' : 'ready_without_transcription';

  if (args.has('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printReport(report);
  }
  process.exitCode = toolsOk ? 0 : 1;
}

function printReport(r) {
  const tick = (ok) => (ok ? '[ok]     ' : '[missing]');
  const lines = [];
  lines.push('reels2Claude doctor', '===================', `System: ${r.os}, Node ${r.node.version} ${r.node.ok ? '' : '(too old)'}`.trim(), '');
  lines.push('Tools');
  for (const [name, t] of Object.entries(r.tools)) {
    lines.push(`  ${tick(t.ok)} ${name.padEnd(8)} ${t.ok ? `${t.version}  (${t.path})` : ''}`.trimEnd());
  }
  lines.push('', 'Transcription (speech -> text)');
  for (const [name, p] of Object.entries(r.transcription.providers)) {
    const label = PROVIDERS[name].label.padEnd(20);
    if (name === 'local') {
      lines.push(`  ${p.configured ? '[ok]     ' : '[-]      '} ${label} ${p.configured ? `model: ${p.model}` : p.problem}`);
      continue;
    }
    let line = `  ${p.configured ? '[ok]     ' : '[-]      '} ${label} ${p.configured ? `${p.keyVar} found (${p.from})` : `${p.keyVar} not set`}`;
    if (p.warning) line += `\n             warning: ${p.warning}`;
    if (p.check) line += `\n             online check: ${p.check.message}`;
    lines.push(line);
  }
  lines.push(
    r.transcription.selected
      ? `  -> will use: ${r.transcription.selected.label} (${r.transcription.selected.model ?? 'default model'})`
      : `  -> none: ${r.transcription.problem}`
  );
  lines.push('', 'Settings files (checked in this order, real environment variables win)');
  for (const f of r.settings.filesChecked) lines.push(`  ${r.settings.filesFound.includes(f) ? '[found]  ' : '[-]      '} ${f}`);
  lines.push('', `Instagram browser login: ${r.cookiesFromBrowser ? `ON (${r.cookiesFromBrowser})` : 'off (default)'}`);

  if (r.warnings.length) {
    lines.push('', 'Warnings');
    for (const w of r.warnings) lines.push(`  ! ${w}`);
  }
  if (r.fixes.length) {
    lines.push('', 'To fix');
    r.fixes.forEach((f, i) => {
      lines.push(`  ${i + 1}. ${f.what}`);
      for (const c of f.commands) lines.push(`       ${c}`);
    });
  }
  const verdict = {
    ready: 'READY: everything needed is installed.',
    ready_without_transcription: 'READY (partly): reels can be checked from frames and captions, but speech will not be transcribed.',
    not_ready: 'NOT READY: install the missing tools above, then run the doctor again.',
  }[r.status];
  lines.push('', verdict);
  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((error) => {
  process.stdout.write(`doctor failed unexpectedly: ${error.message}\n`);
  process.exitCode = 1;
});
