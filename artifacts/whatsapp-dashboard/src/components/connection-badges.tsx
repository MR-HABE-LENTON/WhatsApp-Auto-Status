import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

interface ConnectionBadgesProps {
  authenticated: boolean;
  ready: boolean;
}

export function ConnectionBadges({ authenticated, ready }: ConnectionBadgesProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between p-4 rounded-xl bg-secondary/50 border border-border/50">
        <div className="flex flex-col">
          <span className="text-sm font-medium text-foreground">Authentication</span>
          <span className="text-xs text-muted-foreground">Linked device status</span>
        </div>
        <Badge active={authenticated} />
      </div>
      
      <div className="flex items-center justify-between p-4 rounded-xl bg-secondary/50 border border-border/50">
        <div className="flex flex-col">
          <span className="text-sm font-medium text-foreground">Client Ready</span>
          <span className="text-xs text-muted-foreground">Network connection</span>
        </div>
        <Badge active={ready} loading={authenticated && !ready} />
      </div>
    </div>
  );
}

function Badge({ active, loading }: { active: boolean; loading?: boolean }) {
  return (
    <motion.div
      initial={{ scale: 0.9, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors duration-500",
        active 
          ? "bg-primary/10 text-primary border-primary/20 shadow-[0_0_15px_rgba(0,168,132,0.15)]" 
          : loading
            ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
            : "bg-destructive/10 text-destructive border-destructive/20"
      )}
    >
      {active ? (
        <>
          <CheckCircle2 className="w-4 h-4" />
          Connected
        </>
      ) : loading ? (
        <>
          <Loader2 className="w-4 h-4 animate-spin" />
          Initializing
        </>
      ) : (
        <>
          <XCircle className="w-4 h-4" />
          Not Connected
        </>
      )}
    </motion.div>
  );
}
