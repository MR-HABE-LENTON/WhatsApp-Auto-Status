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

// ─── Identity: compatible browser UA with Android platform injection ──────────
//
// WhatsApp Web requires a desktop browser User-Agent to function correctly —
// passing a native WhatsApp Android UA causes the Web interface to reject the
// connection (auth timeout).  We therefore keep a standard Chrome desktop UA
// for HTTP/WebSocket transport, and inject the Android platform identity at the
// JavaScript level via window.Store.Conn.platform after the client is ready.
//
// This is the correct split: transport layer speaks browser, session layer
// identifies as Android — exactly the same split that WhatsApp GB uses when
// connecting through its internal WebView.
const ANDROID_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.6099.230 Safari/537.36";

// ─── WhatsApp Client ──────────────────────────────────────────────────────────

export const client = new Client({
  authStrategy: new LocalAuth({ dataPath: dataDir }),

  // ── Android identity ────────────────────────────────────────────────────────
  // Overrides the default macOS/Chrome UA with our Android GB identity.
  // whatsapp-web.js passes this to both the --user-agent Chrome arg AND
  // page.setUserAgent(), so every request carries the Android fingerprint.
  userAgent: ANDROID_USER_AGENT,

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
      // Memory: allow Chrome to hold large media buffers in V8 (4 GB heap)
      "--js-flags=--max-old-space-size=4096",
      // Prevent Chrome from evicting in-flight media under memory pressure
      "--memory-pressure-off",
      // Disable Chrome's disk/media cache overhead
      "--disk-cache-size=0",
      "--media-cache-size=0",
    ],
    // 5-minute CDP timeout for large media uploads (>100 MB)
    protocolTimeout: 300_000,
    timeout: 0,
  },
});

// ─── Platform override (inject after ready) ───────────────────────────────────
//
// WhatsApp Web normally identifies as platform "web".  We override
// window.Store.Conn.platform to "android" after the client is ready so that
// the session appears to originate from an Android device.  This is the same
// platform value WhatsApp GB sends and is the key reason GB clients bypass
// server-side size restrictions that apply to regular web clients.

async function injectAndroidPlatform(): Promise<void> {
  try {
    await (client as any).pupPage.evaluate(() => {
      try {
        if ((window as any).Store?.Conn) {
          (window as any).Store.Conn.platform = "android";
          (window as any).Store.Conn.ref      = "android";
        }
        // Also patch the AuthStore so any re-registration keeps the platform
        if ((window as any).AuthStore?.RegistrationUtils) {
          (window as any).AuthStore.RegistrationUtils.DEVICE_PLATFORM = "android";
        }
      } catch (_) { /* ignore — Store may not be fully initialised */ }
    });
    logger.info("Android platform identity injected");
  } catch (err) {
    logger.warn({ err }, "Platform injection failed — continuing with default");
  }
}

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

client.on("ready", async () => {
  logger.info("WhatsApp client ready");
  isReady = true;
  await injectAndroidPlatform();
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
  videoCodec: string;
  audioCodec: string;
  isH264:     boolean;
  isAac:      boolean;
}

function probeCodecs(filePath: string): Promise<CodecInfo> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err || !meta) {
        logger.warn({ err: err?.message }, "ffprobe failed — assuming unknown codec");
        resolve({ videoCodec: "unknown", audioCodec: "unknown", isH264: false, isAac: false });
        return;
      }
      const streams     = meta.streams ?? [];
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
//
// Pass-through (H.264 + AAC): stream-copy both tracks — zero quality loss, fastest.
// Partial copy (H.264 only):  copy video, transcode audio to AAC only.
// Full re-encode:             libx264 CRF 18 (visual lossless) → 1080×1920 portrait.

