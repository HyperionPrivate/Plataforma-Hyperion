import { describe, expect, it } from "vitest";
import {
  inferIntentFromPayload,
  intentIsStop,
  intentWantsWhatsapp,
  normalizeIntent,
  stageFromPostCallIntent
} from "./post-call.js";

describe("normalizeIntent", () => {
  it("maps aliases used by dialer and LIWA", () => {
    expect(normalizeIntent("interested")).toBe("interesado");
    expect(normalizeIntent("not_interested")).toBe("no_interes");
    expect(normalizeIntent("whatsapp_followup")).toBe("pedir_whatsapp");
    expect(normalizeIntent("answering_machine")).toBe("voicemail");
  });
});

describe("CONTINUE / STOP sets", () => {
  it("marks CONTINUE intents as wanting WhatsApp", () => {
    expect(intentWantsWhatsapp("interesado")).toBe(true);
    expect(intentWantsWhatsapp("pedir_whatsapp")).toBe(true);
    expect(intentWantsWhatsapp("reactivar")).toBe(true);
  });

  it("marks STOP intents as not wanting WhatsApp", () => {
    expect(intentWantsWhatsapp("no_interes")).toBe(false);
    expect(intentWantsWhatsapp("opt_out")).toBe(false);
    expect(intentIsStop("voicemail")).toBe(true);
    expect(intentIsStop("no_answer")).toBe(true);
  });
});

describe("inferIntentFromPayload", () => {
  it("prefers AMD voicemail labels", () => {
    expect(inferIntentFromPayload({ amd_label: "answering_machine", intent: "interesado" })).toBe("voicemail");
  });

  it("uses explicit disposition before transcript heuristics", () => {
    expect(
      inferIntentFromPayload({
        disposition: "no_interes",
        transcript_excerpt: "por favor envíeme el PDF de matrícula por whatsapp"
      })
    ).toBe("no_interes");
  });

  it("infers pedir_whatsapp from transcript WhatsApp request", () => {
    expect(
      inferIntentFromPayload({
        transcript_excerpt: "Sí, mándeme la orden de matrícula por WhatsApp por favor"
      })
    ).toBe("pedir_whatsapp");
  });

  it("infers interesado from continue summary phrases", () => {
    expect(
      inferIntentFromPayload({
        transcript_excerpt: "El asociado está interesado y quiere renovar el cupo preaprobado"
      })
    ).toBe("interesado");
  });

  it("infers no_interes from stop summary phrases", () => {
    expect(
      inferIntentFromPayload({
        transcript_excerpt: "Manifestó que no le interesa y colgó"
      })
    ).toBe("no_interes");
  });

  it("reads analysis data_collection_results when explicit intent is missing", () => {
    expect(
      inferIntentFromPayload({
        analysis: {
          data_collection_results: { intencion: "quiere_renovar" }
        }
      })
    ).toBe("quiere_renovar");
  });

  it("unwraps ElevenLabs data_collection { value } objects", () => {
    expect(
      inferIntentFromPayload({
        analysis: {
          data_collection_results: { intencion: { value: "pedir_whatsapp" } }
        }
      })
    ).toBe("pedir_whatsapp");
  });
});

describe("stageFromPostCallIntent", () => {
  it("routes CONTINUE to interesado with WhatsApp flag", () => {
    expect(stageFromPostCallIntent("pedir_whatsapp")).toEqual({
      stage: "interesado",
      tipification: "pedir_whatsapp",
      wantsWhatsapp: true
    });
  });

  it("routes hard STOP to no_interes", () => {
    expect(stageFromPostCallIntent("no_interes")).toMatchObject({
      stage: "no_interes",
      wantsWhatsapp: false
    });
  });

  it("keeps soft contact outcomes at contactado", () => {
    expect(stageFromPostCallIntent("no_answer")).toMatchObject({
      stage: "contactado",
      wantsWhatsapp: false
    });
  });
});
