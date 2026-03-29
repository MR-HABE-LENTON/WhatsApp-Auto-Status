import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";
import { UploadCloud, FileVideo, X, Loader2, Play } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useUploadVideoToStatus } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

export function VideoUpload() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const { toast } = useToast();
  
  const uploadMutation = useUploadVideoToStatus({
    mutation: {
      onSuccess: () => {
        setFile(null);
        setPreview(null);
        // Toast is handled by SSE event globally, but we can add one here too if we want immediate feedback
      },
      onError: (err) => {
        toast({
          title: "Upload Failed",
          description: err?.error?.error || "Could not upload the video.",
          variant: "destructive",
        });
      }
    }
  });

  const onDrop = useCallback((acceptedFiles: File[]) => {
    const selected = acceptedFiles[0];
    if (selected) {
      setFile(selected);
      const objectUrl = URL.createObjectURL(selected);
      setPreview(objectUrl);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive, isDragReject } = useDropzone({
    onDrop,
    accept: {
      'video/*': []
    },
    maxSize: 64 * 1024 * 1024, // 64MB
    maxFiles: 1,
    multiple: false
  });

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    setFile(null);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
  };

  const handleUpload = () => {
    if (!file) return;
    uploadMutation.mutate({ data: { video: file } });
  };

  return (
    <div className="flex flex-col gap-6">
      <div 
        {...getRootProps()} 
        className={`
          relative overflow-hidden group
          border-2 border-dashed rounded-2xl p-8 
          flex flex-col items-center justify-center text-center
          transition-all duration-300 cursor-pointer
          ${isDragActive ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-secondary/30'}
          ${isDragReject ? 'border-destructive bg-destructive/5' : ''}
          ${file ? 'border-primary/30 bg-secondary/20 p-4' : 'min-h-[240px]'}
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
              <div className="w-16 h-16 rounded-full bg-secondary flex items-center justify-center mb-4 group-hover:scale-110 transition-transform duration-300">
                <UploadCloud className={`w-8 h-8 ${isDragActive ? 'text-primary' : 'text-muted-foreground group-hover:text-primary'}`} />
              </div>
              <h4 className="text-lg font-display font-medium text-foreground mb-1">
                {isDragActive ? "Drop the video here..." : "Select a video to upload"}
              </h4>
              <p className="text-sm text-muted-foreground max-w-[260px]">
                Drag and drop your video file here, or click to browse. Max size 64MB.
              </p>
            </motion.div>
          ) : (
            <motion.div
              key="file"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="w-full flex items-center gap-4 text-left"
            >
              <div className="relative w-24 h-24 rounded-xl overflow-hidden bg-black flex-shrink-0 border border-border shadow-inner group/video">
                {preview ? (
                  <video src={preview} className="w-full h-full object-cover opacity-80" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <FileVideo className="w-8 h-8 text-muted-foreground" />
                  </div>
                )}
                <div className="absolute inset-0 flex items-center justify-center">
                  <Play className="w-6 h-6 text-white opacity-70 fill-white" />
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
                disabled={uploadMutation.isPending}
                className="p-2 rounded-full hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {file && (
          <motion.div
            initial={{ opacity: 0, height: 0, y: -10 }}
            animate={{ opacity: 1, height: "auto", y: 0 }}
            exit={{ opacity: 0, height: 0, y: -10 }}
          >
            <button
              onClick={handleUpload}
              disabled={uploadMutation.isPending}
              className="w-full flex items-center justify-center gap-2 py-3.5 px-6 rounded-xl font-semibold bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:shadow-primary/30 hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-50 disabled:pointer-events-none"
            >
              {uploadMutation.isPending ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Uploading to Status...
                </>
              ) : (
                <>
                  <UploadCloud className="w-5 h-5" />
                  Post to WhatsApp Status
                </>
              )}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
