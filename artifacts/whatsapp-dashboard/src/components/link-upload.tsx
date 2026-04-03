import { useState } from "react";
import { AlertCircle, CheckCircle2, Download, Link2, Loader2, RotateCw, Send } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

type Step = "idle" | "downloading" | "processing" | "done" | "error";

interface ErrorInfo {
  message: string;
  step?: string;
}

export function LinkUpload() {
  const [url, setUrl]               = useState("");
  const [shouldRotate, setShouldRotate] = useState(false);
  const [step, setStep]             = useState<Step>("idle");
  const [errorInfo, setErrorInfo]   = useState<ErrorInfo | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const isTikTok = /tiktok\.com|tiktok\.link|vm\.tiktok|vt\.tiktok/i.test(url);
  const loading  = step === "downloading" || step === "processing";

  const handleSubmit = async () => {
    const trimmed = url.trim();
    if (!trimmed || !trimmed.startsWith("http")) {
      setErrorInfo({ message: "Please enter a valid video URL starting with http(s)://", step: "Validation" });
      setStep("error");
      return;
    }
    if (loading) return;

    setStep("downloading");
    setErrorInfo(null);
    setSuccessMsg(null);

    try {
      const res = await fetch("/api/whatsapp/post-link-to-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed, orientation: shouldRotate ? "vertical" : undefined }),
      });

      const json = await res.json();

      if (!res.ok) {
        throw { message: json.error ?? "Failed to process link", step: json.step };
      }

      setStep("done");
      setSuccessMsg(json.message ?? "Video uploaded to your WhatsApp Status!");
      setUrl("");
      setShouldRotate(false);

      // Auto-reset after 6 seconds
      setTimeout(() => setStep("idle"), 6_000);
    } catch (err: any) {
      setErrorInfo({
        message: err.message ?? String(err),
        step: err.step ?? undefined,
      });
      setStep("error");
    }
  };

  return (
    <div className="flex flex-col gap-5">

      {/* ── URL input ── */}
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-foreground flex items-center gap-2">
          <Link2 className="w-4 h-4 text-primary" />
          Video URL
        </label>
        <div className="relative">
          <input
            type="url"
            placeholder="https://vt.tiktok.com/... or any direct video URL"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (step === "error") setStep("idle");
            }}
            disabled={loading}
            className="w-full px-4 py-3 pr-24 text-sm rounded-xl border border-border bg-secondary/30 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50 transition-all"
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          />
          {isTikTok && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-primary bg-primary/10 px-2 py-0.5 rounded-full whitespace-nowrap">
              TikTok HD
            </span>
          )}
        </div>
        {isTikTok && (
          <p className="text-xs text-primary/80 flex items-center gap-1.5">
            <Download className="w-3.5 h-3.5" />
            TikTok detected — HD no-watermark version will be downloaded automatically (short links like vt.tiktok.com are supported)
          </p>
        )}
      </div>

      {/* ── Rotate toggle ── */}
      <button
        type="button"
        onClick={() => setShouldRotate((r) => !r)}
        disabled={loading}
        className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium border transition-all
          ${shouldRotate
            ? "border-primary bg-primary/10 text-primary"
            : "border-border bg-secondary/30 text-muted-foreground hover:border-primary/40 hover:text-foreground"
          } disabled:opacity-50`}
      >
        <RotateCw className="w-4 h-4" />
        Rotate Video 90° (RStatus mode)
      </button>
      {shouldRotate && (
        <p className="text-xs text-primary/70 -mt-3">
          Video will be rotated 90° clockwise before posting — equivalent to sending <span className="font-mono">RStatus... &lt;url&gt;</span>
        </p>
      )}

      {/* ── Submit button ── */}
      <button
        onClick={handleSubmit}
        disabled={loading || !url.trim()}
        className="w-full flex items-center justify-center gap-2 py-3.5 px-6 rounded-xl font-semibold bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:shadow-primary/30 hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-50 disabled:pointer-events-none"
      >
        <AnimatePresence mode="wait">
          {step === "downloading" ? (
            <motion.span key="dl" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-2">
              <Loader2 className="w-5 h-5 animate-spin" />
              {isTikTok ? "Downloading TikTok HD Video..." : "Downloading Video..."}
            </motion.span>
          ) : step === "processing" ? (
            <motion.span key="proc" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-2">
              <Loader2 className="w-5 h-5 animate-spin" />
              Processing & Uploading...
            </motion.span>
          ) : (
            <motion.span key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-2">
              <Send className="w-5 h-5" />
              {shouldRotate ? "Download, Rotate & Post to Status" : "Download & Post to Status"}
            </motion.span>
          )}
        </AnimatePresence>
      </button>

      {/* ── Success message ── */}
      <AnimatePresence>
        {step === "done" && successMsg && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="flex items-start gap-3 p-4 rounded-xl bg-green-500/10 border border-green-500/30"
          >
            <CheckCircle2 className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-green-400">Uploaded Successfully</p>
              <p className="text-xs text-green-400/80 mt-0.5">{successMsg}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Error message ── */}
      <AnimatePresence>
        {step === "error" && errorInfo && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="flex flex-col gap-2 p-4 rounded-xl bg-destructive/10 border border-destructive/30"
          >
            <div className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0" />
              <p className="text-sm font-semibold text-destructive">Upload Failed</p>
            </div>
            {errorInfo.step && (
              <p className="text-xs text-destructive/70 font-medium">
                Failed at step: <span className="font-mono">{errorInfo.step}</span>
              </p>
            )}
            <p className="text-xs text-destructive/80 whitespace-pre-wrap font-mono bg-destructive/5 rounded-lg p-2 leading-relaxed">
              {errorInfo.message}
            </p>
            <button
              onClick={() => setStep("idle")}
              className="text-xs text-destructive/70 hover:text-destructive underline self-start"
            >
              Dismiss
            </button>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}
