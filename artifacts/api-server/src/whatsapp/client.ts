import pkg from "whatsapp-web.js";
import { createRequire } from "module";
import path from "path";
import fs from "fs";
import os from "os";
import { execSync } from "child_process";
import { logger } from "../lib/logger.js";
import { EventEmitter } from "events";

const _require = createRequire(import.meta.url);
const qrcode = _require("qrcode-terminal") as {
  generate: (qr: string, opts?: { small?: boolean }) => void;
};
const ffmpeg = _require("fluent-ffmpeg") as typeof import("fluent-ffmpeg");

// ─── FFmpeg / FFprobe paths ───────────────────────────────────────────────────

function resolveBin(name: string): string {
  try { return execSync(`which ${name}`, { encoding: "utf8" }).trim(); }
  catch { return name; }
}

const FFMPEG_PATH  = resolveBin("ffmpeg");
const FFPROBE_PATH = resolveBin("ffprobe");

ffmpeg.setFfmpegPath(FFMPEG_PATH);
ffmpeg.setFfprobePath(FFPROBE_PATH);
logger.info({ ffmpeg: FFMPEG_PATH, ffprobe: FFPROBE_PATH }, "ffmpeg/ffprobe resolved");

const { Client, LocalAuth, MessageMedia } = pkg;

export const whatsappEvents = new EventEmitter();

let qrCodeData: string | null = null;
let isAuthenticated = false;
let isReady = false;

export function getQrCode()          { return qrCodeData; }
export function getIsAuthenticated() { return isAuthenticated; }
export function getIsReady()         { return isReady; }

const TRUSTED_NUMBER = "+13215586703";
const STATUS_TRIGGER = "Status...";

const dataDir = path.resolve(process.cwd(), ".wwebjs_auth");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// ─── WhatsApp Client ──────────────────────────────────────────────────────────

export const client = new Client({
  authStrategy: new LocalAuth({ dataPath: dataDir }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-gpu",
      // ── Memory: allow Chrome to hold large media buffers ─────────────────
      // Increase V8 heap inside the Chrome process to 4 GB so large base64
      // video strings don't trigger OOM during the upload protocol step.
      "--js-flags=--max-old-space-size=4096",
      // Suppress Chrome's memory-pressure throttling so it doesn't evict
      // in-flight media before the upload finishes.
      "--memory-pressure-off",
      // Disable Chrome's disk cache (saves I/O and avoids cache-size limits).
      "--disk-cache-size=0",
      "--media-cache-size=0",
    ],
    // ── Protocol-level timeouts ───────────────────────────────────────────
    // 5-minute window for any single CDP call — essential for >100 MB uploads.
    protocolTimeout: 300_000,
    // 0 = no timeout for the overall browser launch.
    timeout: 0,
  },
});

// ─── Events ───────────────────────────────────────────────────────────────────

client.on("qr", (qr: string) => {
  logger.info("QR code received");
  qrcode.generate(qr, { small: true });
  qrCodeData = qr;
  isAuthenticated = false;
  whatsappEvents.emit("qr", qr);
});

client.on("authenticated", () => {
  logger.info("WhatsApp authenticated");
  isAuthenticated = true;
  qrCodeData = null;
  whatsappEvents.emit("authenticated");
});

client.on("auth_failure", (msg: string) => {
  logger.error({ msg }, "WhatsApp auth failed");
  isAuthenticated = false;
  whatsappEvents.emit("auth_failure", msg);
});

client.on("ready", () => {
  logger.info("WhatsApp client ready");
  isReady = true;
  whatsappEvents.emit("ready");
});

client.on("disconnected", (reason: string) => {
  logger.warn({ reason }, "WhatsApp disconnected");
  isReady = false;
  isAuthenticated = false;
  qrCodeData = null;
  whatsappEvents.emit("disconnected", reason);
});

// ─── Codec Detection (ffprobe) ────────────────────────────────────────────────

interface CodecInfo {
  videoCodec: string;   // e.g. "h264", "hevc", "vp9"
  audioCodec: string;   // e.g. "aac", "mp3", "opus"
  isH264:     boolean;
  isAac:      boolean;
}

/**
 * Use ffprobe to read the first video and audio stream codecs from a file.
 * Returns codec names in lowercase. Resolves immediately — no transcoding.
 */
function probeCodecs(filePath: string): Promise<CodecInfo> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err || !meta) {
        logger.warn({ err: err?.message }, "ffprobe failed — assuming unknown codec");
        resolve({ videoCodec: "unknown", audioCodec: "unknown", isH264: false, isAac: false });
        return;
      }
      const streams = meta.streams ?? [];
      const videoStream = streams.find((s) => s.codec_type === "video");
      const audioStream = streams.find((s) => s.codec_type === "audio");
      const videoCodec  = (videoStream?.codec_name ?? "unknown").toLowerCase();
      const audioCodec  = (audioStream?.codec_name ?? "unknown").toLowerCase();
      const isH264 = videoCodec === "h264" || videoCodec === "avc";
      const isAac  = audioCodec === "aac";
      logger.info({ videoCodec, audioCodec, isH264, isAac }, "ffprobe codec info");
      resolve({ videoCodec, audioCodec, isH264, isAac });
    });
  });
}

