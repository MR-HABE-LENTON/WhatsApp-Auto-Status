import pkg from "whatsapp-web.js";
import { createRequire } from "module";
import path from "path";
import fs from "fs";
import os from "os";
import https from "https";
import http from "http";
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

// Regex: "Status..." optionally followed by a space, then a URL
const STATUS_TIKTOK_RE = /^Status\.\.\.\s*(https?:\/\/\S+)/i;

const dataDir = path.resolve(process.cwd(), ".wwebjs_auth");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// ─── Identity: compatible browser UA with Android platform injection ──────────
const ANDROID_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.6099.230 Safari/537.36";

// ─── WhatsApp Client ──────────────────────────────────────────────────────────

export const client = new Client({
  authStrategy: new LocalAuth({ dataPath: dataDir }),
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
      "--js-flags=--max-old-space-size=4096",
      "--memory-pressure-off",
      "--disk-cache-size=0",
      "--media-cache-size=0",
    ],
    protocolTimeout: 300_000,
    timeout: 0,
  },
});

// ─── Platform override (inject after ready) ───────────────────────────────────

async function injectAndroidPlatform(): Promise<void> {
  try {
    await (client as any).pupPage.evaluate(() => {
      try {
        if ((window as any).Store?.Conn) {
          (window as any).Store.Conn.platform = "android";
          (window as any).Store.Conn.ref      = "android";
        }
        if ((window as any).AuthStore?.RegistrationUtils) {
          (window as any).AuthStore.RegistrationUtils.DEVICE_PLATFORM = "android";
        }
      } catch (_) { /* ignore */ }
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

// ─── Pairing Code ─────────────────────────────────────────────────────────────
//
// requestPairingCode must be called while the client is in the QR phase
// (after initialization, before authentication).  The method is exposed
// on the whatsapp-web.js client as an undocumented but stable API.
//
// Phone number must be digits only, including country code (e.g. 9665xxxxxxxx).

export async function requestPairingCode(phoneNumber: string): Promise<string> {
  const digits = phoneNumber.replace(/\D/g, "");
  if (!digits || digits.length < 7) {
    throw new Error("Invalid phone number — include country code, digits only");
  }

  if (isAuthenticated || isReady) {
    throw new Error(
      "Already authenticated. Pairing code can only be requested before linking a device.",
    );
  }

  if (!(client as any).pupPage) {
    throw new Error(
      "WhatsApp client is still initializing. Wait for the QR code to appear, then try again.",
    );
  }

  logger.info({ digits }, "Requesting pairing code");

  // whatsapp-web.js exposes requestPairingCode() on the Client instance.
  // It internally calls the WhatsApp pairing API and resolves with the
  // 8-character code (e.g. "ABCD1234").
  const raw = await (client as any).requestPairingCode(digits);
  const code = String(raw ?? "").trim();

  if (!code) {
    throw new Error("WhatsApp returned an empty pairing code — check the phone number and try again");
  }

  logger.info({ code }, "Pairing code received");
  whatsappEvents.emit("pairing_code", { code });
  return code;
}

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
    // No -vf scale here — preserve the original resolution and aspect ratio.
    // Resizing is only applied when the caller explicitly requests orientation
    // conversion via convertOrientation(), not during codec normalisation.
    opts = [
      "-c:v libx264", "-crf 18", "-preset slow",
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

// ─── Orientation Conversion ───────────────────────────────────────────────────
//
// vertical  (9:16) → pad to 1080×1920 with black bars on top/bottom
// horizontal (16:9) → pad to 1920×1080 with black bars on left/right

export type Orientation = "vertical" | "horizontal";

export async function convertOrientation(
  inputPath: string,
  orientation: Orientation,
): Promise<string> {
  const id         = `wa_orient_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const outputPath = path.join(os.tmpdir(), `${id}_oriented.mp4`);

  // Rotate the video stream 90 degrees clockwise (transpose=1).
  // No scaling or padding — the video is physically spun to fill the screen.
  //
  // Quality settings are intentionally strict:
  //   -crf 18        → visually lossless (lower = better)
  //   -preset slow   → maximise compression efficiency (less data loss)
  //   -b:v 5000k     → explicit bitrate floor so WhatsApp cannot re-compress
  // These mirror what WhatsApp GB sends for high-quality status uploads.
  const vf = "transpose=1";

  logger.info({ orientation, vf, outputPath }, "Converting orientation with HD quality settings");

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        `-vf ${vf}`,
        "-c:v libx264", "-crf 18", "-preset slow", "-b:v 5000k",
        "-pix_fmt yuv420p",
        "-c:a aac", "-b:a 192k",
        "-movflags +faststart",
      ])
      .on("start", (cmd) => logger.info({ cmd }, "orientation ffmpeg started"))
      .on("end", () => { logger.info({ orientation }, "orientation ffmpeg done"); resolve(outputPath); })
      .on("error", (err) => {
        logger.error({ err: err.message }, "orientation ffmpeg error");
        try { fs.unlinkSync(outputPath); } catch {}
        reject(err);
      })
      .save(outputPath);
  });
}

// ─── TikTok HD Download ───────────────────────────────────────────────────────
//
// Uses the tikwm.com public API to resolve the HD no-watermark download URL,
// then streams the video to a temp file on disk.

export async function downloadTikTokHD(tiktokUrl: string): Promise<string> {
  logger.info({ tiktokUrl }, "Resolving TikTok HD URL via tikwm.com");

  const apiUrl =
    `https://www.tikwm.com/api/?url=${encodeURIComponent(tiktokUrl)}&hd=1`;

  const apiResponse = await fetchJson(apiUrl);

  if (!apiResponse?.data) {
    throw new Error("tikwm.com API did not return data — possibly unsupported URL");
  }

  // Prefer HD no-watermark; fall back to standard play URL
  const videoUrl: string =
    apiResponse.data.hdplay ||
    apiResponse.data.play ||
    "";

  if (!videoUrl) {
    throw new Error("No download URL found in tikwm.com response");
  }

  logger.info({ videoUrl: videoUrl.slice(0, 80) }, "Downloading TikTok video");

  const id      = `tiktok_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const outPath = path.join(os.tmpdir(), `${id}.mp4`);

  await streamUrlToFile(videoUrl, outPath);

  const bytes = fs.statSync(outPath).size;
  logger.info({ outPath, bytes }, "TikTok video downloaded");

  return outPath;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      },
      (res) => {
        // follow redirects
        if ((res.statusCode ?? 0) >= 300 && res.headers.location) {
          fetchJson(res.headers.location).then(resolve).catch(reject);
          return;
        }
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try { resolve(JSON.parse(raw)); }
          catch (e) { reject(new Error(`JSON parse error: ${(e as Error).message}\nBody: ${raw.slice(0, 200)}`)); }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error("fetchJson timeout")); });
  });
}

function streamUrlToFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const out = fs.createWriteStream(dest);

    const doGet = (targetUrl: string) => {
      const req = lib.get(
        targetUrl,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": "https://www.tiktok.com/",
          },
        },
        (res) => {
          if ((res.statusCode ?? 0) >= 300 && res.headers.location) {
            doGet(res.headers.location);
            return;
          }
          res.pipe(out);
          out.on("finish", () => out.close(() => resolve()));
          out.on("error", reject);
        },
      );
      req.on("error", reject);
      req.setTimeout(120_000, () => { req.destroy(); reject(new Error("streamUrlToFile timeout")); });
    };

    doGet(url);
  });
}

// ─── Force Document Upload via direct pupPage call ────────────────────────────

async function sendAsDocumentThroughPage(
  base64: string,
  filesize: number,
  caption: string,
): Promise<void> {
  const pupPage = (client as any).pupPage;

  await pupPage.evaluate(
    async (b64: string, size: number, cap: string) => {
      const chat = await (window as any).WWebJS.getChat("status@broadcast", { getAsModel: false });
      if (!chat) throw new Error("status@broadcast chat not found");

      await (window as any).WWebJS.sendMessage(chat, cap, {
        media: {
          mimetype: "video/mp4",
          data:     b64,
          filename: "status_video.mp4",
          filesize: size,
        },
        caption,
        sendMediaAsDocument: true,
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

// ─── sendFilePathToStatus (shared by manual upload & link download) ───────────

export async function sendFilePathToStatus(
  inputPath: string,
  orientation?: Orientation | null,
): Promise<void> {
  let orientedPath: string | null = null;
  let processedPath: string | null = null;

  try {
    // Optionally re-orient first
    const workingPath =
      orientation ? await convertOrientation(inputPath, orientation) : inputPath;
    if (orientation) orientedPath = workingPath;

    processedPath = await processVideoSmartHD(workingPath);
    const media   = buildMediaFromFile(processedPath);
    const outSize = media.filesize as number;
    const mb      = (outSize / 1024 / 1024).toFixed(2);

    if (outSize > DOCUMENT_FORCE_THRESHOLD_BYTES) {
      logger.info({ mb }, "Large file — using Force Document Upload");
      await sendAsDocumentThroughPage(media.data, outSize, "");
    } else {
      logger.info({ mb }, "Sending via standard status path");
      await client.sendMessage("status@broadcast", media, buildSendOptions(outSize));
    }

    logger.info({ mb }, "Video uploaded to WhatsApp Status");
    whatsappEvents.emit("status_uploaded", { source: "manual" });
  } finally {
    if (orientedPath) try { fs.unlinkSync(orientedPath); } catch {}
    if (processedPath) try { fs.unlinkSync(processedPath); } catch {}
  }
}

// ─── Manual upload endpoint ───────────────────────────────────────────────────

export async function uploadVideoToStatus(
  filePath: string,
  fileSize: number,
  orientation?: Orientation | null,
): Promise<void> {
  if (!isReady) throw new Error("WhatsApp client is not ready");
  logger.info({ filePath, fileSize, orientation }, "Manual upload started");
  await sendFilePathToStatus(filePath, orientation);
}

// ─── Auto-status listener (chat messages) ────────────────────────────────────

client.on("message_create", async (msg: any) => {
  try {
    if (!isTrustedSender(msg)) return;

    const body = (msg.body as string)?.trim() ?? "";

    // ── TikTok URL variant: "Status...URL" or "Status... URL" ──────────────
    const tikTokMatch = STATUS_TIKTOK_RE.exec(body);
    if (tikTokMatch) {
      const tiktokUrl = tikTokMatch[1]!;
      logger.info({ tiktokUrl }, "TikTok Status trigger detected in chat");

      let tiktokPath: string | null = null;
      try {
        tiktokPath = await downloadTikTokHD(tiktokUrl);
        await sendFilePathToStatus(tiktokPath, null);

        // Confirmation reply
        try {
          await msg.reply("✅ TikTok video is being uploaded to your Status!");
        } catch {}
      } finally {
        if (tiktokPath) try { fs.unlinkSync(tiktokPath); } catch {}
      }
      return;
    }

    // ── Standard "Status..." trigger (direct video or quoted video) ─────────
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
