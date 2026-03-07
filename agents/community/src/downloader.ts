import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execFileAsync = promisify(execFile);

const MAX_SIZE_BYTES = 45 * 1024 * 1024; // 45MB — Telegram Bot API limit is 50MB

export interface VideoMeta {
  width?: number;
  height?: number;
  duration?: number;
}

export interface DownloadResult {
  filePath: string;
  fileSizeBytes: number;
  meta: VideoMeta;
  cleanup: () => void;
}

function findYtDlp(): string {
  // Prioritize pip-installed version (latest) over nix (often outdated)
  const candidates = [
    '/usr/local/bin/yt-dlp',         // pip install location (Railway)
    '/opt/homebrew/bin/yt-dlp',      // macOS homebrew
    '/usr/bin/yt-dlp',
  ];

  // Also check PATH but only as last resort
  try {
    const fromPath = require('child_process').execFileSync('which', ['yt-dlp'], { encoding: 'utf8' }).trim();
    if (fromPath && !candidates.includes(fromPath)) {
      candidates.push(fromPath);
    }
  } catch {}

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

async function probeVideoMeta(filePath: string): Promise<VideoMeta> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      filePath,
    ], { timeout: 15_000 });
    const info = JSON.parse(stdout);
    const videoStream = info.streams?.find((s: any) => s.codec_type === 'video');
    return {
      width: videoStream?.width ? Number(videoStream.width) : undefined,
      height: videoStream?.height ? Number(videoStream.height) : undefined,
      duration: info.format?.duration ? Math.round(Number(info.format.duration)) : undefined,
    };
  } catch (err) {
    console.warn('[downloader] ffprobe failed, posting without video meta:', err);
    return {};
  }
}

export async function downloadVideo(youtubeUrl: string, youtubeId: string): Promise<DownloadResult> {
  const ytDlp = findYtDlp();
  const tmpDir = os.tmpdir();
  const outTemplate = path.join(tmpDir, `sami-${youtubeId}.%(ext)s`);

  // Target 480p mp4.
  const baseArgs = [
    youtubeUrl,
    '-f', 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best[height<=480]',
    '--merge-output-format', 'mp4',
    '-o', outTemplate,
    '--no-playlist',
    '--quiet',
    '--no-warnings',
  ];

  // Use cookies if available (needed for datacenter IPs blocked by YouTube)
  const cookiesPath = process.env.YT_COOKIES_PATH || '/data/cookies.txt';
  if (fs.existsSync(cookiesPath)) {
    baseArgs.push('--cookies', cookiesPath);
    console.log(`[downloader] using cookies from ${cookiesPath}`);
  }

  const attempts = [
    [...baseArgs, '--extractor-args', 'youtube:player_client=mediaconnect'],
    [...baseArgs, '--extractor-args', 'youtube:player_client=tv'],
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

  const meta = await probeVideoMeta(filePath);

  return {
    filePath,
    fileSizeBytes: size,
    meta,
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