// ─── Smart FFmpeg Pipeline ────────────────────────────────────────────────────

/**
 * Process a video file for WhatsApp Status upload.
 *
 * Pass-through strategy (zero quality loss, fastest path):
 *   If the video is already H.264 + AAC → copy all streams untouched.
 *   This reads the file as-is (like fs.readFileSync) with no re-encoding —
 *   identical to WhatsApp GB's "bypass compression" behaviour.
 *
 * Partial copy:
 *   If video is H.264 but audio needs conversion → copy video, transcode audio.
 *
 * Full re-encode (only when necessary):
 *   libx264 CRF 18, scale to 1080×1920 portrait, yuv420p, AAC 192k.
 *   CRF 18 is visual lossless — output is indistinguishable from the source.
 *
 * In all cases the output file is written to a temp path and the caller reads
 * it with fs.readFileSync, matching the "Raw Media Object" approach.
 */
async function processVideoSmartHD(inputPath: string): Promise<string> {
  const { isH264, isAac, videoCodec } = await probeCodecs(inputPath);

  const tmpDir = os.tmpdir();
  const id = `wa_status_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const outputPath = path.join(tmpDir, `${id}_out.mp4`);

  let mode: "passthrough" | "partial" | "reencode";
  let ffmpegOptions: string[];

  if (isH264 && isAac) {
    // ── Full pass-through: copy both streams without touching a single bit ──
    mode = "passthrough";
    ffmpegOptions = [
      "-c:v copy",
      "-c:a copy",
      "-movflags +faststart",
    ];
  } else if (isH264 && !isAac) {
    // ── Partial copy: keep original H.264 video, convert audio only ─────────
    mode = "partial";
    ffmpegOptions = [
      "-c:v copy",
      "-c:a aac",
      "-b:a 192k",
      "-movflags +faststart",
    ];
  } else {
    // ── Full re-encode: non-H.264 source (HEVC, VP9, AV1 …) ─────────────────
    mode = "reencode";
    ffmpegOptions = [
      "-c:v libx264",
      "-crf 18",
      "-preset slow",
      "-vf scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
      "-pix_fmt yuv420p",
      "-c:a aac",
      "-b:a 192k",
      "-movflags +faststart",
    ];
  }

  logger.info(
    { mode, videoCodec, inputPath, outputPath },
    `ffmpeg processing — mode: ${mode}`,
  );

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions(ffmpegOptions)
      .on("start", (cmd) => logger.info({ cmd }, "ffmpeg started"))
      .on("end", () => {
        logger.info({ mode, outputPath }, "ffmpeg finished");
        resolve(outputPath);
      })
      .on("error", (err) => {
        logger.error({ err: err.message }, "ffmpeg error");
        try { fs.unlinkSync(outputPath); } catch {}
        reject(err);
      })
      .save(outputPath);
  });
}

// ─── Media Builder ────────────────────────────────────────────────────────────

/**
 * Build MessageMedia for status@broadcast from a file path.
 *
 * Uses fs.readFileSync to load the processed video as a raw Buffer — the same
 * pattern as WhatsApp GB's "bypass compression" mode.  The exact filesize is
 * passed in the MediaData so WhatsApp's server skips its size-based re-encode.
 */
function buildMediaFromFile(filePath: string): InstanceType<typeof MessageMedia> {
  const buffer = fs.readFileSync(filePath);   // raw Buffer — no streaming, no chunking
  const base64  = buffer.toString("base64");
  const filesize = buffer.length;
  logger.info({ filePath, bytes: filesize }, "Raw Buffer loaded via fs.readFileSync");
  return new MessageMedia("video/mp4", base64, "status_video.mp4", filesize);
}

// ─── Send Options ─────────────────────────────────────────────────────────────

/**
 * Build send options for a specific file size so WhatsApp's server receives the
 * correct byte count and skips its own size-based transcoding check.
 *
 * sendMediaAsHd:       official library HD flag (whatsapp-web.js v1.34+)
 * sendVideoAsGif:      must be false — prevents GIF re-encoding path
 * sendMediaAsDocument: blocked by library for status@broadcast; not used
 * extra.isHd:          forwarded into the WhatsApp Web protocol layer
 * extra.mediaMetadata: mimics a phone-recorded Full HD video
 * extra.size:          raw byte count — tells server not to downscale
 * extra.unsafeDirectUpload: signals pre-processed content (same as GB's flag)
 */
function buildSendOptions(fileSizeBytes: number) {
  return {
    sendVideoAsGif:    false,
    sendMediaAsSticker: false,
    sendMediaAsHd:     true,
    extra: {
      isHd:               true,
      unsafeDirectUpload: true,
      size:               fileSizeBytes,
      mediaMetadata: {
        width:       1080,
        height:      1920,
        isViewOnce:  false,
      },
    },
  } as const;
}

// ─── Trusted sender check ─────────────────────────────────────────────────────

function isTrustedSender(msg: { fromMe: boolean; from: string }): boolean {
  if (msg.fromMe) return true;
  const number  = msg.from.replace("@c.us", "").replace(/\D/g, "");
  const trusted = TRUSTED_NUMBER.replace(/\D/g, "");
  return number.endsWith(trusted) || trusted.endsWith(number);
}

// ─── Download with extended timeout ──────────────────────────────────────────

/**
 * Download media with a 5-minute timeout — handles files >100 MB similar to
 * WhatsApp GB's extended download capability.
 */
async function downloadMediaWithTimeout(msg: any, timeoutMs = 300_000): Promise<any> {
  return Promise.race([
    msg.downloadMedia(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`downloadMedia timed out after ${timeoutMs / 1000}s`)),
        timeoutMs,
      ),
    ),
  ]);
}

// ─── Core upload pipeline ─────────────────────────────────────────────────────

/**
 * Full pipeline for a single video:
 *  1. Write the raw media data to a temp input file (avoids double base64 overhead)
 *  2. Run the smart ffmpeg pipeline (pass-through if already H.264 — zero quality loss)
 *  3. Read output with fs.readFileSync → raw Buffer → base64
 *  4. Send to status@broadcast with HD options
 *  5. Clean up both temp files
 */
async function sendVideoToStatus(raw: any, source: string): Promise<void> {
  if (!raw || !(raw.mimetype as string)?.startsWith("video")) {
    logger.warn({ source }, "Skipping — media is not a video");
    return;
  }

  const tmpDir    = os.tmpdir();
  const id        = `wa_in_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const inputPath = path.join(tmpDir, `${id}.mp4`);

  // Write the raw data to disk so ffmpeg reads it as a file — avoids keeping
  // the full base64 string and its decoded buffer in memory simultaneously.
  fs.writeFileSync(inputPath, Buffer.from(raw.data, "base64"));
  logger.info({ source, bytes: fs.statSync(inputPath).size }, "Temp input file written");

  let outputPath: string | null = null;
  try {
    outputPath = await processVideoSmartHD(inputPath);
    const media  = buildMediaFromFile(outputPath);
    const opts   = buildSendOptions(media.filesize as number);

    logger.info({ source, bytes: media.filesize }, "Sending to status@broadcast");
    await client.sendMessage("status@broadcast", media, opts);
    logger.info({ source }, "Video uploaded to WhatsApp Status");
    whatsappEvents.emit("status_uploaded", { source });
  } finally {
    try { fs.unlinkSync(inputPath); }  catch {}
    if (outputPath) try { fs.unlinkSync(outputPath); } catch {}
  }
}

