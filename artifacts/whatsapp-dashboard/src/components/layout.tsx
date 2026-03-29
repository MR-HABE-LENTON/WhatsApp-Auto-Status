import { type ReactNode } from "react";
import { MessageCircle } from "lucide-react";

interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/80 backdrop-blur-xl">
        <div className="container mx-auto px-4 h-16 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/20 flex items-center justify-center border border-primary/30 shadow-lg shadow-primary/10">
            <MessageCircle className="w-6 h-6 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-display font-bold bg-gradient-to-br from-white to-white/60 bg-clip-text text-transparent">
              WhatsApp Automator
            </h1>
          </div>
        </div>
      </header>

      <main className="flex-1 container mx-auto px-4 py-8 max-w-6xl">
        {children}
      </main>
      
      <footer className="py-6 border-t border-border/40 text-center text-sm text-muted-foreground">
        <p>Built with ❤️ securely running on your local server.</p>
      </footer>
    </div>
  );
}
