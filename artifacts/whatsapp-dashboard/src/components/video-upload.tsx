import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";
import { UploadCloud, FileVideo, X, Loader2, Play, RotateCw } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useToast } from "@/hooks/use-toast";

export function VideoUpload() {
  const [file, setFile]               = useState<File | null>(null);
  const [preview, setPreview]         = useState<string | null>(null);
  const [shouldRotate, setShouldRotate] = useState(false);
  const [pending, setPending]         = useState(false);
  const { toast } = useToast();

  const onDrop = useCallback((acceptedFiles: File[]) => {
    const selected = acceptedFiles[0];
    if (selected) {
      setFile(selected);
      const objectUrl = URL.createObjectURL(selected);
      setPreview(objectUrl);
      setShouldRotate(false);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive, isDragReject } = useDropzone({
    onDrop,
    accept: { "video/*": [] },
    maxSize: 200 * 1024 * 1024, // 200 MB
    maxFiles: 1,
    multiple: false,
  });

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    setFile(null);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    setShouldRotate(false);
  };

  const handleUpload = async () => {
    if (!file || pending) return;
    setPending(true);

    try {
      const formData = new FormData();
      formData.append("video", file);
      if (shouldRotate) formData.append("shouldRotate", "true");

      const res = await fetch("/api/whatsapp/upload-status", {
        method: "POST",
        body: formData,
      });
      const json = await res.json();

      if (!res.ok) throw new Error(json.error ?? "Upload failed");

      toast({ title: "Uploading", description: "Video is being processed and posted to your Status." });
      setFile(null);
      if (preview) URL.revokeObjectURL(preview);
      setPreview(null);
      setShouldRotate(false);
    } catch (err: any) {
      toast({ title: "Upload Failed", description: err.message, variant: "destructive" });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {/* ── Dropzone ── */}
      <div
        {...getRootProps()}
        className={`
          relative overflow-hidden group
          border-2 border-dashed rounded-2xl p-8
          flex flex-col items-center justify-center text-center
          transition-all duration-300 cursor-pointer
          ${isDragActive ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-secondary/30"}
          ${isDragReject ? "border-destructive bg-destructive/5" : ""}
          ${file ? "border-primary/30 bg-secondary/20 p-4" : "min-h-[180px]"}
        `}
      >
        <input {...getInputProps()} />
        <AnimatePresence mode="wait">
          {!file ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="flex flex-col items-center pointer-events-none"
            >
              <div className="w-14 h-14 rounded-full bg-secondary flex items-center justify-center mb-4 group-hover:scale-110 transition-transform duration-300">
                <UploadCloud className={`w-7 h-7 ${isDragActive ? "text-primary" : "text-muted-foreground group-hover:text-primary"}`} />
              </div>
              <h4 className="text-base font-display font-medium text-foreground mb-1">
                {isDragActive ? "Drop the video here..." : "Select a video to upload"}
              </h4>
              <p className="text-sm text-muted-foreground max-w-[240px]">
                Drag & drop or click to browse. Up to 200 MB supported.
              </p>
            </motion.div>
          ) : (
            <motion.div
              key="file"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="w-full flex items-center gap-4 text-left"
            >
              <div className="relative w-20 h-20 rounded-xl overflow-hidden bg-black flex-shrink-0 border border-border shadow-inner">
                {preview ? (
                  <video src={preview} className="w-full h-full object-cover opacity-80" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <FileVideo className="w-7 h-7 text-muted-foreground" />
                  </div>
                )}
                <div className="absolute inset-0 flex items-center justify-center">
                  <Play className="w-5 h-5 text-white opacity-70 fill-white" />
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate" title={file.name}>
                  {file.name}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {(file.size / (1024 * 1024)).toFixed(2)} MB
                </p>
              </div>
              <button
                type="button"
                onClick={handleClear}
                disabled={pending}
                className="p-2 rounded-full hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ── Rotate button (only when file selected) ── */}
      <AnimatePresence>
        {file && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <button
              type="button"
              onClick={() => setShouldRotate((r) => !r)}
              disabled={pending}
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
              <p className="text-xs text-primary/70 mt-1.5">
                Video will be rotated 90° clockwise before posting
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Upload button ── */}
      <AnimatePresence>
        {file && (
          <motion.div
            initial={{ opacity: 0, height: 0, y: -10 }}
            animate={{ opacity: 1, height: "auto", y: 0 }}
            exit={{ opacity: 0, height: 0, y: -10 }}
          >
            <button
              onClick={handleUpload}
              disabled={pending}
              className="w-full flex items-center justify-center gap-2 py-3.5 px-6 rounded-xl font-semibold bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:shadow-primary/30 hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-50 disabled:pointer-events-none"
            >
              {pending ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  {shouldRotate ? "Rotating & Uploading..." : "Uploading to Status..."}
                </>
              ) : (
                <>
                  <UploadCloud className="w-5 h-5" />
                  {shouldRotate ? "Rotate & Post to Status" : "Post to WhatsApp Status"}
                </>
              )}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
