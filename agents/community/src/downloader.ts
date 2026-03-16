import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from './logger';

const execFileAsync = promisify(execFile);
const log = createLogger('downloader');

const MAX_SIZE_BYTES = 45 * 1024 * 1024; // 45MB — Telegram Bot API limit is 50MB
const COOKIES_PATH = process.env.YT_COOKIES_PATH || '/data/cookies.txt';

// Timeouts for external processes (ms)
const PIP_UPGRADE_TIMEOUT = 60_000;     // pip install --upgrade
const VERSION_CHECK_TIMEOUT = 30_000;   // yt-dlp --version
const METADATA_TIMEOUT = 15_000;        // yt-dlp --dump-json (metadata only)
const COOKIES_EXTRACT_TIMEOUT = 10_000; // yt-dlp --cookies-from-browser
const DOWNLOAD_TIMEOUT = 300_000;       // full video download (5 min max)
const DOWNLOAD_SINGLE_TIMEOUT = 120_000; // single download attempt (2 min)

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
    log.info(`cookies written to ${target}`, { lines: decoded.split('\n').length });
  } catch (err) {
    log.warn('failed to decode YT_COOKIES_B64', { error: String(err) });
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

const YT_DLP_CANDIDATES = [
  '/root/.local/bin/yt-dlp',
  '/usr/local/bin/yt-dlp',
  '/opt/homebrew/bin/yt-dlp',
  '/usr/bin/yt-dlp',
] as const;

let cachedYtDlpBin: string | null = null;

function findYtDlp(): string {
  if (cachedYtDlpBin) return cachedYtDlpBin;

  const candidates = [...YT_DLP_CANDIDATES];

  // Add PATH-discovered location
  try {
    const { execFileSync } = require('child_process');
    const fromPath = execFileSync('which', ['yt-dlp'], { encoding: 'utf8' }).trim();
    if (fromPath && !candidates.includes(fromPath)) {
      candidates.push(fromPath);
    }
  } catch {}

  // Find all working binaries, pick the newest version (semver-safe comparison)
  let bestBin = '';
  let bestVer = '';
  const { execFileSync } = require('child_process');
  for (const bin of candidates) {
    try {
      const ver = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
      if (!bestBin || ver.localeCompare(bestVer, undefined, { numeric: true }) > 0) {
        bestBin = bin;
        bestVer = ver;
      }
    } catch {
      continue;
    }
  }
  if (bestBin) {
    cachedYtDlpBin = bestBin;
    return bestBin;
  }
  throw new Error('yt-dlp not found');
}

/** Invalidate cached binary path (call after upgrade) */
function resetYtDlpCache(): void {
  cachedYtDlpBin = null;
}

/** Upgrade yt-dlp via pip at runtime (nix version is frozen/outdated) */
export async function upgradeYtDlp(): Promise<void> {
  try {
    const { stdout } = await execFileAsync(
      'pip', ['install', '--break-system-packages', '--upgrade', 'yt-dlp'],
      { timeout: PIP_UPGRADE_TIMEOUT }
    );
    resetYtDlpCache();
    const lastLine = stdout.trim().split('\n').pop() ?? '';
    log.info(`pip upgrade: ${lastLine}`);
  } catch (err: any) {
    log.warn(`pip upgrade failed (using existing version)`, { error: (err.message || '').slice(0, 200) });
  }
}

export function logYtDlpStatus(): void {
  try {
    const bin = findYtDlp();
    const ver = require('child_process').execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
    const proxy = process.env.YT_PROXY ? 'yes' : 'no';
    const cookieFile = [COOKIES_PATH, path.join(os.tmpdir(), 'yt-cookies.txt')].find(p => fs.existsSync(p));
    const cookieSize = cookieFile ? fs.statSync(cookieFile).size : 0;
    const cookies = cookieFile ? (cookieSize > 100 ? `yes (${(cookieSize / 1024).toFixed(0)}KB)` : 'skipped (empty)') : 'no';
    log.info(`yt-dlp: ${bin} (${ver}), proxy: ${proxy}, cookies: ${cookies}`);
  } catch {
    log.warn('yt-dlp NOT found — will post YouTube links as fallback');
  }
}

/** Run a real test download on startup to verify the full pipeline works */
export async function runDiagnostic(): Promise<string> {
  const lines: string[] = [];
  const log = (s: string) => { lines.push(s); console.log(`[diagnostic] ${s}`); };

  // 1. yt-dlp binary
  let bin: string;
  try {
    bin = findYtDlp();
    const ver = require('child_process').execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
    log(`yt-dlp: ${bin} (${ver})`);
  } catch {
    log('FAIL: yt-dlp not found');
    return lines.join('\n');
  }

  // 2. Proxy
  const proxy = process.env.YT_PROXY;
  log(`proxy: ${proxy ? proxy.replace(/:[^:@]+@/, ':***@') : 'none'}`);

  // 3. Cookies
  const cookieCandidates = [COOKIES_PATH, path.join(os.tmpdir(), 'yt-cookies.txt')];
  const cookieFile = cookieCandidates.find(p => fs.existsSync(p));
  log(`cookies: ${cookieFile ?? 'none (опционально)'}`);

  // 4. Test download — short public domain video
  const testUrl = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'; // "Me at the zoo" — first YouTube video, always available
  const testArgs = [testUrl, '-f', 'worst', '-o', path.join(os.tmpdir(), 'sami-diag.%(ext)s'), '--no-playlist', '--max-filesize', '5M'];
  if (proxy) testArgs.push('--proxy', proxy);
  if (cookieFile) testArgs.push('--cookies', cookieFile);

  // Try each player client
  const clients = ['mediaconnect', 'tv', 'android,web', 'ios', ''];
  for (const client of clients) {
    const args = client
      ? [...testArgs, '--extractor-args', `youtube:player_client=${client}`]
      : [...testArgs];
    try {
      const { stderr } = await execFileAsync(bin, args, { timeout: VERSION_CHECK_TIMEOUT });
      log(`OK with client=${client || 'default'}`);
      // Cleanup
      try {
        const files = require('fs').readdirSync(os.tmpdir()).filter((f: string) => f.startsWith('sami-diag'));
        files.forEach((f: string) => fs.unlinkSync(path.join(os.tmpdir(), f)));
      } catch {}
      return lines.join('\n');
    } catch (err: any) {
      const msg = (err.stderr || err.message || '').slice(0, 150);
      log(`FAIL client=${client || 'default'}: ${msg}`);
    }
  }

  log('ALL ATTEMPTS FAILED');
  return lines.join('\n');
}

async function probeVideoMeta(filePath: string): Promise<VideoMeta> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      filePath,
    ], { timeout: METADATA_TIMEOUT });
    const info = JSON.parse(stdout);
    const videoStream = info.streams?.find((s: any) => s.codec_type === 'video');
    return {
      width: videoStream?.width ? Number(videoStream.width) : undefined,
      height: videoStream?.height ? Number(videoStream.height) : undefined,
      duration: info.format?.duration ? Math.round(Number(info.format.duration)) : undefined,
    };
  } catch (err) {
    log.warn('ffprobe failed, posting without video meta', { error: String(err) });
    return {};
  }
}

