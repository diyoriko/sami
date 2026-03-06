import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execFileAsync = promisify(execFile);

const MAX_SIZE_BYTES = 45 * 1024 * 1024; // 45MB — Telegram Bot API limit is 50MB

export interface DownloadResult {
  filePath: string;
  fileSizeBytes: number;
  cleanup: () => void;
}

function findYtDlp(): string {
  // Try `which` first to find binary in any PATH (works on Railway/nix)
  try {
    const result = require('child_process').execFileSync('which', ['yt-dlp'], { encoding: 'utf8' }).trim();
    if (result) {
      require('child_process').execFileSync(result, ['--version'], { stdio: 'ignore' });
      return result;
    }
  } catch { /* not in PATH */ }

  const candidates = [
    'yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    '/opt/homebrew/bin/yt-dlp',
    '/run/current-system/sw/bin/yt-dlp', // nix
  ];
  for (const bin of candidates) {
    try {
      require('child_process').execFileSync(bin, ['--version'], { stdio: 'ignore' });
      return bin;
    } catch {
      continue;
    }
  }
  throw new Error('yt-dlp not found');
}

export function logYtDlpStatus(): void {
  try {
    const bin = findYtDlp();
    const ver = require('child_process').execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
    console.log(`[downloader] yt-dlp found: ${bin} (${ver})`);
  } catch {
    console.warn('[downloader] yt-dlp NOT found — will post YouTube links as fallback');
  }
}

export async function downloadVideo(youtubeUrl: string, youtubeId: string): Promise<DownloadResult> {
  const ytDlp = findYtDlp();
  const tmpDir = os.tmpdir();
  const outTemplate = path.join(tmpDir, `sami-${youtubeId}.%(ext)s`);

  // Target 480p mp4. android/ios player clients bypass YouTube datacenter IP blocks (Railway/VPS).
  const baseArgs = [
    youtubeUrl,
    '-f', 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best[height<=480]',
    '--merge-output-format', 'mp4',
    '-o', outTemplate,
    '--no-playlist',
    '--quiet',
    '--no-warnings',
  ];

  const attempts = [
    [...baseArgs, '--extractor-args', 'youtube:player_client=android,web'],
    [...baseArgs, '--extractor-args', 'youtube:player_client=ios'],
    [...baseArgs], // plain fallback
  ];

  let lastError = '';
  let succeeded = false;
  for (const args of attempts) {
    try {
      await execFileAsync(ytDlp, args, { timeout: 120_000 });
      succeeded = true;
      break;
    } catch (err: any) {
      lastError = err.stderr || err.message || String(err);
      console.warn(`[downloader] attempt failed: ${lastError.slice(0, 200)}`);
    }
  }
  if (!succeeded) {
    throw new Error(`yt-dlp all attempts failed: ${lastError.slice(0, 300)}`);
  }

  const filePath = path.join(tmpDir, `sami-${youtubeId}.mp4`);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Downloaded file not found: ${filePath}`);
  }

  const { size } = fs.statSync(filePath);

  if (size > MAX_SIZE_BYTES) {
    fs.unlinkSync(filePath);
    throw new Error(`File too large: ${Math.round(size / 1024 / 1024)}MB > 45MB limit`);
  }

  return {
    filePath,
    fileSizeBytes: size,
    cleanup: () => {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    },
  };
}

export function isYtDlpAvailable(): boolean {
  try {
    findYtDlp();
    return true;
  } catch {
    return false;
  }
}
