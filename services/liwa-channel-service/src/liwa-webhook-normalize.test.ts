import { describe, expect, it } from "vitest";
import {
  mapEventKind,
  normalizeLiwaPayload,
  normalizePhoneE164,
  resolveAgencyFromGeo
} from "./liwa-webhook-normalize.js";

describe("normalizePhoneE164", () => {
  it("normalizes Colombian mobiles", () => {
    expect(normalizePhoneE164("3001234567")).toBe("+573001234567");
    expect(normalizePhoneE164("+573001234567")).toBe("+573001234567");
  });
});

describe("normalizeLiwaPayload", () => {
  it("maps aliases and phone from runbook shape", () => {
    const parsed = normalizeLiwaPayload({
      event: "documento",
      phone: "+573002555948",
      external_id: "t1",
      ciudad: "Bucaramanga",
      filename: "orden.pdf"
    });
    expect(parsed.event).toBe("document_received");
    expect(parsed.phone).toBe("+573002555948");
    expect(parsed.agencyTag).toBe("AG_BUCARAMANGA");
    expect(parsed.agencyCode).toBe("BGA");
  });

  it("maps asesor alias to handoff", () => {
    const parsed = normalizeLiwaPayload({
      event: "asesor",
      telefono: "3002555948",
      ciudad: "Barranquilla"
    });
    expect(mapEventKind(parsed.event)).toBe("handoff_requested");
    expect(parsed.agencyTag).toBe("AG_BARRANQUILLA");
    expect(parsed.agencyCode).toBe("BAQ");
  });

  it("maps WhatsApp-style from as phone for chat mirror", () => {
    const parsed = normalizeLiwaPayload({
      event: "message",
      from: "573001112233",
      text: "Hola espejo"
    });
    expect(mapEventKind(parsed.event)).toBe("message");
    expect(parsed.phone).toBe("+573001112233");
    expect(parsed.text).toBe("Hola espejo");
  });

  it("maps bot_message for outbound chat mirror", () => {
    const parsed = normalizeLiwaPayload({
      event: "bot_message",
      phone: "+573001112233",
      text: "Hola, soy el asistente"
    });
    expect(mapEventKind(parsed.event)).toBe("bot_message");
    expect(parsed.text).toBe("Hola, soy el asistente");
  });

  it("maps tipificacion", () => {
    const parsed = normalizeLiwaPayload({
      event: "tipify",
      phone: "+573001112233",
      tipificacion: "interesado_wa",
      ciudad: "Cucuta"
    });
    expect(mapEventKind(parsed.event)).toBe("tipificacion");
    expect(parsed.tipificacion).toBe("interesado_wa");
  });

  it("maps LIWA Tools tag-applied payload (user + tag, no event)", () => {
    const parsed = normalizeLiwaPayload({
      tag: { id: "906422", name: "RENOVACION_VIP" },
      user: {
        id: "573002555948",
        phone: "+573002555948",
        first_name: "Prueba",
        page_id: "1656233",
        account_id: "1656233",
        subscribed: "1"
      }
    });
    expect(mapEventKind(parsed.event)).toBe("tipificacion");
    expect(parsed.phone).toBe("+573002555948");
    expect(parsed.contactId).toBe("573002555948");
    expect(parsed.tipificacion).toBe("renovacion_vip");
    expect(parsed.name).toBe("Prueba");
  });
});

describe("resolveAgencyFromGeo", () => {
  it("does not invent BAQ when ciudad is Bucaramanga", () => {
    expect(resolveAgencyFromGeo({ ciudad: "Bucaramanga" })).toMatchObject({
      tag: "AG_BUCARAMANGA",
      code: "BGA"
    });
  });
});
