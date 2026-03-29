import { Bot, MessageSquare, Reply, Settings2 } from "lucide-react";

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
          icon={<Settings2 className="w-5 h-5 text-blue-400" />}
          title="Monitored Sources"
          description="The bot only listens to messages sent by you (fromMe) or from the specific trusted number (+1 321 558 6703)."
        />
        
        <RuleItem 
          icon={<MessageSquare className="w-5 h-5 text-primary" />}
          title="Direct Video Trigger"
          description={
            <>
              If you or the trusted number send a video with the exact caption <strong className="text-foreground bg-secondary px-1.5 py-0.5 rounded text-xs">Status...</strong>, it is immediately posted to your Status.
            </>
          }
        />

        <RuleItem 
          icon={<Reply className="w-5 h-5 text-purple-400" />}
          title="Quote / Reply Trigger"
          description={
            <>
              If you reply to an existing video message and type <strong className="text-foreground bg-secondary px-1.5 py-0.5 rounded text-xs">Status...</strong>, the bot will download the quoted video and post it.
            </>
          }
        />
      </div>
    </div>
  );
}

function RuleItem({ icon, title, description }: { icon: React.ReactNode, title: string, description: React.ReactNode }) {
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
