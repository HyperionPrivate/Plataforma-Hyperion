import { describe, expect, it, vi } from "vitest";
import { createPulsoSofiaContextClient } from "./pulso-sofia-context-client.js";

const TENANT_ID = "20000000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "30000000-0000-4000-8000-000000000001";
const PATIENT_ID = "40000000-0000-4000-8000-000000000001";
const MESSAGE_ID = "50000000-0000-4000-8000-000000000001";
const META = { requestId: "request-1", generatedAt: "2026-07-18T12:00:00.000Z" };

describe("PULSO SOFIA context client", () => {
  it("uses authenticated strict POST requests and validates echoed identities", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          data: {
            found: true,
            tenantId: TENANT_ID,
            conversationId: CONVERSATION_ID,
            patientId: PATIENT_ID,
            conversationStatus: "active",
            message: { id: MESSAGE_ID, sender: "patient", body: "CONFIRMO" }
          },
          meta: META
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          data: {
            tenantId: TENANT_ID,
            conversationId: CONVERSATION_ID,
            patientId: PATIENT_ID,
            patientName: null,
            sofiaState: {},
            history: [{ sender: "patient", body: "CONFIRMO" }]
          },
          meta: META
        })
      );
    const client = createPulsoSofiaContextClient({
      pulsoIrisUrl: "https://pulso.internal/",
      credential: "sofia-secret",
      fetch: request
    });

    await expect(
      client.lookupInbound(TENANT_ID, {
        conversationId: CONVERSATION_ID,
        patientId: PATIENT_ID,
        messageId: MESSAGE_ID
      })
    ).resolves.toMatchObject({ found: true, message: { body: "CONFIRMO" } });
    await expect(
      client.loadConversation(TENANT_ID, { conversationId: CONVERSATION_ID, patientId: PATIENT_ID })
    ).resolves.toMatchObject({ patientName: null, history: [{ body: "CONFIRMO" }] });

    for (const [url, init] of request.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(url).not.toContain("?");
      expect(init).toMatchObject({
        method: "POST",
        redirect: "error",
        headers: {
          authorization: "Bearer sofia-secret",
          "content-type": "application/json",
          "x-hyperion-caller": "agent-service"
        }
      });
    }
    expect(JSON.parse(String((request.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      patientId: PATIENT_ID
    });
  });

  it("fails closed for missing credentials, rejected dependencies and malformed identities", async () => {
    expect(() => createPulsoSofiaContextClient({ pulsoIrisUrl: "https://pulso.internal", credential: " " })).toThrow(
      "SOFIA_TO_PULSO_TOKEN is required"
    );

    const rejected = createPulsoSofiaContextClient({
      pulsoIrisUrl: "https://pulso.internal",
      credential: "sofia-secret",
      fetch: vi.fn(async () => new Response(null, { status: 403 }))
    });
    await expect(
      rejected.lookupInbound(TENANT_ID, {
        conversationId: CONVERSATION_ID,
        patientId: PATIENT_ID,
        messageId: MESSAGE_ID
      })
    ).rejects.toThrow("PULSO SOFIA context read failed with status 403");

    const conflicting = createPulsoSofiaContextClient({
      pulsoIrisUrl: "https://pulso.internal",
      credential: "sofia-secret",
      fetch: vi.fn(async () =>
        Response.json({
          data: {
            found: true,
            tenantId: TENANT_ID,
            conversationId: "60000000-0000-4000-8000-000000000001",
            patientId: PATIENT_ID,
            conversationStatus: "active",
            message: { id: MESSAGE_ID, sender: "patient", body: "CONFIRMO" }
          },
          meta: META
        })
      )
    });
    await expect(
      conflicting.lookupInbound(TENANT_ID, {
        conversationId: CONVERSATION_ID,
        patientId: PATIENT_ID,
        messageId: MESSAGE_ID
      })
    ).rejects.toThrow("conflicting identity");

    const malformed = createPulsoSofiaContextClient({
      pulsoIrisUrl: "https://pulso.internal",
      credential: "sofia-secret",
      fetch: vi.fn(async () =>
        Response.json({
          data: { found: false, unexpected: true },
          meta: META
        })
      )
    });
    await expect(
      malformed.lookupInbound(TENANT_ID, {
        conversationId: CONVERSATION_ID,
        patientId: PATIENT_ID,
        messageId: MESSAGE_ID
      })
    ).rejects.toThrow();
  });
});
