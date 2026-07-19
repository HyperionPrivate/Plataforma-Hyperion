import { describe, expect, it, vi } from "vitest";
import { createPulsoDeliveryClient } from "./pulso-delivery-client.js";

const TENANT_ID = "20000000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "30000000-0000-4000-8000-000000000001";
const MESSAGE_ID = "40000000-0000-4000-8000-000000000001";

describe("PULSO delivery guard client", () => {
  it("sends the sensitive guard input only as strict JSON in an authenticated POST", async () => {
    const request = vi.fn(async () =>
      Response.json({
        data: { messageId: MESSAGE_ID, matches: true },
        meta: { generatedAt: "2026-07-18T12:00:00.000Z" }
      })
    );
    const client = createPulsoDeliveryClient({
      pulsoIrisUrl: "https://pulso.internal/",
      credential: "channel-secret",
      fetch: request
    });

    await expect(
      client.guardQueuedMessage(TENANT_ID, MESSAGE_ID, {
        conversationId: CONVERSATION_ID,
        body: "Dato clínico que no debe llegar al URL"
      })
    ).resolves.toBe(true);

    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      `https://pulso.internal/internal/v1/tenants/${TENANT_ID}/pulso-iris/messages/${MESSAGE_ID}/delivery-guard`
    );
    expect(url).not.toContain("?");
    expect(url).not.toContain("Dato");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      authorization: "Bearer channel-secret",
      "content-type": "application/json",
      "x-hyperion-caller": "whatsapp-channel-service"
    });
    expect(JSON.parse(String(init.body))).toEqual({
      conversationId: CONVERSATION_ID,
      body: "Dato clínico que no debe llegar al URL",
      expectedDeliveryStatus: "queued"
    });
  });

  it("fails closed without a credential or when PULSO rejects the guard", async () => {
    const missingCredentialRequest = vi.fn();
    const missingCredentialClient = createPulsoDeliveryClient({
      pulsoIrisUrl: "https://pulso.internal",
      credential: " ",
      fetch: missingCredentialRequest
    });
    await expect(
      missingCredentialClient.guardQueuedMessage(TENANT_ID, MESSAGE_ID, {
        conversationId: CONVERSATION_ID,
        body: "privado"
      })
    ).rejects.toThrow("CHANNEL_TO_PULSO_TOKEN is required");
    expect(missingCredentialRequest).not.toHaveBeenCalled();

    const rejectedClient = createPulsoDeliveryClient({
      pulsoIrisUrl: "https://pulso.internal",
      credential: "channel-secret",
      fetch: vi.fn(async () => new Response(null, { status: 403 }))
    });
    await expect(
      rejectedClient.guardQueuedMessage(TENANT_ID, MESSAGE_ID, {
        conversationId: CONVERSATION_ID,
        body: "privado"
      })
    ).rejects.toThrow("PULSO delivery guard failed with status 403");
  });
});
