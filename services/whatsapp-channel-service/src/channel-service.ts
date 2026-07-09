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
  private draining = false;
  private restoring = false;
  private running = false;

  constructor(
    private readonly provider: WhatsAppProvider,
    private readonly repository: ChannelRepository,
    private readonly pollIntervalMs = 500,
    private readonly emitAudit: (event: {
      tenantId: string;
      eventType: "channel.message.sent";
      entityType: "message";
      entityId: string;
      metadata: Record<string, unknown>;
    }) => void = () => undefined,
    private readonly reportRuntimeError: (errorCode: string) => void = () => undefined,
    private readonly restoreRetryMs = 5_000
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.provider.setStatusHandler((tenantId, status) => this.repository.projectConnection(tenantId, status));
    this.provider.setInboundHandler(async (message) => {
      await this.repository.persistInbound(message);
    });
    this.provider.setDeliveryHandler((update) => this.repository.updateDelivery(update));
    this.pollTimer = setInterval(() => void this.drainOutbound(), this.pollIntervalMs);
    this.pollTimer.unref();
    await this.restoreSessions();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.restoreTimer) clearTimeout(this.restoreTimer);
    this.pollTimer = undefined;
    this.restoreTimer = undefined;
    await this.provider.close();
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

  async drainOutbound(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let index = 0; index < 10; index += 1) {
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
          providerResult = await this.provider.sendText({
            tenantId: message.tenantId,
            providerAddress: message.providerAddress,
            phoneHash: message.phoneHash,
            body: message.body
          });
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
            continue;
          }
          this.emitAudit({
            tenantId: message.tenantId,
            eventType: "channel.message.sent",
            entityType: "message",
            entityId: message.messageId,
            metadata: { provider: "whatsapp_web_test", deliveryStatus: "sent" }
          });
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
    } finally {
      this.draining = false;
    }
  }

  private async restoreSessions(): Promise<void> {
    if (!this.running || this.restoring) return;
    this.restoring = true;
    try {
      await this.provider.restore(await this.repository.listRestorableTenantIds());
      if (this.restoreTimer) clearTimeout(this.restoreTimer);
      this.restoreTimer = undefined;
    } catch {
      this.reportRuntimeError("session_restore_deferred");
      if (this.running) this.scheduleRestoreRetry();
    } finally {
      this.restoring = false;
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
