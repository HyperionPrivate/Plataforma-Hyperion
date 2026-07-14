export interface ChannelAuditEvent {
  tenantId: string;
  eventType: "channel.message.sent";
  entityType: "message";
  entityId: string;
  metadata: Record<string, unknown>;
}

interface ChannelAuditEmitterOptions {
  auditUrl: string;
  credential?: string;
  authorizationHeaders: (credential: string) => Record<string, string>;
  warn: (eventType: string) => void;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Tracks the channel's bounded direct-write audit calls so Fastify shutdown can
 * drain them after Channel.stop() has stopped every possible producer.
 * Delivery failures remain visible and bounded; durable product events continue
 * to use the transactional outbox independently.
 */
export class ChannelAuditEmitter {
  private readonly pending = new Set<Promise<void>>();
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private accepting = true;
  private stopPromise?: Promise<void>;

  constructor(private readonly options: ChannelAuditEmitterOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 2_000;
  }

  emit(event: ChannelAuditEvent): void {
    if (!this.accepting || !this.options.credential) return;

    const operation = Promise.resolve()
      .then(async () => {
        const response = await this.fetchImpl(`${this.options.auditUrl.replace(/\/$/, "")}/v1/audit/events`, {
          method: "POST",
          headers: {
            ...this.options.authorizationHeaders(this.options.credential!),
            "content-type": "application/json"
          },
          body: JSON.stringify({ ...event, actorId: "agent:SOFIA" }),
          signal: AbortSignal.timeout(this.timeoutMs)
        });
        if (!response.ok) throw new Error(`Audit service returned ${response.status}`);
      })
      .catch(() => this.options.warn(event.eventType))
      .finally(() => this.pending.delete(operation));

    this.pending.add(operation);
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.accepting = false;
    this.stopPromise = Promise.allSettled([...this.pending]).then(() => undefined);
    return this.stopPromise;
  }
}
