import { describe, expect, it, vi } from "vitest";
import type {
  ChannelRepository,
  ClaimedInboundEvent,
  ClaimedOutboundMessage,
  EnqueueOutboundInput,
  EnqueueOutboundResult,
  PersistInboundResult
} from "./channel-repository.js";
import { WhatsAppChannelService } from "./channel-service.js";
import {
  WHATSAPP_PROVIDER_MODE,
  WhatsAppProviderNotReadyError,
  type WhatsAppConnectionStatus,
  type WhatsAppDeliveryUpdate,
  type WhatsAppInboundText,
  type WhatsAppOutboundText,
  type WhatsAppProvider
} from "./types.js";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";

describe("WhatsAppChannelService", () => {
  it("drains an active outbound iteration, stops admission, and closes the provider once", async () => {
    const repository = new MemoryRepository();
    const provider = new FakeProvider();
    const claimed = deferred<ClaimedOutboundMessage | undefined>();
    const claimOutbound = vi.spyOn(repository, "claimOutbound").mockReturnValue(claimed.promise);
    const close = vi.spyOn(provider, "close");
    const service = new WhatsAppChannelService(provider, repository, 60_000);

    const drain = service.drainOutbound();
    expect(claimOutbound).toHaveBeenCalledTimes(1);
    const firstStop = service.stop();
    expect(service.stop()).toBe(firstStop);
    let stopped = false;
    void firstStop.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);

    claimed.resolve(outboundMessage("drained-before-close"));
    await Promise.all([drain, firstStop]);

    expect(repository.sent).toEqual(["drained-before-close"]);
    expect(claimOutbound).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    await service.drainOutbound();
    expect(claimOutbound).toHaveBeenCalledTimes(1);
  });

  it("waits for an active session restore before closing the provider", async () => {
    const repository = new MemoryRepository();
    const provider = new FakeProvider();
    const restorableTenants = deferred<string[]>();
    const restored = deferred<void>();
    vi.spyOn(repository, "listRestorableTenantIds").mockReturnValue(restorableTenants.promise);
    const restore = vi.spyOn(provider, "restore").mockReturnValue(restored.promise);
    const close = vi.spyOn(provider, "close");
    const service = new WhatsAppChannelService(provider, repository, 60_000);

    const start = service.start();
    const stop = service.stop();
    expect(service.stop()).toBe(stop);
    expect(close).toHaveBeenCalledTimes(1);

    restorableTenants.resolve([TENANT_ID]);
    await Promise.resolve();
    expect(restore).toHaveBeenCalledWith([TENANT_ID]);
    expect(close).toHaveBeenCalledTimes(1);

    restored.resolve();
    await Promise.all([start, stop]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("bounds a provider send that does not settle during shutdown", async () => {
    vi.useFakeTimers();
    try {
      const repository = new MemoryRepository();
      const provider = new FakeProvider();
      repository.claimedOutbound.push(outboundMessage("hung-provider-send"));
      provider.sendText = vi.fn(() => new Promise<{ providerMessageId: string; sentAt: Date }>(() => undefined));
      const service = new WhatsAppChannelService(provider, repository, 60_000, undefined, 5_000, 25);

      const drain = service.drainOutbound();
      await vi.waitFor(() => expect(provider.sendText).toHaveBeenCalledTimes(1));
      const stopping = service.stop();
      await vi.advanceTimersByTimeAsync(25);
      await Promise.all([drain, stopping]);

      expect(repository.uncertain).toEqual(["hung-provider-send"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for provider-triggered database projections before completing stop", async () => {
    const repository = new MemoryRepository();
    const provider = new FakeProvider();
    const persisted = deferred<PersistInboundResult>();
    vi.spyOn(repository, "persistInbound").mockReturnValue(persisted.promise);
    const close = vi.spyOn(provider, "close");
    const service = new WhatsAppChannelService(provider, repository, 60_000);
    await service.start();

    const receiving = provider.receive(inboundMessage());
    const stopping = service.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await Promise.resolve();

    expect(close).toHaveBeenCalledTimes(1);
    expect(stopped).toBe(false);

    persisted.resolve({
      eventId: "inbound-projection",
      threadBindingId: "00000000-0000-4000-8000-000000000002",
      inserted: true
    });
    await Promise.all([receiving, stopping]);
    expect(stopped).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("deduplicates inbound provider redelivery through the durable repository", async () => {
    const repository = new MemoryRepository();
    const provider = new FakeProvider();
    const service = new WhatsAppChannelService(provider, repository, 60_000);
    await service.start();
    const inbound = inboundMessage();

    await provider.receive(inbound);
    await provider.receive(inbound);

    expect(repository.inboundEvents).toHaveLength(1);
    await service.stop();
  });

  it("keeps outbound enqueue idempotent", async () => {
    const repository = new MemoryRepository();
    const service = new WhatsAppChannelService(new FakeProvider(), repository, 60_000);
    const input: EnqueueOutboundInput = {
      tenantId: TENANT_ID,
      threadBindingId: "00000000-0000-4000-8000-000000000002",
      messageId: "00000000-0000-4000-8000-000000000003",
      body: "response",
      idempotencyKey: "outbound-key-1"
    };

    expect(await service.enqueueOutbound(input)).toMatchObject({ inserted: true });
    expect(await service.enqueueOutbound(input)).toMatchObject({ inserted: false });
  });

  it("retries only known pre-send failures and reconciles an uncertain provider outcome", async () => {
    const repository = new MemoryRepository();
    const provider = new FakeProvider();
    const service = new WhatsAppChannelService(provider, repository, 60_000);
    repository.claimedOutbound.push(outboundMessage("ok"), outboundMessage("retry"), outboundMessage("uncertain"));
    provider.sendText = vi
      .fn()
      .mockResolvedValueOnce({ providerMessageId: "provider-1", sentAt: new Date() })
      .mockRejectedValueOnce(new WhatsAppProviderNotReadyError())
      .mockRejectedValueOnce(new Error("transport details must not persist"));

    await service.drainOutbound();

    expect(repository.sent).toEqual(["ok"]);
    expect(repository.failed).toEqual([{ id: "retry", code: "provider_not_ready" }]);
    expect(repository.uncertain).toEqual(["uncertain"]);
  });

  it("retries session restoration after a transient repository failure", async () => {
    vi.useFakeTimers();
    const repository = new MemoryRepository();
    const provider = new FakeProvider();
    const runtimeError = vi.fn();
    repository.restoreFailures = 1;
    const service = new WhatsAppChannelService(provider, repository, 60_000, runtimeError, 25);

    await service.start();
    expect(provider.restoreCalls).toBe(0);
    expect(runtimeError).toHaveBeenCalledWith("session_restore_deferred");

    await vi.advanceTimersByTimeAsync(25);
    expect(provider.restoreCalls).toBe(1);
    await service.stop();
    vi.useRealTimers();
  });

  it("preserves the provider acknowledgement when the sent transition lost its lease", async () => {
    const repository = new MemoryRepository();
    const provider = new FakeProvider();
    const service = new WhatsAppChannelService(provider, repository, 60_000);
    repository.claimedOutbound.push(outboundMessage("lease-lost"));
    repository.acceptSentTransition = false;
    provider.sendText = vi.fn(async () => ({ providerMessageId: "provider-evidence", sentAt: new Date() }));

    await service.drainOutbound();

    expect(repository.sent).toEqual([]);
    expect(repository.uncertainEvidence).toEqual([{ id: "lease-lost", providerMessageId: "provider-evidence" }]);
  });

  it("does not invoke the provider unless the sending phase is durable", async () => {
    const repository = new MemoryRepository();
    const provider = new FakeProvider();
    const service = new WhatsAppChannelService(provider, repository, 60_000);
    repository.claimedOutbound.push(outboundMessage("not-dispatched"));
    repository.acceptSendingTransition = false;
    provider.sendText = vi.fn();

    await service.drainOutbound();

    expect(provider.sendText).not.toHaveBeenCalled();
    expect(repository.uncertain).toEqual([]);
  });
});

class FakeProvider implements WhatsAppProvider {
  readonly mode = WHATSAPP_PROVIDER_MODE;
  private inbound: (message: WhatsAppInboundText) => Promise<void> = async () => undefined;
  private statusHandler: (tenantId: string, status: WhatsAppConnectionStatus) => Promise<void> = async () => undefined;
  private delivery: (update: WhatsAppDeliveryUpdate) => Promise<boolean> = async () => true;
  restoreCalls = 0;

  setInboundHandler(handler: (message: WhatsAppInboundText) => Promise<void>): void {
    this.inbound = handler;
  }
  setStatusHandler(handler: (tenantId: string, status: WhatsAppConnectionStatus) => Promise<void>): void {
    this.statusHandler = handler;
  }
  setDeliveryHandler(handler: (update: WhatsAppDeliveryUpdate) => Promise<boolean>): void {
    this.delivery = handler;
  }
  async connect(): Promise<WhatsAppConnectionStatus> {
    return this.status();
  }
  async restore(): Promise<void> {
    this.restoreCalls += 1;
    return undefined;
  }
  status(): WhatsAppConnectionStatus {
    return {
      providerMode: WHATSAPP_PROVIDER_MODE,
      state: "ready",
      sessionRestorable: true
    };
  }
  qr(): undefined {
    return undefined;
  }
  async disconnect(): Promise<void> {
    return undefined;
  }
  sendText: (message: WhatsAppOutboundText) => Promise<{
    providerMessageId: string;
    sentAt: Date;
  }> = async (message) => ({ providerMessageId: message.body, sentAt: new Date() });
  async close(): Promise<void> {
    return undefined;
  }
  async receive(message: WhatsAppInboundText): Promise<void> {
    await this.inbound(message);
  }
}

class MemoryRepository implements ChannelRepository {
  readonly inboundEvents: WhatsAppInboundText[] = [];
  readonly claimedOutbound: ClaimedOutboundMessage[] = [];
  readonly sent: string[] = [];
  readonly failed: Array<{ id: string; code: string }> = [];
  readonly uncertain: string[] = [];
  readonly uncertainEvidence: Array<{ id: string; providerMessageId?: string }> = [];
  restoreFailures = 0;
  acceptSendingTransition = true;
  acceptSentTransition = true;
  private readonly inboundIds = new Set<string>();
  private readonly outboundIds = new Map<string, string>();

  async projectConnection(): Promise<void> {}
  async getConnection(): Promise<undefined> {
    return undefined;
  }
  async listRestorableTenantIds(): Promise<string[]> {
    if (this.restoreFailures > 0) {
      this.restoreFailures -= 1;
      throw new Error("controlled repository outage");
    }
    return [];
  }
  async persistInbound(message: WhatsAppInboundText): Promise<PersistInboundResult> {
    const inserted = !this.inboundIds.has(message.externalMessageId);
    this.inboundIds.add(message.externalMessageId);
    if (inserted) this.inboundEvents.push(message);
    return {
      eventId: message.externalMessageId,
      threadBindingId: "00000000-0000-4000-8000-000000000002",
      inserted
    };
  }
  async claimInbound(): Promise<ClaimedInboundEvent | undefined> {
    return undefined;
  }
  async completeInbound(): Promise<boolean> {
    return true;
  }
  async failInbound(): Promise<boolean> {
    return true;
  }
  async enqueueOutbound(input: EnqueueOutboundInput): Promise<EnqueueOutboundResult> {
    const current = this.outboundIds.get(input.idempotencyKey);
    if (current) return { id: current, inserted: false };
    const id = `outbound-${this.outboundIds.size + 1}`;
    this.outboundIds.set(input.idempotencyKey, id);
    return { id, inserted: true };
  }
  async claimOutbound(): Promise<ClaimedOutboundMessage | undefined> {
    return this.claimedOutbound.shift();
  }
  async markOutboundSending(): Promise<boolean> {
    return this.acceptSendingTransition;
  }
  async markOutboundSent(message: ClaimedOutboundMessage): Promise<boolean> {
    if (!this.acceptSentTransition) return false;
    this.sent.push(message.id);
    return true;
  }
  async markOutboundFailed(message: ClaimedOutboundMessage, errorCode: string): Promise<boolean> {
    this.failed.push({ id: message.id, code: errorCode });
    return true;
  }
  async markOutboundUncertain(message: ClaimedOutboundMessage, providerMessageId?: string): Promise<boolean> {
    this.uncertain.push(message.id);
    this.uncertainEvidence.push({ id: message.id, providerMessageId });
    return true;
  }
  async updateDelivery(): Promise<boolean> {
    return true;
  }
}

function inboundMessage(): WhatsAppInboundText {
  return {
    tenantId: TENANT_ID,
    provider: WHATSAPP_PROVIDER_MODE,
    externalMessageId: "inbound-1",
    providerAddress: "573001234567@s.whatsapp.net",
    phoneHash: "a".repeat(64),
    phoneMasked: "********4567",
    body: "hola",
    receivedAt: new Date()
  };
}

function outboundMessage(id: string): ClaimedOutboundMessage {
  return {
    id,
    tenantId: TENANT_ID,
    providerAddress: "573001234567@s.whatsapp.net",
    phoneHash: "a".repeat(64),
    messageId: "00000000-0000-4000-8000-000000000003",
    body: "respuesta",
    attemptCount: 1,
    maxAttempts: 3,
    workerId: "channel-test-worker"
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
