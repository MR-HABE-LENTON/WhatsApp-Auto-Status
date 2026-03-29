import { Router, type IRouter, type Request, type Response } from "express";
import multer from "multer";
import {
  getQrCode,
  getIsAuthenticated,
  getIsReady,
  uploadVideoToStatus,
  whatsappEvents,
} from "../whatsapp/client.js";

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 64 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("video/")) {
      cb(null, true);
    } else {
      cb(new Error("Only video files are allowed"));
    }
  },
});

router.get("/status", (_req: Request, res: Response) => {
  res.json({
    authenticated: getIsAuthenticated(),
    ready: getIsReady(),
    hasQr: getQrCode() !== null,
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

router.post(
  "/upload-status",
  upload.single("video"),
  async (req: Request, res: Response) => {
    try {
      if (!getIsReady()) {
        res.status(503).json({ error: "WhatsApp is not ready. Please authenticate first." });
        return;
      }

      if (!req.file) {
        res.status(400).json({ error: "No video file provided" });
        return;
      }

      const base64 = req.file.buffer.toString("base64");
      await uploadVideoToStatus(base64, req.file.mimetype, req.file.size);

      res.json({ success: true, message: "Video uploaded to WhatsApp Status" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ error: message });
    }
  }
);

router.get("/events", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent("status", {
    authenticated: getIsAuthenticated(),
    ready: getIsReady(),
    hasQr: getQrCode() !== null,
    qr: getQrCode(),
  });

  const onQr = (qr: string) => sendEvent("qr", { qr });
  const onAuthenticated = () => sendEvent("authenticated", {});
  const onReady = () => sendEvent("ready", {});
  const onDisconnected = (reason: string) => sendEvent("disconnected", { reason });
  const onStatusUploaded = (data: unknown) => sendEvent("status_uploaded", data);
  const onAuthFailure = (msg: string) => sendEvent("auth_failure", { msg });

  whatsappEvents.on("qr", onQr);
  whatsappEvents.on("authenticated", onAuthenticated);
  whatsappEvents.on("ready", onReady);
  whatsappEvents.on("disconnected", onDisconnected);
  whatsappEvents.on("status_uploaded", onStatusUploaded);
  whatsappEvents.on("auth_failure", onAuthFailure);

  _req.on("close", () => {
    whatsappEvents.off("qr", onQr);
    whatsappEvents.off("authenticated", onAuthenticated);
    whatsappEvents.off("ready", onReady);
    whatsappEvents.off("disconnected", onDisconnected);
    whatsappEvents.off("status_uploaded", onStatusUploaded);
    whatsappEvents.off("auth_failure", onAuthFailure);
  });
});

export default router;