async function processVideoSmartHD(inputPath: string): Promise<string> {
  const { isH264, isAac, videoCodec } = await probeCodecs(inputPath);

  const id         = `wa_status_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const outputPath = path.join(os.tmpdir(), `${id}_out.mp4`);

  let mode: "passthrough" | "partial" | "reencode";
  let opts: string[];

  if (isH264 && isAac) {
    mode = "passthrough";
    opts = ["-c:v copy", "-c:a copy", "-movflags +faststart"];
  } else if (isH264 && !isAac) {
    mode = "partial";
    opts = ["-c:v copy", "-c:a aac", "-b:a 192k", "-movflags +faststart"];
  } else {
    mode = "reencode";
    opts = [
      "-c:v libx264", "-crf 18", "-preset slow",
      "-vf scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
      "-pix_fmt yuv420p",
      "-c:a aac", "-b:a 192k",
      "-movflags +faststart",
    ];
  }

  logger.info({ mode, videoCodec, outputPath }, `ffmpeg — mode: ${mode}`);

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions(opts)
      .on("start", (cmd) => logger.info({ cmd }, "ffmpeg started"))
      .on("end", () => { logger.info({ mode }, "ffmpeg done"); resolve(outputPath); })
      .on("error", (err) => {
        logger.error({ err: err.message }, "ffmpeg error");
        try { fs.unlinkSync(outputPath); } catch {}
        reject(err);
      })
      .save(outputPath);
  });
}

// ─── Force Document Upload via direct pupPage call ────────────────────────────
//
// The whatsapp-web.js Node.js layer explicitly rejects sendMediaAsDocument for
// status@broadcast before the message even reaches the browser.  We bypass this
// by calling window.WWebJS.sendMessage() directly inside pupPage.evaluate(),
// which skips the Node.js guard entirely and goes straight to the WhatsApp Web
// internal API with forceDocument: true.
//
// Why documents bypass the 64 MB limit:
//  - WhatsApp's media server treats video/document uploads differently from
//    status media uploads: documents go through the document CDN path which has
//    a higher (or no enforced) size ceiling.
//  - WhatsApp GB uses exactly this technique — it sends large status videos as
//    document-type media objects that are then displayed inline as video.

async function sendAsDocumentThroughPage(
  base64: string,
  filesize: number,
  caption: string,
): Promise<void> {
  const pupPage = (client as any).pupPage;

  await pupPage.evaluate(
    async (b64: string, size: number, cap: string) => {
      // Resolve the status broadcast chat directly in the browser context
      const chat = await (window as any).WWebJS.getChat("status@broadcast", { getAsModel: false });
      if (!chat) throw new Error("status@broadcast chat not found");

      // Build the media info object exactly as whatsapp-web.js would,
      // but with sendMediaAsDocument: true (forceDocument path)
      await (window as any).WWebJS.sendMessage(chat, cap, {
        media: {
          mimetype: "video/mp4",
          data:     b64,
          filename: "status_video.mp4",
          filesize: size,
        },
        caption:             cap,
        sendMediaAsDocument: true,   // ← force document upload (bypasses 64 MB limit)
        sendMediaAsHd:       true,
        sendVideoAsGif:      false,
      });
    },
    base64,
    filesize,
    caption,
  );
}

// ─── Media Builder ────────────────────────────────────────────────────────────

function buildMediaFromFile(filePath: string): InstanceType<typeof MessageMedia> {
  const buffer   = fs.readFileSync(filePath);
  const base64   = buffer.toString("base64");
  const filesize = buffer.length;
  logger.info({ filePath, bytes: filesize }, "Raw Buffer loaded via fs.readFileSync");
  return new MessageMedia("video/mp4", base64, "status_video.mp4", filesize);
}

// ─── Send Options (standard path) ────────────────────────────────────────────

function buildSendOptions(fileSizeBytes: number) {
  return {
    sendVideoAsGif:     false,
    sendMediaAsSticker: false,
    sendMediaAsHd:      true,
    extra: {
      isHd:               true,
      unsafeDirectUpload: true,
      size:               fileSizeBytes,
      mediaMetadata: {
        width:      1080,
        height:     1920,
        isViewOnce: false,
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
//
// For files ≤ ~64 MB: use the standard sendMessage path (fast, reliable).
// For files  > 64 MB: use Force Document Upload via direct pupPage.evaluate()
//   to bypass both the Node.js library guard and the server's size check.
//
// The threshold is conservative (60 MB) to give headroom for base64 overhead.

const DOCUMENT_FORCE_THRESHOLD_BYTES = 60 * 1024 * 1024; // 60 MB

async function sendVideoToStatus(raw: any, source: string): Promise<void> {
  if (!raw || !(raw.mimetype as string)?.startsWith("video")) {
    logger.warn({ source }, "Skipping — media is not a video");
    return;
  }

  const tmpDir    = os.tmpdir();
  const id        = `wa_in_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const inputPath = path.join(tmpDir, `${id}.mp4`);

  fs.writeFileSync(inputPath, Buffer.from(raw.data, "base64"));
  const inBytes = fs.statSync(inputPath).size;
  logger.info({ source, bytes: inBytes }, "Temp input file written");

  let outputPath: string | null = null;
  try {
    outputPath = await processVideoSmartHD(inputPath);
    const media   = buildMediaFromFile(outputPath);
    const outSize = media.filesize as number;
    const mb      = (outSize / 1024 / 1024).toFixed(2);

    if (outSize > DOCUMENT_FORCE_THRESHOLD_BYTES) {
      logger.info({ source, mb }, "Large file — using Force Document Upload");
      await sendAsDocumentThroughPage(media.data, outSize, "");
    } else {
      logger.info({ source, mb }, "Sending via standard status path");
      await client.sendMessage("status@broadcast", media, buildSendOptions(outSize));
    }

    logger.info({ source, mb }, "Video uploaded to WhatsApp Status");
    whatsappEvents.emit("status_uploaded", { source });
  } finally {
    try { fs.unlinkSync(inputPath);  } catch {}
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

export async function uploadVideoToStatus(
  filePath: string,
  fileSize: number,
): Promise<void> {
  if (!isReady) throw new Error("WhatsApp client is not ready");

  logger.info({ filePath, fileSize }, "Manual upload started");

  let outputPath: string | null = null;
  try {
    outputPath = await processVideoSmartHD(filePath);
    const media   = buildMediaFromFile(outputPath);
    const outSize = media.filesize as number;
    const mb      = (outSize / 1024 / 1024).toFixed(2);

    if (outSize > DOCUMENT_FORCE_THRESHOLD_BYTES) {
      logger.info({ mb }, "Large file — using Force Document Upload");
      await sendAsDocumentThroughPage(media.data, outSize, "");
    } else {
      logger.info({ mb }, "Sending via standard status path");
      await client.sendMessage("status@broadcast", media, buildSendOptions(outSize));
    }

    logger.info({ mb }, "Manual video uploaded to WhatsApp Status");
    whatsappEvents.emit("status_uploaded", { source: "manual" });
  } finally {
    if (outputPath) try { fs.unlinkSync(outputPath); } catch {}
  }
}

// ─── Init with retry ──────────────────────────────────────────────────────────

const MAX_INIT_RETRIES = 3;

async function tryInitialize(attempt = 1): Promise<void> {
  try {
    logger.info({ attempt }, "Initializing WhatsApp client...");
    await client.initialize();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, attempt }, "WhatsApp init failed");

    if (attempt < MAX_INIT_RETRIES) {
      const delay = attempt * 5_000;
      logger.info({ delay }, `Retrying in ${delay / 1000}s...`);
      await new Promise((r) => setTimeout(r, delay));

      // If the session appears stale (auth timeout), wipe it so the next
      // attempt starts fresh and requests a new QR.
      if (msg.includes("auth timeout") || msg.includes("auth_failure")) {
        try {
          fs.rmSync(dataDir, { recursive: true, force: true });
          fs.mkdirSync(dataDir, { recursive: true });
          logger.info("Stale session cleared — will request new QR on retry");
        } catch {}
      }

      await tryInitialize(attempt + 1);
    } else {
      logger.error("All WhatsApp init attempts failed. Restart the service to try again.");
    }
  }
}

export function initWhatsApp() {
  tryInitialize().catch(() => {});
}
