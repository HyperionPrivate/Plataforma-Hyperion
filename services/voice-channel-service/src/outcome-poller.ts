import { randomUUID } from "node:crypto";
import { voiceCallCompletedPayloadSchema } from "@hyperion/contracts";
import type { DatabaseClient } from "@hyperion/database";
import type { DialerAdapter } from "./dialer-adapter.js";
import { insertVoiceOutboxEvent } from "./outbox.js";

export interface OutcomePollerOptions {
  db: DatabaseClient;
  dialer: DialerAdapter;
  novaDestination: string;
  elevenLabsApiKey?: string;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  onError?: (error: unknown) => void;
}

export interface OutcomePollerHandle {
  stop: () => Promise<void>;
  tick: () => Promise<number>;
  checkReadiness: () => Promise<{ status: "ok" | "degraded"; detail?: string }>;
}

/**
 * The Neutral Dialer does not emit business webhooks to clients.
 * voice-channel polls dialer call state and emits voice.call.completed.
 */
export function startOutcomePoller(options: OutcomePollerOptions): OutcomePollerHandle {
  const intervalMs = options.intervalMs ?? 5_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let lastError: string | undefined;

  const tick = async (): Promise<number> => {
    let emitted = 0;
    try {
      const [calls, reconciliation] = await Promise.all([
        options.dialer.listCalls({ limit: 100 }),
        options.dialer.listReconciliation()
      ]);

      for (const row of reconciliation) {
        await markLocalNeedsReconciliation(options.db, row.id);
      }

      for (const row of calls) {
        const status = String(row.status ?? "").toLowerCase();
        if (!["completed", "failed", "answered", "done"].includes(status) && status !== "needs_reconciliation") {
          continue;
        }

        const local = await options.db.query<{
          tenantId: string;
          callId: string;
          contactId: string | null;
          campaignId: string | null;
          enrollmentId: string | null;
          status: string;
        }>(
          `select tenant_id as "tenantId", call_id as "callId", contact_id as "contactId",
                  campaign_ref as "campaignId", enrollment_id as "enrollmentId", status
             from voice.calls
            where dialer_call_ref = $1
            limit 1`,
          [row.id]
        );
        if (local.rowCount === 0) continue;
        const current = local.rows[0]!;
        if (current.status === "completed" || current.status === "failed") continue;
        if (!current.contactId) continue;

        if (status === "needs_reconciliation") {
          await options.db.query(
            `update voice.calls
                set status = 'needs_reconciliation', amd_label = $3, disposition = $4, updated_at = now()
              where tenant_id = $1 and call_id = $2`,
            [current.tenantId, current.callId, row.amd_label ?? null, row.disposition ?? null]
          );
          continue;
        }

        let intent: string | undefined;
        let transcriptExcerpt: string | undefined;
        if (row.conversation_id && options.elevenLabsApiKey) {
          const conversation = await fetchElevenLabsConversation(
            fetchImpl,
            options.elevenLabsApiKey,
            row.conversation_id
          );
          intent = conversation.intent;
          transcriptExcerpt = conversation.transcriptExcerpt;
        }

        const mappedStatus = status === "failed" ? "failed" : "completed";
        const correlationId = randomUUID();
        await options.db.transaction(async (tx) => {
          await tx.query(
            `update voice.calls
                set status = $3,
                    result_code = $4,
                    disposition = $5,
                    intent = $6,
                    amd_label = $7,
                    provider_conversation_id = $8,
                    completed_at = now(),
                    updated_at = now()
              where tenant_id = $1 and call_id = $2`,
            [
              current.tenantId,
              current.callId,
              mappedStatus,
              row.result_code ?? status,
              row.disposition ?? null,
              intent ?? null,
              row.amd_label ?? null,
              row.conversation_id ?? null
            ]
          );

          await insertVoiceOutboxEvent(tx, {
            eventId: randomUUID(),
            eventType: "voice.call.completed",
            tenantId: current.tenantId,
            correlationId,
            businessIdempotencyKey: `voice-completed:${current.callId}`,
            payload: voiceCallCompletedPayloadSchema.parse({
              call_id: current.callId,
              contact_id: current.contactId,
              campaign_id: current.campaignId ?? undefined,
              enrollment_id: current.enrollmentId ?? undefined,
              status: mappedStatus,
              result_code: row.result_code ?? status,
              disposition: row.disposition ?? undefined,
              intent,
              amd_label: row.amd_label ?? undefined,
              provider_conversation_id: row.conversation_id ?? undefined,
              transcript_excerpt: transcriptExcerpt
            }),
            destination: options.novaDestination
          });
        });
        emitted += 1;
      }
      lastError = undefined;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      options.onError?.(error);
    }
    return emitted;
  };

  const loop = () => {
    if (stopped) return;
    void tick().finally(() => {
      if (!stopped) timer = setTimeout(loop, intervalMs);
    });
  };
  timer = setTimeout(loop, intervalMs);

  return {
    tick,
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    checkReadiness: async () =>
      lastError ? { status: "degraded", detail: lastError } : { status: "ok", detail: "outcome poller running" }
  };
}

async function markLocalNeedsReconciliation(db: DatabaseClient, dialerCallRef: string): Promise<void> {
  await db.query(
    `update voice.calls
        set status = 'needs_reconciliation', updated_at = now()
      where dialer_call_ref = $1 and status not in ('completed', 'failed')`,
    [dialerCallRef]
  );
}

async function fetchElevenLabsConversation(
  fetchImpl: typeof fetch,
  apiKey: string,
  conversationId: string
): Promise<{ intent?: string; transcriptExcerpt?: string }> {
  const response = await fetchImpl(`https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`, {
    headers: { "xi-api-key": apiKey }
  });
  if (!response.ok) return {};
  const body = (await response.json()) as Record<string, unknown>;
  const analysis = (body.analysis as Record<string, unknown> | undefined) ?? {};
  const dataCollection = (analysis.data_collection_results as Record<string, unknown> | undefined) ?? {};
  const intent =
    String(
      dataCollection.intencion ?? dataCollection.intent ?? dataCollection.disposition ?? analysis.call_successful ?? ""
    ) || undefined;
  const transcript = Array.isArray(body.transcript)
    ? body.transcript
        .map((turn) => {
          const row = turn as Record<string, unknown>;
          return String(row.message ?? row.text ?? "");
        })
        .filter(Boolean)
        .join(" ")
        .slice(0, 4000)
    : undefined;
  return { intent, transcriptExcerpt: transcript };
}
