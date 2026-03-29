import pkg from "whatsapp-web.js";
import { createRequire } from "module";
const _require = createRequire(import.meta.url);
const qrcode = _require("qrcode-terminal") as { generate: (qr: string, opts?: { small?: boolean }) => void };
import path from "path";
import fs from "fs";
import { logger } from "../lib/logger.js";
import { EventEmitter } from "events";

const { Client, LocalAuth, MessageMedia } = pkg;

export const whatsappEvents = new EventEmitter();

let qrCodeData: string | null = null;
let isAuthenticated = false;
let isReady = false;

export function getQrCode() {
  return qrCodeData;
}

export function getIsAuthenticated() {
  return isAuthenticated;
}

export function getIsReady() {
  return isReady;
}

const TRUSTED_NUMBER = "+13215586703";
const STATUS_TRIGGER = "Status...";

const dataDir = path.resolve(process.cwd(), ".wwebjs_auth");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: dataDir,
  }),
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
    ],
  },
});

client.on("qr", (qr: string) => {
  logger.info("QR code received, scan to authenticate");
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
  logger.error({ msg }, "WhatsApp authentication failed");
  isAuthenticated = false;
  whatsappEvents.emit("auth_failure", msg);
});

client.on("ready", () => {
  logger.info("WhatsApp client is ready");
  isReady = true;
  whatsappEvents.emit("ready");
});

client.on("disconnected", (reason: string) => {
  logger.warn({ reason }, "WhatsApp client disconnected");
  isReady = false;
  isAuthenticated = false;
  qrCodeData = null;
  whatsappEvents.emit("disconnected", reason);
});

function isTrustedSender(msg: { fromMe: boolean; from: string }): boolean {
  if (msg.fromMe) return true;
  const number = msg.from.replace("@c.us", "").replace(/\D/g, "");
  const trusted = TRUSTED_NUMBER.replace(/\D/g, "");
  return number.endsWith(trusted) || trusted.endsWith(number);
}

/**
 * Build a high-quality MessageMedia for video status upload.
 *
 * Key decisions to bypass WhatsApp compression:
 *  - Force mimetype to "video/mp4" so WhatsApp recognises the container correctly.
 *  - Supply a filename ending in ".mp4" — WhatsApp uses this to decide whether to transcode.
 *  - Supply the filesize in bytes — when present, WhatsApp skips its size-based re-encode check.
 *  - sendMediaAsHd: true  → instructs the client to upload in HD quality.
 *  - sendVideoAsGif: false → explicitly prevents the GIF re-encoding path.
 *  - sendMediaAsSticker: false → safety guard.
 *  NOTE: sendMediaAsDocument is blocked by the library for status@broadcast, so we do NOT use it.
 */
function buildVideoMedia(base64Data: string, originalMimetype: string, fileSizeBytes?: number): InstanceType<typeof MessageMedia> {
  const mimetype = "video/mp4";
  const filename = "status_video.mp4";
  const filesize = fileSizeBytes ?? Math.ceil((base64Data.length * 3) / 4);
  return new MessageMedia(mimetype, base64Data, filename, filesize);
}

/** Options passed to every status sendMessage call for maximum quality */
const STATUS_SEND_OPTIONS = {
  sendVideoAsGif: false,
  sendMediaAsSticker: false,
  sendMediaAsHd: true,
} as const;

client.on("message_create", async (msg: any) => {
  try {
    if (!isTrustedSender(msg)) return;

    const body = (msg.body as string)?.trim();
    if (body !== STATUS_TRIGGER) return;

    logger.info({ from: msg.from, fromMe: msg.fromMe }, "Status trigger detected");

    if (msg.hasQuotedMsg) {
      const quoted = await msg.getQuotedMessage();
      if (quoted.hasMedia) {
        const raw = await quoted.downloadMedia();
        if (raw && (raw.mimetype as string)?.startsWith("video")) {
          const media = buildVideoMedia(raw.data, raw.mimetype);
          logger.info("Uploading quoted video to WhatsApp Status (HD)");
          await client.sendMessage("status@broadcast", media, STATUS_SEND_OPTIONS);
          logger.info("Quoted video uploaded to Status");
          whatsappEvents.emit("status_uploaded", { source: "quoted" });
        } else {
          logger.warn("Quoted message has no video media");
        }
      }
      return;
    }

    if (msg.hasMedia) {
      const raw = await msg.downloadMedia();
      if (raw && (raw.mimetype as string)?.startsWith("video")) {
        const media = buildVideoMedia(raw.data, raw.mimetype);
        logger.info("Uploading video to WhatsApp Status (HD)");
        await client.sendMessage("status@broadcast", media, STATUS_SEND_OPTIONS);
        logger.info("Video uploaded to Status");
        whatsappEvents.emit("status_uploaded", { source: "direct" });
      } else {
        logger.warn("Message media is not a video");
      }
    }
  } catch (err) {
    logger.error({ err }, "Error processing status trigger");
  }
});

export async function uploadVideoToStatus(
  mediaData: string,
  mimetype: string,
  fileSizeBytes?: number,
): Promise<void> {
  if (!isReady) {
    throw new Error("WhatsApp client is not ready");
  }
  const media = buildVideoMedia(mediaData, mimetype, fileSizeBytes);
  logger.info({ filesize: media.filesize }, "Uploading manual video to WhatsApp Status (HD)");
  await client.sendMessage("status@broadcast", media, STATUS_SEND_OPTIONS);
  logger.info("Manual video uploaded to Status");
  whatsappEvents.emit("status_uploaded", { source: "manual" });
}

export function initWhatsApp() {
  logger.info("Initializing WhatsApp client...");
  client.initialize().catch((err: unknown) => {
    logger.error({ err }, "Failed to initialize WhatsApp client");
  });
}
