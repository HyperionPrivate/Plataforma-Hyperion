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
});

describe("resolveAgencyFromGeo", () => {
  it("does not invent BAQ when ciudad is Bucaramanga", () => {
    expect(resolveAgencyFromGeo({ ciudad: "Bucaramanga" })).toMatchObject({
      tag: "AG_BUCARAMANGA",
      code: "BGA"
    });
  });
});
