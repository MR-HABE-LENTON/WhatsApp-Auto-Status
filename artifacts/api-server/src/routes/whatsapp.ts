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
  whatsappEvents,
} from "../whatsapp/client.js";

const router: IRouter = Router();

// ─── Multer: disk storage ─────────────────────────────────────────────────────
// Store uploads on disk rather than in memory so files >100 MB don't OOM the
// process.  fs.readFileSync is used downstream (in uploadVideoToStatus) to load
// the raw Buffer — matching the "Raw Media Object" pattern.
//
// No fileSize limit is set — WhatsApp GB supports files well above 100 MB and
// we want to replicate that behaviour.  The OS/disk is the only practical cap.

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename:    (_req, file, cb) => {
      const ext  = path.extname(file.originalname) || ".mp4";
      const name = `wa_upload_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
      cb(null, name);
    },
  }),
  // No fileSize limit — allow large files (>100 MB) just like WhatsApp GB
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

// ─── Upload ───────────────────────────────────────────────────────────────────

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

      const mb = (req.file.size / 1024 / 1024).toFixed(2);
      // Pass the on-disk path and exact byte count.
      // uploadVideoToStatus reads the file with fs.readFileSync internally.
      await uploadVideoToStatus(filePath, req.file.size);

      res.json({
        success: true,
        message: `Video uploaded to WhatsApp Status (${mb} MB)`,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ error: message });
    } finally {
      // Clean up the temp upload file whether the upload succeeded or failed
      if (filePath) try { fs.unlinkSync(filePath); } catch {}
    }
  },
);

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

  whatsappEvents.on("qr",             onQr);
  whatsappEvents.on("authenticated",  onAuthenticated);
  whatsappEvents.on("ready",          onReady);
  whatsappEvents.on("disconnected",   onDisconnected);
  whatsappEvents.on("status_uploaded", onStatusUploaded);
  whatsappEvents.on("auth_failure",   onAuthFailure);

  _req.on("close", () => {
    whatsappEvents.off("qr",             onQr);
    whatsappEvents.off("authenticated",  onAuthenticated);
    whatsappEvents.off("ready",          onReady);
    whatsappEvents.off("disconnected",   onDisconnected);
    whatsappEvents.off("status_uploaded", onStatusUploaded);
    whatsappEvents.off("auth_failure",   onAuthFailure);
  });
});

export default router;
