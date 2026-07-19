import { ApiError } from "./api.js";

const exactMessages: Record<string, string> = {
  "Clinical transcription provider is not configured": "El proveedor de transcripción clínica no está configurado.",
  "Clinical structuring provider is not configured": "El proveedor de estructuración clínica no está configurado."
};

export function lumenErrorMessage(error: unknown): string {
  const message = error instanceof ApiError || error instanceof Error ? error.message : "";
  if (exactMessages[message]) return exactMessages[message];
  if (message.startsWith("OpenAI STT request failed")) {
    return "El proveedor de transcripción no respondió. Intenta nuevamente con un audio corto.";
  }
  if (message.startsWith("DeepSeek request failed")) {
    return "El proveedor de estructuración no respondió. Conserva el transcript e intenta nuevamente.";
  }
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "El navegador no permitió usar el micrófono. Habilita el permiso o carga un audio corto.";
  }
  return message || "No fue posible completar la operación.";
}
