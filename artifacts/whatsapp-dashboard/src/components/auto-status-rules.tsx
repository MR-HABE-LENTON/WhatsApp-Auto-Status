import { Bot, Link2, MessageSquare, Reply, RotateCw, Video } from "lucide-react";

export function AutoStatusRules() {
  return (
    <div className="bg-card rounded-2xl p-6 border border-border shadow-xl shadow-black/20">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center">
          <Bot className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h2 className="text-lg font-display font-semibold">Auto-Status Rules</h2>
          <p className="text-sm text-muted-foreground">Running silently in the background</p>
        </div>
      </div>

      <div className="space-y-6">
        <RuleItem
          icon={<MessageSquare className="w-5 h-5 text-primary" />}
          title="Direct Video — Status..."
          description={
            <>
              Send a video with caption{" "}
              <Code>Status...</Code>
              {" "}and it posts immediately to your Status. Or reply to a quoted video with{" "}
              <Code>Status...</Code>.
            </>
          }
        />

        <RuleItem
          icon={<Video className="w-5 h-5 text-rose-400" />}
          title="TikTok / URL Link — Status..."
          description={
            <>
              Send{" "}
              <Code>Status... https://vt.tiktok.com/...</Code>
              {" "}(short or full URL) and the bot downloads the{" "}
              <strong className="text-foreground">HD no-watermark</strong> version and posts it.
              Auto-rotates landscape videos to portrait. Works with any TikTok link format.
            </>
          }
        />

        <RuleItem
          icon={<RotateCw className="w-5 h-5 text-amber-400" />}
          title="Force Rotate — RStatus..."
          description={
            <>
              Same as above but forces a <strong className="text-foreground">90° clockwise rotation</strong>.{" "}
              Works with attached video:{" "}
              <Code>RStatus...</Code>
              {" "}or with a URL:{" "}
              <Code>RStatus... https://vt.tiktok.com/...</Code>
            </>
          }
        />

        <RuleItem
          icon={<Reply className="w-5 h-5 text-purple-400" />}
          title="Quote / Reply"
          description={
            <>
              Reply to any video message with <Code>Status...</Code> or <Code>RStatus...</Code> to post that video to your Status
              (with optional rotation).
            </>
          }
        />

        <RuleItem
          icon={<Link2 className="w-5 h-5 text-blue-400" />}
          title="Trusted Sources"
          description="The bot only acts on messages sent by you (fromMe) or from the trusted number (+1 321 558 6703). All other messages are ignored."
        />

        <div className="mt-2 p-3 rounded-xl bg-secondary/30 border border-border/50">
          <p className="text-xs text-muted-foreground font-medium mb-2 uppercase tracking-wide">Quick Reference</p>
          <div className="space-y-1.5 text-xs font-mono">
            <div className="flex items-center gap-2">
              <span className="text-primary">Status...</span>
              <span className="text-muted-foreground">→ upload attached or quoted video</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-rose-400">Status... &lt;url&gt;</span>
              <span className="text-muted-foreground">→ download & upload HD TikTok</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-amber-400">RStatus...</span>
              <span className="text-muted-foreground">→ upload + rotate 90°</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-amber-400">RStatus... &lt;url&gt;</span>
              <span className="text-muted-foreground">→ download + rotate 90° + upload</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <strong className="text-foreground bg-secondary px-1.5 py-0.5 rounded text-xs font-mono">
      {children}
    </strong>
  );
}

function RuleItem({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
}) {
  return (
    <div className="flex gap-4">
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-secondary/50 border border-border flex items-center justify-center mt-0.5">
        {icon}
      </div>
      <div>
        <h4 className="text-sm font-semibold text-foreground mb-1">{title}</h4>
        <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
      </div>
    </div>
  );
}
