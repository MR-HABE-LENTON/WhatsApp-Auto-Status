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
  webVersionCache: { type: "none" },
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
      "--disable-features=IsolateOrigins",
      "--disable-site-isolation-trials",
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

  // Attach browser console listener once the page is live so we can
  // see WhatsApp Web's internal error messages (e.g. pairing rejections).
  const page = (client as any).pupPage;
  if (page && !page._wwaConsoleAttached) {
    page._wwaConsoleAttached = true;
    page.on("console", (msg: any) => {
      const type = msg.type?.();
      if (type === "error" || type === "warning") {
        logger.warn({ browserConsole: msg.text?.() }, "WhatsApp browser console");
      }
    });
    page.on("pageerror", (err: Error) => {
      logger.warn({ pageerror: err.message }, "WhatsApp page error");
    });
  }
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
//
// WhatsApp's own page JS fires `window.onCodeReceivedEvent(code)` when the
// server responds with the pairing code.  If that function is not defined in
// the Puppeteer page context, whatsapp-web.js throws "window.onCodeReceivedEvent
// is not a function".  We register it once via exposeFunction so both the
// direct-return path and the callback path are handled gracefully.

let _codeEventRegistered  = false;
let _pendingCodeResolve: ((code: string) => void) | null = null;

async function ensureOnCodeReceivedEvent(): Promise<void> {
  if (_codeEventRegistered) return;
  const page = (client as any).pupPage;
  if (!page) return;
  try {
    await page.exposeFunction("onCodeReceivedEvent", (code: string) => {
      logger.info({ code }, "onCodeReceivedEvent fired from browser page");
      _pendingCodeResolve?.(code);
      _pendingCodeResolve = null;
    });
  } catch {
    // Already exposed on a previous call — safe to ignore
  }
  _codeEventRegistered = true;
}

// ─── Phone number normalisation ───────────────────────────────────────────────
//
// Accepts any user-typed format and returns digits-only with country code:
//   "+966 54 123 4567" → "966541234567"
//   "0541234567"       → "966541234567"  (Saudi local 05x format)
//   "966541234567"     → "966541234567"  (already correct)

function normalisePhone(raw: string): string {
  let digits = raw.replace(/\D/g, "");
  // Saudi local format: starts with "05" → replace leading "0" with "966"
  if (digits.startsWith("05")) {
    digits = "966" + digits.slice(1);
  }
  return digits;
}

