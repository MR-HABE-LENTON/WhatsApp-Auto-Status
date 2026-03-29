import { QRCodeSVG } from "qrcode.react";
import { motion } from "framer-motion";
import { Smartphone, RefreshCcw } from "lucide-react";

interface QrScannerProps {
  qrCode: string | null;
}

export function QrScanner({ qrCode }: QrScannerProps) {
  return (
    <div className="flex flex-col items-center py-6 text-center">
      <div className="mb-6 relative">
        <div className="absolute -inset-4 bg-primary/20 blur-3xl rounded-full opacity-50 animate-pulse" />
        
        <div className="relative p-4 bg-white rounded-2xl shadow-2xl shadow-black/50 border-4 border-secondary overflow-hidden">
          {qrCode ? (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.4 }}
            >
              <QRCodeSVG 
                value={qrCode} 
                size={220} 
                bgColor={"#ffffff"}
                fgColor={"#0B141A"}
                level={"L"}
                includeMargin={false}
              />
            </motion.div>
          ) : (
            <div className="w-[220px] h-[220px] flex flex-col items-center justify-center bg-gray-100/5 text-muted-foreground">
              <RefreshCcw className="w-8 h-8 animate-spin mb-4 text-primary/50" />
              <span className="text-sm font-medium">Generating QR...</span>
            </div>
          )}
        </div>
      </div>

      <h3 className="text-xl font-display font-semibold mb-2">Link your device</h3>
      <ol className="text-sm text-muted-foreground text-left flex flex-col gap-3 max-w-[280px]">
        <li className="flex gap-3">
          <span className="flex-shrink-0 flex items-center justify-center w-5 h-5 rounded-full bg-secondary text-foreground text-xs font-bold">1</span>
          <span>Open WhatsApp on your phone</span>
        </li>
        <li className="flex gap-3">
          <span className="flex-shrink-0 flex items-center justify-center w-5 h-5 rounded-full bg-secondary text-foreground text-xs font-bold">2</span>
          <span>Tap <strong>Menu</strong> or <strong>Settings</strong> and select <strong>Linked Devices</strong></span>
        </li>
        <li className="flex gap-3">
          <span className="flex-shrink-0 flex items-center justify-center w-5 h-5 rounded-full bg-secondary text-foreground text-xs font-bold">3</span>
          <span>Tap <strong>Link a Device</strong> and point your camera at the screen</span>
        </li>
      </ol>
    </div>
  );
}
