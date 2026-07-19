import { describe, expect, it } from "vitest";
import {
  canManageWhatsAppIntegration,
  canViewWhatsAppIntegration,
  isSafeQrDataUrl,
  WHATSAPP_PRIVATE_CHANNEL_NOTICE,
  whatsappStateLabel,
  whatsappStateTone
} from "./whatsapp-model.js";

describe("whatsapp integration view model", () => {
  it("aplica RBAC estricto al estado y las acciones", () => {
    expect(WHATSAPP_PRIVATE_CHANNEL_NOTICE).toBe("Canal privado de prueba — integración no oficial");
    expect(canViewWhatsAppIntegration("admin")).toBe(true);
    expect(canViewWhatsAppIntegration("coordinator")).toBe(true);
    expect(canViewWhatsAppIntegration("advisor")).toBe(false);
    expect(canViewWhatsAppIntegration("auditor")).toBe(false);
    expect(canManageWhatsAppIntegration("admin")).toBe(true);
    expect(canManageWhatsAppIntegration("coordinator")).toBe(false);
  });

  it("trata ready como el estado conectado terminal", () => {
    expect(whatsappStateLabel("ready")).toBe("Conectado");
    expect(whatsappStateTone("ready")).toBe("green");
    expect(whatsappStateTone("qr_pending")).toBe("amber");
  });

  it("solo permite QR embebido como imagen", () => {
    expect(isSafeQrDataUrl("data:image/png;base64,abc")).toBe(true);
    expect(isSafeQrDataUrl("data:image/svg+xml,<svg/>")).toBe(false);
    expect(isSafeQrDataUrl("https://example.test/qr")).toBe(false);
    expect(isSafeQrDataUrl(null)).toBe(true);
  });
});
