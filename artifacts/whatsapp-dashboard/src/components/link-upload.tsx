import { useState } from "react";
import { Link2, Loader2, Send, Download, RotateCw } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useToast } from "@/hooks/use-toast";

export function LinkUpload() {
  const [url, setUrl]               = useState("");
  const [shouldRotate, setShouldRotate] = useState(false);
  const [loading, setLoading]       = useState(false);
  const { toast } = useToast();

  const isTikTok = /tiktok\.com|tiktok\.link|vm\.tiktok|vt\.tiktok/i.test(url);

  const handleSubmit = async () => {
    const trimmed = url.trim();
    if (!trimmed || !trimmed.startsWith("http")) {
      toast({ title: "Invalid URL", description: "Please enter a valid video URL.", variant: "destructive" });
      return;
    }
    if (loading) return;

    setLoading(true);
    try {
      const res = await fetch("/api/whatsapp/post-link-to-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed, orientation: shouldRotate ? "vertical" : undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to process link");

      toast({
        title: "Posted to Status",
        description: shouldRotate
          ? "Video downloaded, rotated 90°, and uploaded to Status."
          : "Video downloaded and uploaded to your WhatsApp Status.",
      });
      setUrl("");
      setShouldRotate(false);
    } catch (err: any) {
      toast({ title: "Link Upload Failed", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
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
            placeholder="https://www.tiktok.com/@user/video/... or any direct video URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={loading}
            className="w-full px-4 py-3 pr-10 text-sm rounded-xl border border-border bg-secondary/30 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50 transition-all"
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          />
          {isTikTok && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-primary bg-primary/10 px-2 py-0.5 rounded-full">
              TikTok HD
            </span>
          )}
        </div>
        {isTikTok && (
          <p className="text-xs text-primary/80 flex items-center gap-1.5">
            <Download className="w-3.5 h-3.5" />
            TikTok detected — will download HD no-watermark version automatically
          </p>
        )}
      </div>

      {/* ── Rotate button ── */}
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
        🔄 Rotate Video (90°)
      </button>
      {shouldRotate && (
        <p className="text-xs text-primary/70 -mt-3">
          Video will be rotated 90° clockwise before posting
        </p>
      )}

      {/* ── Submit button ── */}
      <button
        onClick={handleSubmit}
        disabled={loading || !url.trim()}
        className="w-full flex items-center justify-center gap-2 py-3.5 px-6 rounded-xl font-semibold bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:shadow-primary/30 hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-50 disabled:pointer-events-none"
      >
        <AnimatePresence mode="wait">
          {loading ? (
            <motion.span
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-2"
            >
              <Loader2 className="w-5 h-5 animate-spin" />
              {isTikTok ? "Fetching TikTok HD Video..." : "Downloading Video..."}
            </motion.span>
          ) : (
            <motion.span
              key="idle"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-2"
            >
              <Send className="w-5 h-5" />
              {shouldRotate ? "Fetch, Rotate & Post to Status" : "Fetch & Post to Status"}
            </motion.span>
          )}
        </AnimatePresence>
      </button>
    </div>
  );
}
