import { randomUUID } from "node:crypto";
import type {
  ChannelRepository,
  ClaimedInboundEvent,
  EnqueueOutboundInput,
  EnqueueOutboundResult
} from "./channel-repository.js";
import type { WhatsAppConnectionStatus, WhatsAppProvider } from "./types.js";
import {
  WhatsAppProviderDisabledError,
  WhatsAppProviderNotReadyError,
  WhatsAppProviderRejectedError
} from "./types.js";

export class WhatsAppChannelService {
  private readonly workerId = `whatsapp-channel:${randomUUID()}`;
  private pollTimer?: NodeJS.Timeout;
  private restoreTimer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  private activeDrain?: Promise<void>;
  private activeRestore?: Promise<void>;
  private stopPromise?: Promise<void>;
  private readonly providerOperations = new Set<Promise<unknown>>();

  constructor(
    private readonly provider: WhatsAppProvider,
    private readonly repository: ChannelRepository,
    private readonly pollIntervalMs = 500,
    private readonly reportRuntimeError: (errorCode: string) => void = () => undefined,
    private readonly restoreRetryMs = 5_000,
    private readonly providerSendTimeoutMs = 15_000
  ) {}

  async start(): Promise<void> {
    if (this.running || this.stopPromise) return;
    this.running = true;
    this.provider.setStatusHandler((tenantId, status) =>
      this.trackProviderOperation(() => this.repository.projectConnection(tenantId, status))
    );
    this.provider.setInboundHandler((message) =>
      this.trackProviderOperation(async () => {
        await this.repository.persistInbound(message);
      })
    );
    this.provider.setDeliveryHandler((update) =>
      this.trackProviderOperation(() => this.repository.updateDelivery(update))
    );
    this.pollTimer = setInterval(() => void this.drainOutbound(), this.pollIntervalMs);
    this.pollTimer.unref();
    await this.restoreSessions();
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.running = false;
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.restoreTimer) clearTimeout(this.restoreTimer);
    this.pollTimer = undefined;
    this.restoreTimer = undefined;

