import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execFileAsync = promisify(execFile);

const MAX_SIZE_BYTES = 45 * 1024 * 1024; // 45MB — Telegram Bot API limit is 50MB
const COOKIES_PATH = process.env.YT_COOKIES_PATH || '/data/cookies.txt';

let consecutiveFailures = 0;
let adminNotified = false;
let notifyAdmin: ((msg: string) => void) | null = null;

export function setAdminNotifier(fn: (msg: string) => void): void {
  notifyAdmin = fn;
}

// Decode cookies from env var (base64) to file on startup
export function initCookies(): void {
  const b64 = process.env.YT_COOKIES_B64;
  if (!b64) return;
  try {
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    // Write to /tmp if /data doesn't exist (local dev)
    const target = fs.existsSync(path.dirname(COOKIES_PATH)) ? COOKIES_PATH : path.join(os.tmpdir(), 'yt-cookies.txt');
    fs.writeFileSync(target, decoded);
    console.log(`[downloader] cookies written to ${target} (${decoded.split('\n').length} lines)`);
  } catch (err) {
    console.warn('[downloader] failed to decode YT_COOKIES_B64:', err);
  }
}

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
    '/root/.local/bin/yt-dlp',       // pip install --break-system-packages (Railway nixpacks)
    '/usr/local/bin/yt-dlp',         // pip install location (some systems)
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
    const proxy = process.env.YT_PROXY ? 'yes' : 'no';
    const cookies = fs.existsSync(COOKIES_PATH) ? 'yes' : (fs.existsSync(path.join(os.tmpdir(), 'yt-cookies.txt')) ? 'yes (tmp)' : 'no');
    console.log(`[downloader] yt-dlp: ${bin} (${ver}), proxy: ${proxy}, cookies: ${cookies}`);
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

  // Use proxy if configured (needed for datacenter IPs blocked by YouTube)
  const proxy = process.env.YT_PROXY;
  if (proxy) {
    baseArgs.push('--proxy', proxy);
  }

  // Use cookies if available (needed for datacenter IP auth)
  const cookieCandidates = [COOKIES_PATH, path.join(os.tmpdir(), 'yt-cookies.txt')];
  for (const cp of cookieCandidates) {
    if (fs.existsSync(cp)) {
      baseArgs.push('--cookies', cp);
      break;
    }
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
    consecutiveFailures++;
    const err = new Error(`yt-dlp all attempts failed: ${lastError.slice(0, 300)}`);
    // After 3 consecutive failures, likely cookies expired
    if (consecutiveFailures >= 3 && !adminNotified) {
      adminNotified = true;
      notifyAdmin?.(`Видео не загружаются 3 раза подряд. Скорее всего cookies протухли.\n\nОбнови: экспортируй cookies с youtube.com и установи YT_COOKIES_B64 в Railway.`);
    }
    throw err;
  }
  // Reset on success
  consecutiveFailures = 0;
  if (adminNotified) adminNotified = false;

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
