import type { PlatformRole as OperatorRole } from "@hyperion/platform-contracts";
import type { WhatsAppConnectionState } from "@hyperion/pulso-contracts";

export const WHATSAPP_PRIVATE_CHANNEL_NOTICE = "Canal privado de prueba — integración no oficial";

export function canViewWhatsAppIntegration(role: OperatorRole): boolean {
  return role === "admin" || role === "coordinator";
}

export function canManageWhatsAppIntegration(role: OperatorRole): boolean {
  return role === "admin";
}

export function whatsappStateLabel(state: WhatsAppConnectionState | string): string {
  const labels: Record<string, string> = {
    disconnected: "Desconectado",
    qr_pending: "QR pendiente",
    connecting: "Conectando",
    ready: "Conectado",
    degraded: "Degradado"
  };
  return labels[state] ?? state.replaceAll("_", " ");
}

export function whatsappStateTone(state: WhatsAppConnectionState | string): "green" | "red" | "amber" | "blue" {
  if (state === "ready") return "green";
  if (["connecting", "qr_pending", "degraded"].includes(state)) return "amber";
  return "blue";
}

export function isSafeQrDataUrl(value: string | null | undefined): boolean {
  return value == null || /^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(value);
}
