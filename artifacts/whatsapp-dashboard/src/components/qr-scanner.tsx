import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { motion, AnimatePresence } from "framer-motion";
import { RefreshCcw, Smartphone, Loader2, Copy, Check, Phone } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface QrScannerProps {
  qrCode: string | null;
}

export function QrScanner({ qrCode }: QrScannerProps) {
  const [phone, setPhone]             = useState("");
  const [loading, setLoading]         = useState(false);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [copied, setCopied]           = useState(false);
  const { toast } = useToast();

  const handleGetCode = async () => {
    const digits = phone.replace(/\D/g, "");
    if (!digits || digits.length < 7) {
      toast({ title: "Invalid number", description: "Please enter a valid phone number with country code.", variant: "destructive" });
      return;
    }

    setLoading(true);
    setPairingCode(null);
    try {
      const res = await fetch("/api/whatsapp/request-pairing-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: digits }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to get pairing code");
      const raw: string = json.code ?? "";
      // Format as XXXX-XXXX if 8 chars
      const formatted = raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
      setPairingCode(formatted);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    if (!pairingCode) return;
    navigator.clipboard.writeText(pairingCode.replace("-", ""));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col gap-8">
      {/* ── QR Code section ── */}
      <div className="flex flex-col items-center py-4 text-center">
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
                  size={200}
                  bgColor={"#ffffff"}
                  fgColor={"#0B141A"}
                  level={"L"}
                  includeMargin={false}
                />
              </motion.div>
            ) : (
              <div className="w-[200px] h-[200px] flex flex-col items-center justify-center bg-gray-100/5 text-muted-foreground">
                <RefreshCcw className="w-8 h-8 animate-spin mb-4 text-primary/50" />
                <span className="text-sm font-medium">Generating QR...</span>
              </div>
            )}
          </div>
        </div>

        <h3 className="text-lg font-display font-semibold mb-2">Scan QR Code</h3>
        <ol className="text-sm text-muted-foreground text-left flex flex-col gap-2 max-w-[260px]">
          <li className="flex gap-3">
            <span className="flex-shrink-0 flex items-center justify-center w-5 h-5 rounded-full bg-secondary text-foreground text-xs font-bold">1</span>
            <span>Open WhatsApp on your phone</span>
          </li>
          <li className="flex gap-3">
            <span className="flex-shrink-0 flex items-center justify-center w-5 h-5 rounded-full bg-secondary text-foreground text-xs font-bold">2</span>
            <span>Tap <strong>Settings</strong> → <strong>Linked Devices</strong></span>
          </li>
          <li className="flex gap-3">
            <span className="flex-shrink-0 flex items-center justify-center w-5 h-5 rounded-full bg-secondary text-foreground text-xs font-bold">3</span>
            <span>Tap <strong>Link a Device</strong> and scan</span>
          </li>
        </ol>
      </div>

      {/* ── Divider ── */}
      <div className="flex items-center gap-3">
        <div className="flex-1 h-px bg-border" />
        <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">or link with phone number</span>
        <div className="flex-1 h-px bg-border" />
      </div>

      {/* ── Pairing Code section ── */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2 mb-1">
          <Phone className="w-4 h-4 text-primary" />
          <h3 className="text-base font-display font-semibold">Link via Phone Number</h3>
        </div>

        <div className="flex gap-2">
          <input
            type="tel"
            placeholder="+966xxxxxxxxx"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            disabled={loading}
            className="flex-1 px-3 py-2.5 text-sm rounded-xl border border-border bg-secondary/30 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
          />
          <button
            onClick={handleGetCode}
            disabled={loading || !phone}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap shadow-lg shadow-primary/20"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Smartphone className="w-4 h-4" />
                Get Code
              </>
            )}
          </button>
        </div>

        <AnimatePresence>
          {pairingCode && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              className="rounded-xl border border-primary/30 bg-primary/5 p-4 flex flex-col gap-3"
            >
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Your Pairing Code</p>
              <div className="flex items-center gap-3">
                <span className="text-4xl font-mono font-bold tracking-[0.3em] text-foreground">
                  {pairingCode}
                </span>
                <button
                  onClick={handleCopy}
                  className="p-2 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
                  title="Copy code"
                >
                  {copied ? <Check className="w-5 h-5 text-green-400" /> : <Copy className="w-5 h-5" />}
                </button>
              </div>

              <ol className="text-xs text-muted-foreground flex flex-col gap-1.5 mt-1 border-t border-border pt-3">
                <li className="flex gap-2">
                  <span className="font-bold text-primary">1.</span>
                  Open WhatsApp on your phone.
                </li>
                <li className="flex gap-2">
                  <span className="font-bold text-primary">2.</span>
                  Go to <strong className="text-foreground">Settings → Linked Devices</strong>.
                </li>
                <li className="flex gap-2">
                  <span className="font-bold text-primary">3.</span>
                  Tap <strong className="text-foreground">"Link a Device"</strong>, then choose <strong className="text-foreground">"Link with phone number instead"</strong>.
                </li>
                <li className="flex gap-2">
                  <span className="font-bold text-primary">4.</span>
                  Enter the 8-character code shown above.
                </li>
              </ol>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
