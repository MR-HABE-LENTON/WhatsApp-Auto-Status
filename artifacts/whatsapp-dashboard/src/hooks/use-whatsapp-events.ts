import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { getGetWhatsAppStatusQueryKey, getGetWhatsAppQrQueryKey } from "@workspace/api-client-react";
import type { WhatsAppStatus, WhatsAppQr } from "@workspace/api-client-react";

interface WhatsAppState extends WhatsAppStatus {
  qrCode: string | null;
}

export function useWhatsAppEvents() {
  const [state, setState] = useState<WhatsAppState>({
    authenticated: false,
    ready: false,
    hasQr: false,
    qrCode: null,
  });

  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    const es = new EventSource("/api/whatsapp/events");

    es.addEventListener("status", (e) => {
      try {
        const data = JSON.parse(e.data);
        setState((prev) => ({
          ...prev,
          authenticated: data.authenticated,
          ready: data.ready,
          hasQr: data.hasQr,
          qrCode: data.qr || prev.qrCode,
        }));
        queryClient.setQueryData(getGetWhatsAppStatusQueryKey(), {
          authenticated: data.authenticated,
          ready: data.ready,
          hasQr: data.hasQr,
        });
      } catch (err) {
        console.error("Failed to parse status event", err);
      }
    });

    es.addEventListener("qr", (e) => {
      try {
        const data = JSON.parse(e.data);
        setState((prev) => ({ ...prev, qrCode: data.qr, hasQr: true }));
        queryClient.setQueryData(getGetWhatsAppQrQueryKey(), { qr: data.qr });
      } catch (err) {
        console.error("Failed to parse qr event", err);
      }
    });

    es.addEventListener("authenticated", () => {
      setState((prev) => ({ ...prev, authenticated: true, hasQr: false, qrCode: null }));
      toast({
        title: "Authenticated!",
        description: "Successfully linked to WhatsApp.",
        variant: "default",
      });
    });

    es.addEventListener("ready", () => {
      setState((prev) => ({ ...prev, ready: true }));
      toast({
        title: "Client Ready",
        description: "WhatsApp client is connected and ready to automate.",
        variant: "default",
      });
    });

    es.addEventListener("disconnected", (e) => {
      try {
        const data = JSON.parse(e.data);
        setState({ authenticated: false, ready: false, hasQr: false, qrCode: null });
        toast({
          title: "Disconnected",
          description: `WhatsApp client disconnected: ${data.reason || "Unknown reason"}`,
          variant: "destructive",
        });
      } catch {}
    });

    es.addEventListener("auth_failure", () => {
      setState((prev) => ({ ...prev, authenticated: false }));
      toast({
        title: "Authentication Failed",
        description: "Please try scanning the QR code again.",
        variant: "destructive",
      });
    });

    es.addEventListener("status_uploaded", () => {
      toast({
        title: "Status Posted",
        description: "Video successfully uploaded to your WhatsApp Status!",
        variant: "default",
      });
    });

    es.addEventListener("pairing_code", (e) => {
      try {
        const data = JSON.parse(e.data);
        // The pairing code is handled directly in qr-scanner component via fetch,
        // but we also broadcast it here for any future listeners
        console.info("Pairing code via SSE:", data.code);
      } catch {}
    });

    es.onerror = () => {
      // EventSource auto-reconnects; suppress noise
    };

    return () => {
      es.close();
    };
  }, [queryClient, toast]);

  return state;
}