// ─── Auto-status listener ─────────────────────────────────────────────────────

client.on("message_create", async (msg: any) => {
  try {
    if (!isTrustedSender(msg)) return;

    const body = (msg.body as string)?.trim();
    if (body !== STATUS_TRIGGER) return;

    logger.info({ from: msg.from, fromMe: msg.fromMe }, "Status trigger detected");

    if (msg.hasQuotedMsg) {
      const quoted = await msg.getQuotedMessage();
      if (quoted.hasMedia) {
        const raw = await downloadMediaWithTimeout(quoted);
        await sendVideoToStatus(raw, "quoted");
      } else {
        logger.warn("Quoted message has no media");
      }
      return;
    }

    if (msg.hasMedia) {
      const raw = await downloadMediaWithTimeout(msg);
      await sendVideoToStatus(raw, "direct");
    }
  } catch (err) {
    logger.error({ err }, "Error processing status trigger");
  }
});

// ─── Manual upload endpoint ───────────────────────────────────────────────────

/**
 * Called by the HTTP route after multer saves the upload to disk.
 * Reads the file with fs.readFileSync exactly as specified — raw Buffer,
 * no intermediate in-memory base64 conversion of the original upload.
 */
export async function uploadVideoToStatus(
  filePath: string,
  fileSize: number,
): Promise<void> {
  if (!isReady) throw new Error("WhatsApp client is not ready");

  logger.info({ filePath, fileSize }, "Manual upload started");

  let outputPath: string | null = null;
  try {
    outputPath = await processVideoSmartHD(filePath);
    const media = buildMediaFromFile(outputPath);
    const opts  = buildSendOptions(media.filesize as number);

    logger.info({ bytes: media.filesize }, "Sending manual video to status@broadcast");
    await client.sendMessage("status@broadcast", media, opts);
    logger.info("Manual video uploaded to WhatsApp Status");
    whatsappEvents.emit("status_uploaded", { source: "manual" });
  } finally {
    if (outputPath) try { fs.unlinkSync(outputPath); } catch {}
    // The input temp file is managed by multer disk storage — route cleans it up
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initWhatsApp() {
  logger.info("Initializing WhatsApp client...");
  client.initialize().catch((err: unknown) => {
    logger.error({ err }, "Failed to initialize WhatsApp client");
  });
}