/** Check if video codec is H.264. If not, re-encode with ffmpeg. */
async function ensureH264(filePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name',
      '-print_format', 'json', filePath,
    ], { timeout: COOKIES_EXTRACT_TIMEOUT });
    const codec = JSON.parse(stdout).streams?.[0]?.codec_name;
    if (codec === 'h264') return filePath;

    log.info(`video codec is ${codec}, re-encoding to H.264`);
    const outPath = filePath.replace(/\.mp4$/, '.h264.mp4');
    await execFileAsync('ffmpeg', [
      '-i', filePath, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'aac', '-movflags', '+faststart', '-y', outPath,
    ], { timeout: DOWNLOAD_TIMEOUT });
    // Replace original
    fs.unlinkSync(filePath);
    fs.renameSync(outPath, filePath);
    log.info('re-encoded to H.264 successfully');
    return filePath;
  } catch (err) {
    log.warn('H.264 check/re-encode failed, using original', { error: String(err) });
    return filePath;
  }
}

export async function downloadVideo(youtubeUrl: string, youtubeId: string): Promise<DownloadResult> {
  const ytDlp = findYtDlp();
  const tmpDir = os.tmpdir();
  const outTemplate = path.join(tmpDir, `sami-${youtubeId}.%(ext)s`);

  // Target 480p H.264 mp4 — Telegram requires H.264/AVC, not VP9/AV1.
  // Prefer avc1 (H.264), fall back to any mp4, then re-encode if needed.
  const baseArgs = [
    youtubeUrl,
    '-f', 'bestvideo[height<=480][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best[height<=480]',
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

  // Use cookies if available and non-empty (skip placeholder/empty files)
  const cookieCandidates = [COOKIES_PATH, path.join(os.tmpdir(), 'yt-cookies.txt')];
  for (const cp of cookieCandidates) {
    if (fs.existsSync(cp)) {
      const size = fs.statSync(cp).size;
      if (size > 100) { // skip empty/placeholder files
        baseArgs.push('--cookies', cp);
        break;
      }
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
      await execFileAsync(ytDlp, args, { timeout: DOWNLOAD_SINGLE_TIMEOUT });
      succeeded = true;
      break;
    } catch (err: any) {
      lastError = err.stderr || err.message || String(err);
      log.warn(`attempt failed: ${lastError.slice(0, 200)}`);
    }
  }
  if (!succeeded) {
    consecutiveFailures++;
    const err = new Error(`yt-dlp all attempts failed: ${lastError.slice(0, 300)}`);
    if (!adminNotified) {
      adminNotified = true;
      const reason = lastError.slice(0, 200);
      notifyAdmin?.(`Видео не загрузилось (фейл #${consecutiveFailures}):\n\`${reason}\``);
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

  // Ensure H.264 codec for Telegram compatibility (VP9/AV1 = black screen)
  await ensureH264(filePath);

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