export async function requestPairingCode(rawPhone: string): Promise<string> {
  const digits = normalisePhone(rawPhone);

  if (!digits || digits.length < 10) {
    throw new Error(
      "Invalid phone number — enter with country code, e.g. 9665xxxxxxxx or local 05xxxxxxxx",
    );
  }

  // Fix #3 — verify the client is actually in the auth-waiting phase.
  // qrCodeData is only non-null after the "qr" event fires, meaning the page
  // has rendered and is ready to accept a pairing code request.
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

  if (!qrCodeData) {
    throw new Error(
      "WhatsApp has not yet generated a QR code. Wait for the QR to appear on screen, then try again.",
    );
  }

  // Register window.onCodeReceivedEvent in the Puppeteer page so WhatsApp's
  // own JS can invoke it when the code arrives, preventing the crash.
  await ensureOnCodeReceivedEvent();

  logger.info({ digits }, "Requesting pairing code");

  // ── Ironclad 15-second timeout ────────────────────────────────────────────
  // If Puppeteer hangs (e.g. WhatsApp rejects the number and never responds),
  // the timeout promise wins the race and rejects with a clear message.

  const TIMEOUT_MS = 15_000;
  const TIMEOUT_ERROR = "Timeout: WhatsApp rejected the number or failed to generate a code.";

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => {
      _pendingCodeResolve = null;
      reject(new Error(TIMEOUT_ERROR));
    }, TIMEOUT_MS),
  );

  // ── Single call attempt ───────────────────────────────────────────────────
  // We bypass whatsapp-web.js's requestPairingCode() and drive pupPage.evaluate()
  // ourselves with full per-step error capture.
  //
  // Strategy:
  //  • Always clear codeInterval first (matches whatsapp-web.js).
  //  • Try the full flow: setPairingType → initializeAltDeviceLinking → startAltLinkingFlow.
  //  • If initializeAltDeviceLinking throws CompanionHelloError (happens on some
  //    sessions/numbers), fall back to calling startAltLinkingFlow directly.
  //  • Return a fully-serialised result object so we can log details in Node.js.
  type EvalResult =
    | { ok: true;  code: string }
    | { ok: false; step: string; errMsg: string; errName: string; errStr: string; errProps: Record<string, string> };

  const singleAttempt = async (): Promise<string> => {
    const page = (client as any).pupPage;

    // Register callback BEFORE calling into the page so we never miss an early fire.
    const codeViaCallback = new Promise<string>((resolve) => {
      _pendingCodeResolve = resolve;
    });

    const result: EvalResult = await page.evaluate(async (phoneNumber: string) => {
      // ─── helper: serialise any thrown value ──────────────────────────────
      const serr = (err: any, step: string): EvalResult => {
        const props: Record<string, string> = { step };
        try {
          for (const k of Object.keys(err || {})) {
            try {
              const v = (err as any)[k];
              props[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
            } catch { props[k] = "(unserializable)"; }
          }
          if (err?.stack) props["stack"] = String(err.stack).slice(0, 400);
        } catch { /* ignore */ }
        return { ok: false, step, errMsg: String(err?.message ?? ""), errName: String(err?.name ?? ""), errStr: String(err), errProps: props };
      };

      // ─── wait for PairingCodeLinkUtils ───────────────────────────────────
      let waited = 0;
      while (!(window as any).AuthStore?.PairingCodeLinkUtils && waited < 5_000) {
        await new Promise((r) => setTimeout(r, 250));
        waited += 250;
      }
      if (!(window as any).AuthStore?.PairingCodeLinkUtils) {
        return { ok: false, step: "wait", errMsg: "PairingCodeLinkUtils not ready", errName: "NotReady", errStr: "NotReady", errProps: {} };
      }
      const utils = (window as any).AuthStore.PairingCodeLinkUtils;

      // ─── clear any old refresh interval (matches whatsapp-web.js) ────────
      if ((window as any).codeInterval) clearInterval((window as any).codeInterval);

      // ─── setPairingType ───────────────────────────────────────────────────
      try { utils.setPairingType("ALT_DEVICE_LINKING"); }
      catch (err: any) { return serr(err, "setPairingType"); }

      // ─── initializeAltDeviceLinking (optional — skip on CompanionHelloError) ─
      let skipInit = false;
      try {
        await utils.initializeAltDeviceLinking();
      } catch (err: any) {
        const name = String(err?.name ?? err?.message ?? "");
        if (name.toLowerCase().includes("companionhello") || name === "t") {
          skipInit = true; // known transient error — try startAltLinkingFlow directly
        } else {
          return serr(err, "initializeAltDeviceLinking");
        }
      }

      // ─── startAltLinkingFlow ──────────────────────────────────────────────
      let codeStr = "";
      try {
        const raw = await utils.startAltLinkingFlow(phoneNumber, true);
        codeStr = typeof raw === "string" ? raw.trim() : "";
      } catch (err: any) {
        const r = serr(err, "startAltLinkingFlow");
        (r as any).skippedInit = skipInit;
        return r;
      }

      // ─── fire Node.js callback ────────────────────────────────────────────
      if (typeof (window as any).onCodeReceivedEvent === "function") {
        (window as any).onCodeReceivedEvent(codeStr);
      }

      return { ok: true, code: codeStr };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }, digits) as EvalResult;

    logger.info({ pairingResult: result }, "Page.evaluate pairing result");

    if (result.ok) {
      const directCode = result.code;
      if (directCode) {
        _pendingCodeResolve = null;
        return directCode;
      }
      // ok but empty — wait up to 5 s for callback
      logger.info("startAltLinkingFlow returned empty code — awaiting callback");
      const code = await Promise.race([
        codeViaCallback,
        new Promise<string>((resolve) => setTimeout(() => resolve(""), 5_000)),
      ]);
      _pendingCodeResolve = null;
      return code;
    }

    // Failed — check if callback resolved (code delivered via interval/other path)
    const cbCode = await Promise.race([
      codeViaCallback,
      new Promise<string>((resolve) => setTimeout(() => resolve(""), 500)),
    ]);
    _pendingCodeResolve = null;

    if (cbCode) return cbCode;

    // Surface meaningful error with full detail
    const e = result as Extract<EvalResult, { ok: false }>;
    throw new Error(
      `WhatsApp rejected the request at step "${e.step}" — ${e.errName}: ${e.errMsg || e.errStr}` +
      (Object.keys(e.errProps).length > 1
        ? " | " + JSON.stringify(e.errProps)
        : ""),
    );
  };

  // ── Fix #1 — Wait & Retry logic ───────────────────────────────────────────
  // The Puppeteer page often needs a few extra seconds after the QR event to
  // fully render the pairing-code DOM.  If the first attempt returns empty or
  // throws, wait 3 s and try exactly once more before giving up.
  const pairingAttempt = async (): Promise<string> => {
    let code: string | undefined;

    try {
      code = await singleAttempt();
    } catch (err: unknown) {
      logger.warn({ err: (err as Error).message }, "Attempt 1 threw — waiting 3s before retry");
    }

    if (code) return code;

    // Empty result or thrown error on attempt #1 — retry after 3 s
    logger.warn("Attempt 1 returned empty or failed — waiting 3s, then retrying");
    await new Promise((r) => setTimeout(r, 3_000));

    code = await singleAttempt(); // throws naturally if attempt #2 also fails
    if (!code) {
      throw new Error(
        "WhatsApp returned an empty pairing code after retry — check the number and try again",
      );
    }
    return code;
  };

  const code = await Promise.race([pairingAttempt(), timeoutPromise]);

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
//
// Three rules driven by file size and the shouldRotate flag:
//
//   RULE A – Original Quality (passthrough):
//     size < 150 MB AND shouldRotate = false
//     → "-c:v copy -c:a copy"  (zero re-encoding, exact original file preserved)
//
//   RULE B – High-Quality Rotation:
//     shouldRotate = true AND size < 150 MB
//     → transpose=1, libx264 crf=18, bitrate floor 8000k
//
//   RULE C – Massive File Compression (size ≥ 150 MB, any rotation):
//     → libx264 crf=20, maxrate 8M, bufsize 16M
//       (+ transpose=1 if shouldRotate)

const SIZE_150MB = 150 * 1024 * 1024;

export type Orientation = "vertical" | "horizontal"; // kept for TikTok route compat

async function processVideo(
  inputPath: string,
  fileSizeBytes: number,
  shouldRotate: boolean,
): Promise<string> {
  const id         = `wa_proc_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const outputPath = path.join(os.tmpdir(), `${id}_out.mp4`);

  let mode: string;
  let opts: string[];

  if (fileSizeBytes >= SIZE_150MB) {
    // RULE C — large file: compress regardless, optionally rotate
    mode = "rule-C-compress";
    const vfParts = shouldRotate ? ["-vf", "transpose=1"] : [];
    opts = [
      ...vfParts,
      "-c:v", "libx264",
      "-crf", "20",
      "-maxrate", "8M",
      "-bufsize", "16M",
      "-c:a", "aac",
      "-b:a", "192k",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
    ];
  } else if (shouldRotate) {
    // RULE B — rotate with high quality, file is under 150 MB
    mode = "rule-B-rotate";
    opts = [
      "-vf", "transpose=1",
      "-c:v", "libx264",
      "-crf", "18",
      "-b:v", "8000k",
      "-c:a", "aac",
      "-b:a", "192k",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
    ];
  } else {
    // RULE A — passthrough, under 150 MB, no rotation
    mode = "rule-A-passthrough";
    opts = ["-c:v", "copy", "-c:a", "copy", "-movflags", "+faststart"];
  }

  const mb = (fileSizeBytes / 1024 / 1024).toFixed(1);
  logger.info({ mode, mb, shouldRotate, outputPath }, "ffmpeg processing started");

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions(opts)
      .on("start", (cmd) => logger.info({ cmd }, "ffmpeg command"))
      .on("end", () => { logger.info({ mode }, "ffmpeg done"); resolve(outputPath); })
      .on("error", (err) => {
        logger.error({ err: err.message }, "ffmpeg error");
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
        extra: {
          isHd:               true,
          unsafeDirectUpload: true,
          size:               size,
          mediaMetadata: {
            width:      1080,
            height:     1920,
            isViewOnce: false,
          },
        },
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
    // Auto-upload from messages never rotates — apply Rule A or C based on size
    outputPath = await processVideo(inputPath, inBytes, false);
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
  shouldRotate: boolean,
): Promise<void> {
  const inBytes      = fs.statSync(inputPath).size;
  let processedPath: string | null = null;

  try {
    // Single processVideo call handles all three rules (A/B/C)
    processedPath = await processVideo(inputPath, inBytes, shouldRotate);
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
    if (processedPath) try { fs.unlinkSync(processedPath); } catch {}
  }
}

// ─── Manual upload endpoint ───────────────────────────────────────────────────

export async function uploadVideoToStatus(
  filePath: string,
  fileSize: number,
  shouldRotate: boolean,
): Promise<void> {
  if (!isReady) throw new Error("WhatsApp client is not ready");
  logger.info({ filePath, fileSize, shouldRotate }, "Manual upload started");
  await sendFilePathToStatus(filePath, shouldRotate);
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
        await sendFilePathToStatus(tiktokPath, false);

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
