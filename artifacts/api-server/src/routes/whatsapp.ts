import { Router, type IRouter, type Request, type Response } from "express";
import multer from "multer";
import path from "path";
import os from "os";
import fs from "fs";
import {
  getQrCode,
  getIsAuthenticated,
  getIsReady,
  uploadVideoToStatus,
  downloadTikTokHD,
  sendFilePathToStatus,
  requestPairingCode,
  whatsappEvents,
} from "../whatsapp/client.js";

const router: IRouter = Router();

// ─── Multer: disk storage ─────────────────────────────────────────────────────
// No fileSize limit — allow up to 200 MB (or more) just like WhatsApp GB.

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename:    (_req, file, cb) => {
      const ext  = path.extname(file.originalname) || ".mp4";
      const name = `wa_upload_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
      cb(null, name);
    },
  }),
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("video/")) {
      cb(null, true);
    } else {
      cb(new Error("Only video files are allowed"));
    }
  },
});

// ─── Status / QR ─────────────────────────────────────────────────────────────

router.get("/status", (_req: Request, res: Response) => {
  res.json({
    authenticated: getIsAuthenticated(),
    ready:         getIsReady(),
    hasQr:         getQrCode() !== null,
  });
});

router.get("/qr", (_req: Request, res: Response) => {
  const qr = getQrCode();
  if (!qr) {
    res.status(404).json({ error: "No QR code available" });
    return;
  }
  res.json({ qr });
});

// ─── Pairing Code ─────────────────────────────────────────────────────────────

router.post("/request-pairing-code", async (req: Request, res: Response) => {
  const { phoneNumber } = req.body as { phoneNumber?: string };

  if (!phoneNumber) {
    res.status(400).json({ error: "phoneNumber is required" });
    return;
  }

  try {
    const code = await requestPairingCode(phoneNumber);
    res.json({ code });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const lower = message.toLowerCase();
    // Rate-limit from WhatsApp server → 429
    const isRateLimit =
      lower.includes("rateoverlimit") ||
      lower.includes("rate-overlimit") ||
      lower.includes("rate_overlimit") ||
      lower.includes('"code":429') ||
      lower.includes("429");
    // Timeout or invalid-number errors are client problems → 400
    const isClientError =
      lower.startsWith("timeout") ||
      lower.includes("invalid phone");
    const status = isRateLimit ? 429 : isClientError ? 400 : 500;
    const userMessage = isRateLimit
      ? "WhatsApp has rate-limited this number. Please wait 15–30 minutes before requesting a new code."
      : message;
    res.status(status).json({ error: userMessage });
  }
});

// ─── Upload (file) ────────────────────────────────────────────────────────────

router.post(
  "/upload-status",
  upload.single("video"),
  async (req: Request, res: Response) => {
    const filePath = req.file?.path ?? null;
    try {
      if (!getIsReady()) {
        res.status(503).json({ error: "WhatsApp is not ready. Please authenticate first." });
        return;
      }

      if (!req.file || !filePath) {
        res.status(400).json({ error: "No video file provided" });
        return;
      }

      const shouldRotate = req.body?.shouldRotate === "true" || req.body?.shouldRotate === true;
      const mb = (req.file.size / 1024 / 1024).toFixed(2);

      await uploadVideoToStatus(filePath, req.file.size, shouldRotate);

      res.json({
        success: true,
        message: `Video uploaded to WhatsApp Status (${mb} MB)`,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ error: message });
    } finally {
      if (filePath) try { fs.unlinkSync(filePath); } catch {}
    }
  },
);

// ─── Link Upload (URL → download → optional orient → status) ─────────────────

router.post("/post-link-to-status", async (req: Request, res: Response) => {
  if (!getIsReady()) {
    res.status(503).json({ error: "WhatsApp is not ready. Please authenticate first." });
    return;
  }

  const { url, orientation } = req.body as {
    url?: string;
    orientation?: string | null;
  };

  if (!url) {
    res.status(400).json({ error: "url is required" });
    return;
  }

  // Convert legacy orientation field to the unified shouldRotate flag
  const shouldRotate = !!orientation;

  // Increase response timeout for large downloads (5 minutes)
  (res as any).setTimeout?.(300_000);

  let downloadedPath: string | null = null;
  try {
    downloadedPath = await downloadTikTokHD(url);
    await sendFilePathToStatus(downloadedPath, shouldRotate);
    res.json({ success: true, message: "Video downloaded and uploaded to WhatsApp Status" });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  } finally {
    if (downloadedPath) try { fs.unlinkSync(downloadedPath); } catch {}
  }
});

// ─── SSE events ───────────────────────────────────────────────────────────────

router.get("/events", (_req: Request, res: Response) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent("status", {
    authenticated: getIsAuthenticated(),
    ready:         getIsReady(),
    hasQr:         getQrCode() !== null,
    qr:            getQrCode(),
  });

  const onQr             = (qr: string)     => sendEvent("qr",             { qr });
  const onAuthenticated  = ()               => sendEvent("authenticated",   {});
  const onReady          = ()               => sendEvent("ready",           {});
  const onDisconnected   = (reason: string) => sendEvent("disconnected",    { reason });
  const onStatusUploaded = (data: unknown)  => sendEvent("status_uploaded", data);
  const onAuthFailure    = (msg: string)    => sendEvent("auth_failure",    { msg });
  const onPairingCode    = (data: unknown)  => sendEvent("pairing_code",    data);

  whatsappEvents.on("qr",             onQr);
  whatsappEvents.on("authenticated",  onAuthenticated);
  whatsappEvents.on("ready",          onReady);
  whatsappEvents.on("disconnected",   onDisconnected);
  whatsappEvents.on("status_uploaded", onStatusUploaded);
  whatsappEvents.on("auth_failure",   onAuthFailure);
  whatsappEvents.on("pairing_code",   onPairingCode);

  _req.on("close", () => {
    whatsappEvents.off("qr",             onQr);
    whatsappEvents.off("authenticated",  onAuthenticated);
    whatsappEvents.off("ready",          onReady);
    whatsappEvents.off("disconnected",   onDisconnected);
    whatsappEvents.off("status_uploaded", onStatusUploaded);
    whatsappEvents.off("auth_failure",   onAuthFailure);
    whatsappEvents.off("pairing_code",   onPairingCode);
  });
});

export default router;
