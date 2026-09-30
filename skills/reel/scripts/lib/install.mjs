// Helpers for installing whisper.cpp and its model: picking the right download and
// fetching it with a checksum check.
import { createHash } from 'node:crypto';
import { createWriteStream, renameSync, rmSync } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const HEADERS = { 'User-Agent': 'reels2claude', Accept: 'application/json' };

export function windowsAssetName(arch = process.arch) {
  return arch === 'arm64' ? 'whisper-bin-win-cpu-arm64.zip' : 'whisper-bin-x64.zip';
}

// Version-number releases (v1.9.x) often ship without files; the build releases next
// to them (b4938, ...) carry the downloads. Prefer the newest full release that has the
// file, then the newest pre-release that has it.
export function pickRelease(releases, assetName) {
  const withAsset = (r) => !r.draft && (r.assets || []).some((a) => a.name === assetName);
  const release = releases.find((r) => withAsset(r) && !r.prerelease) || releases.find(withAsset);
  if (!release) return null;
  const asset = release.assets.find((a) => a.name === assetName);
  return {
    tag: release.tag_name,
    url: asset.browser_download_url,
    size: asset.size,
    sha256: /^sha256:([0-9a-f]{64})$/i.exec(asset.digest || '')?.[1]?.toLowerCase() ?? null,
  };
}

// Model files on Hugging Face, with the checksum Hugging Face publishes for each.
export function pickModel(files, name) {
  const file = files.find((f) => f.path === `ggml-${name}.bin`);
  if (!file) return null;
  return {
    file: file.path,
    url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file.path}`,
    size: file.lfs?.size ?? file.size,
    sha256: file.lfs?.oid ?? null,
  };
}

export async function getJson(url) {
  const headers = { ...HEADERS };
  // Anonymous GitHub API calls are limited per IP, which shared CI machines hit quickly.
  if (process.env.GITHUB_TOKEN && new URL(url).host === 'api.github.com') {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} returned HTTP ${res.status}`);
  return res.json();
}

// Streams to "<dest>.part", checks the SHA-256, then renames, so a broken or
// interrupted download never looks like a finished file.
export async function download(url, dest, sha256) {
  const res = await fetch(url, { headers: { 'User-Agent': HEADERS['User-Agent'] }, signal: AbortSignal.timeout(60 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`download failed: ${new URL(url).host} returned HTTP ${res.status}`);
  const hash = createHash('sha256');
  const part = `${dest}.part`;
  try {
    await pipeline(
      Readable.fromWeb(res.body),
      new Transform({
        transform(chunk, _encoding, done) {
          hash.update(chunk);
          done(null, chunk);
        },
      }),
      createWriteStream(part)
    );
  } catch (error) {
    rmSync(part, { force: true });
    throw new Error(`download interrupted (${error.message}); try again`);
  }
  const actual = hash.digest('hex');
  if (sha256 && actual !== sha256.toLowerCase()) {
    rmSync(part, { force: true });
    throw new Error('the download was corrupted (checksum mismatch); try again');
  }
  renameSync(part, dest);
  return { verified: Boolean(sha256) };
}