    const activeOperations = [this.activeDrain, this.activeRestore].filter((operation): operation is Promise<void> =>
      Boolean(operation)
    );
    // Close the provider immediately so sockets stop admitting work and a
    // blocked send is interrupted while the database is still available for
    // the uncertain-delivery transition.
    const providerClose = this.provider.close();
    this.stopPromise = this.stopGracefully(activeOperations, providerClose);
    return this.stopPromise;
  }

  private async stopGracefully(activeOperations: Promise<void>[], providerClose: Promise<void>): Promise<void> {
    await Promise.allSettled([...activeOperations, providerClose]);
    // Provider.close() drains its durable capture queues. Only after that
    // boundary is closed is the callback set stable.
    while (this.providerOperations.size > 0) {
      await Promise.allSettled([...this.providerOperations]);
    }
  }

  private trackProviderOperation<T>(operation: () => Promise<T>): Promise<T> {
    const tracked = Promise.resolve().then(operation);
    this.providerOperations.add(tracked);
    void tracked.then(
      () => this.providerOperations.delete(tracked),
      () => this.providerOperations.delete(tracked)
    );
    return tracked;
  }

  async status(tenantId: string): Promise<WhatsAppConnectionStatus> {
    const persisted = await this.repository.getConnection(tenantId);
    const live = this.provider.status(tenantId);
    return {
      ...live,
      phoneMasked: live.phoneMasked ?? persisted?.phoneMasked,
      lastActivityAt: live.lastActivityAt ?? persisted?.lastActivityAt,
      lastError: live.lastError ?? persisted?.lastError,
      sessionRestorable: live.sessionRestorable || persisted?.sessionRestorable === true
    };
  }

  async connect(tenantId: string): Promise<WhatsAppConnectionStatus> {
    const status = await this.provider.connect(tenantId);
    await this.repository.projectConnection(tenantId, status);
    return status;
  }

  qr(tenantId: string): { qr: string; expiresAt: string } | undefined {
    return this.provider.qr(tenantId);
  }

  async disconnect(tenantId: string): Promise<void> {
    await this.provider.disconnect(tenantId);
  }

  enqueueOutbound(input: EnqueueOutboundInput): Promise<EnqueueOutboundResult> {
    return this.repository.enqueueOutbound(input);
  }

  async claimInbound(workerId: string, limit: number): Promise<ClaimedInboundEvent[]> {
    const events: ClaimedInboundEvent[] = [];
    for (let index = 0; index < limit; index += 1) {
      const event = await this.repository.claimInbound(workerId);
      if (!event) break;
      events.push(event);
    }
    return events;
  }

  completeInbound(tenantId: string, eventId: string, workerId: string): Promise<boolean> {
    return this.repository.completeInbound(tenantId, eventId, workerId);
  }

  failInbound(tenantId: string, eventId: string, workerId: string, errorCode: string): Promise<boolean> {
    return this.repository.failInbound(tenantId, eventId, workerId, errorCode);
  }

  drainOutbound(): Promise<void> {
    if (this.activeDrain) return this.activeDrain;
    if (this.stopped) return Promise.resolve();

    const operation = this.runOutboundDrain();
    this.activeDrain = operation;
    void operation.finally(() => {
      if (this.activeDrain === operation) this.activeDrain = undefined;
    });
    return operation;
  }

  private async runOutboundDrain(): Promise<void> {
    try {
      for (let index = 0; index < 10; index += 1) {
        if (this.stopped) break;
        const message = await this.repository.claimOutbound(this.workerId);
        if (!message) break;
        let sending = false;
        try {
          sending = await this.repository.markOutboundSending(message);
        } catch {
          this.reportRuntimeError("outbound_sending_transition_failed");
          continue;
        }
        if (!sending) continue;
        let providerResult: { providerMessageId: string; sentAt: Date } | undefined;
        try {
          providerResult = await withDeadline(
            this.provider.sendText({
              tenantId: message.tenantId,
              providerAddress: message.providerAddress,
              phoneHash: message.phoneHash,
              body: message.body
            }),
            this.providerSendTimeoutMs
          );
          const persisted = await this.repository.markOutboundSent(
            message,
            providerResult.providerMessageId,
            providerResult.sentAt
          );
          if (!persisted) {
            await this.repository.markOutboundUncertain(
              message,
              providerResult.providerMessageId,
              providerResult.sentAt
            );
          }
        } catch (error) {
          try {
            if (providerResult || !isDefinitelyNotSent(error)) {
              await this.repository.markOutboundUncertain(
                message,
                providerResult?.providerMessageId,
                providerResult?.sentAt
              );
            } else {
              await this.repository.markOutboundFailed(message, sendErrorCode(error));
            }
          } catch {
            this.reportRuntimeError("outbound_state_persistence_failed");
          }
        }
      }
    } catch {
      this.reportRuntimeError("outbound_drain_failed");
    }
  }

  private restoreSessions(): Promise<void> {
    if (this.activeRestore) return this.activeRestore;
    if (!this.running || this.stopped) return Promise.resolve();

    const operation = this.runSessionRestore();
    this.activeRestore = operation;
    void operation.finally(() => {
      if (this.activeRestore === operation) this.activeRestore = undefined;
    });
    return operation;
  }

  private async runSessionRestore(): Promise<void> {
    try {
      await this.provider.restore(await this.repository.listRestorableTenantIds());
      if (this.restoreTimer) clearTimeout(this.restoreTimer);
      this.restoreTimer = undefined;
    } catch {
      this.reportRuntimeError("session_restore_deferred");
      if (this.running) this.scheduleRestoreRetry();
    }
  }

  private scheduleRestoreRetry(): void {
    if (!this.running || this.restoreTimer) return;
    this.restoreTimer = setTimeout(() => {
      this.restoreTimer = undefined;
      void this.restoreSessions();
    }, this.restoreRetryMs);
    this.restoreTimer.unref();
  }
}

function isDefinitelyNotSent(error: unknown): boolean {
  return (
    error instanceof WhatsAppProviderDisabledError ||
    error instanceof WhatsAppProviderNotReadyError ||
    error instanceof WhatsAppProviderRejectedError
  );
}

function sendErrorCode(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "WhatsAppProviderDisabledError") return "provider_disabled";
    if (error.name === "WhatsAppProviderNotReadyError") return "provider_not_ready";
  }
  return "provider_send_failed";
}

async function withDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("provider_send_timeout")), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
