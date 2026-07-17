import { describe, expect, it, vi } from "vitest";
import { createLegacyPulsoPositionResolver } from "./pulso-position-client.js";
import type { LegacyPulsoMessageEvent } from "./pulso-events.js";

const EVENT: LegacyPulsoMessageEvent = {
  id: "10000000-0000-4000-8000-000000000001",
  type: "pulso.message.received.v1",
  version: 1,
  occurredAt: "2026-07-13T16:30:00.000Z",
  tenantId: "20000000-0000-4000-8000-000000000001",
  payload: {
    inboundEventId: "30000000-0000-4000-8000-000000000001",
    threadBindingId: "40000000-0000-4000-8000-000000000001",
    patientId: "50000000-0000-4000-8000-000000000001",
    conversationId: "60000000-0000-4000-8000-000000000001",
    messageId: "70000000-0000-4000-8000-000000000001",
    occurredAt: "2026-07-13T16:30:00.000Z"
  }
};

describe("PULSO owner position lookup", () => {
  it("reuses the SOFIA to PULSO edge and validates both stream positions", async () => {
    const request = vi.fn<typeof fetch>(async () => jsonResponse(positionResponse()));
    const resolve = createLegacyPulsoPositionResolver({
      pulsoServiceUrl: "http://pulso:8088/",
      credential: "sofia-to-pulso-test-token",
      fetch: request
    });

    await expect(resolve(EVENT)).resolves.toEqual({
      streamId: EVENT.payload.conversationId,
      streamSequence: 4,
      sourceStreamId: EVENT.payload.threadBindingId,
      sourceStreamSequence: 9
    });
    const [url, init] = request.mock.calls[0]!;
    expect(String(url)).toContain(`/pulso-message/${EVENT.id}/stream-position`);
    expect(init?.headers).toMatchObject({
      authorization: "Bearer sofia-to-pulso-test-token",
      "x-hyperion-caller": "agent-service"
    });
  });

  it("rejects an unavailable lookup or an owner-position mismatch", async () => {
    const missing = createLegacyPulsoPositionResolver({
      pulsoServiceUrl: "http://pulso:8088",
      credential: "sofia-to-pulso-test-token",
      fetch: async () => new Response(null, { status: 503 })
    });
    const conflicting = createLegacyPulsoPositionResolver({
      pulsoServiceUrl: "http://pulso:8088",
      credential: "sofia-to-pulso-test-token",
      fetch: async () =>
        jsonResponse(
          positionResponse({
            streamId: "60000000-0000-4000-8000-000000000099"
          })
        )
    });
    const conflictingSource = createLegacyPulsoPositionResolver({
      pulsoServiceUrl: "http://pulso:8088",
      credential: "sofia-to-pulso-test-token",
      fetch: async () =>
        jsonResponse(
          positionResponse({
            sourceStreamId: "40000000-0000-4000-8000-000000000099"
          })
        )
    });

    await expect(missing(EVENT)).rejects.toThrow("status 503");
    await expect(conflicting(EVENT)).rejects.toThrow("conflicts");
    await expect(conflictingSource(EVENT)).rejects.toThrow("conflicts");
  });
});

function positionResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    data: {
      tenantId: EVENT.tenantId,
      eventId: EVENT.id,
      streamId: EVENT.payload.conversationId,
      streamSequence: 4,
      sourceStreamId: EVENT.payload.threadBindingId,
      sourceStreamSequence: 9,
      ...overrides
    },
    meta: { generatedAt: "2026-07-13T16:31:00.000Z" }
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
