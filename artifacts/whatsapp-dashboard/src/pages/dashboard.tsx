import { Layout } from "@/components/layout";
import { ConnectionBadges } from "@/components/connection-badges";
import { QrScanner } from "@/components/qr-scanner";
import { VideoUpload } from "@/components/video-upload";
import { LinkUpload } from "@/components/link-upload";
import { AutoStatusRules } from "@/components/auto-status-rules";
import { useWhatsAppEvents } from "@/hooks/use-whatsapp-events";
import { motion, AnimatePresence } from "framer-motion";

export default function Dashboard() {
  const { authenticated, ready, qrCode } = useWhatsAppEvents();

  return (
    <Layout>
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">

        {/* Left Column: Status & Interactions */}
        <div className="lg:col-span-7 flex flex-col gap-6">
          <div className="bg-card rounded-2xl p-6 border border-border shadow-xl shadow-black/20">
            <h2 className="text-lg font-display font-semibold mb-4">Connection Overview</h2>
            <ConnectionBadges authenticated={authenticated} ready={ready} />
          </div>

          <AnimatePresence mode="wait">
            {!ready ? (
              <motion.div
                key="qr"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                transition={{ duration: 0.4 }}
                className="bg-card rounded-2xl p-6 border border-border shadow-xl shadow-black/20"
              >
                <QrScanner qrCode={qrCode} />
              </motion.div>
            ) : (
              <motion.div
                key="upload"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                transition={{ duration: 0.4 }}
                className="flex flex-col gap-6"
              >
                {/* File Upload */}
                <div className="bg-card rounded-2xl p-6 border border-border shadow-xl shadow-black/20">
                  <div className="mb-5">
                    <h2 className="text-lg font-display font-semibold text-foreground">Manual Status Upload</h2>
                    <p className="text-sm text-muted-foreground mt-1">
                      Directly push a video to your WhatsApp Status. Up to 200 MB with optional orientation conversion.
                    </p>
                  </div>
                  <VideoUpload />
                </div>

                {/* Link Upload */}
                <div className="bg-card rounded-2xl p-6 border border-border shadow-xl shadow-black/20">
                  <div className="mb-5">
                    <h2 className="text-lg font-display font-semibold text-foreground">Link Upload</h2>
                    <p className="text-sm text-muted-foreground mt-1">
                      Paste a TikTok or direct video URL. The server downloads the HD no-watermark version and posts it to your Status.
                    </p>
                  </div>
                  <LinkUpload />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Right Column: Info & Rules */}
        <div className="lg:col-span-5 flex flex-col gap-6">
          <AutoStatusRules />
        </div>

      </div>
    </Layout>
  );
}
