import { describe, expect, it, vi } from "vitest";
import { ChannelAuditEmitter, type ChannelAuditEvent } from "./audit-emitter.js";

const event: ChannelAuditEvent = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  eventType: "channel.message.sent",
  entityType: "message",
  entityId: "22222222-2222-4222-8222-222222222222",
  metadata: { provider: "whatsapp_web_test" }
};

describe("ChannelAuditEmitter", () => {
  it("drains an in-flight bounded request before shutdown completes", async () => {
    let release!: (response: Response) => void;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );
    const emitter = new ChannelAuditEmitter({
      auditUrl: "http://audit.test",
      credential: "channel-audit-test-token",
      authorizationHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
      warn: vi.fn(),
      fetch: fetchImpl
    });

    emitter.emit(event);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    let stopped = false;
    const stopping = emitter.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    release(new Response(null, { status: 201 }));
    await stopping;
    expect(stopped).toBe(true);
  });

  it("rejects new audit work once shutdown starts", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
    const emitter = new ChannelAuditEmitter({
      auditUrl: "http://audit.test",
      credential: "channel-audit-test-token",
      authorizationHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
      warn: vi.fn(),
      fetch: fetchImpl
    });

    await emitter.stop();
    emitter.emit(event);
    await Promise.resolve();

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports an unsuccessful delivery without rejecting shutdown", async () => {
    const warn = vi.fn();
    const emitter = new ChannelAuditEmitter({
      auditUrl: "http://audit.test/",
      credential: "channel-audit-test-token",
      authorizationHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
      warn,
      fetch: vi.fn(async () => new Response(null, { status: 503 }))
    });

    emitter.emit(event);
    await emitter.stop();

    expect(warn).toHaveBeenCalledWith("channel.message.sent");
  });
});
