import { randomUUID } from "node:crypto";
import { voiceCallCompletedPayloadSchema } from "@hyperion/contracts";
import type { DatabaseClient, DatabaseExecutor } from "@hyperion/database";
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
  /** Max age for stuck dispatched calls before poll_timeout (default 6h). */
  pollTimeoutMs?: number;
}

export interface OutcomePollerHandle {
  stop: () => Promise<void>;
  tick: () => Promise<number>;
  checkReadiness: () => Promise<{ status: "ok" | "degraded"; detail?: string }>;
}

interface LocalCallRow {
  tenantId: string;
  callId: string;
  contactId: string | null;
  campaignId: string | null;
  enrollmentId: string | null;
  status: string;
  providerConversationId?: string | null;
  createdAt?: Date | string;
}

export interface ElevenLabsConversationSnapshot {
  status?: string;
  intent?: string;
  transcriptExcerpt?: string;
  callSuccessful?: string;
}

/**
 * The Neutral Dialer does not emit business webhooks to clients.
 * voice-channel polls dialer call state and (for demo Lab calls) ElevenLabs
 * conversation status, then emits voice.call.completed.
 */
export function startOutcomePoller(options: OutcomePollerOptions): OutcomePollerHandle {
  const intervalMs = options.intervalMs ?? 5_000;
  const pollTimeoutMs = options.pollTimeoutMs ?? 6 * 60 * 60 * 1000;
  const fetchImpl = options.fetchImpl ?? fetch;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let lastError: string | undefined;

  const tick = async (): Promise<number> => {
    let emitted = 0;
    try {
      emitted += await pollDialerOutcomes(options, fetchImpl);
      if (options.elevenLabsApiKey) {
        emitted += await pollElevenLabsStuckCalls(options, fetchImpl, pollTimeoutMs);
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

async function pollDialerOutcomes(options: OutcomePollerOptions, fetchImpl: typeof fetch): Promise<number> {
  let emitted = 0;
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

    const local = await options.db.query<LocalCallRow>(
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
      const conversation = await fetchElevenLabsConversation(fetchImpl, options.elevenLabsApiKey, row.conversation_id);
      intent = conversation.intent;
      transcriptExcerpt = conversation.transcriptExcerpt;
    }

    const mappedStatus = status === "failed" ? "failed" : "completed";
    const ok = await emitCallCompleted(options, {
      tenantId: current.tenantId,
      callId: current.callId,
      contactId: current.contactId,
      campaignId: current.campaignId,
      enrollmentId: current.enrollmentId,
      status: mappedStatus,
      resultCode: row.result_code ?? status,
      disposition: row.disposition ?? undefined,
      intent,
      amdLabel: row.amd_label ?? undefined,
      providerConversationId: row.conversation_id ?? undefined,
      transcriptExcerpt
    });
    if (ok) emitted += 1;
  }
  return emitted;
}

/**
 * Demo Lab calls never appear in dialer GET /api/calls — complete them via
 * ElevenLabs conversation status using the stored provider_conversation_id.
 */
export async function pollElevenLabsStuckCalls(
  options: OutcomePollerOptions,
  fetchImpl: typeof fetch,
  pollTimeoutMs: number
): Promise<number> {
  if (!options.elevenLabsApiKey) return 0;

  let emitted = 0;
  const stuck = await options.db.query<LocalCallRow>(
    `select tenant_id as "tenantId", call_id as "callId", contact_id as "contactId",
            campaign_ref as "campaignId", enrollment_id as "enrollmentId", status,
            provider_conversation_id as "providerConversationId",
            created_at as "createdAt"
       from voice.calls
      where status = 'dispatched'
        and provider_conversation_id is not null
        and created_at > now() - interval '24 hours'
      order by created_at asc
      limit 20`
  );

  const now = Date.now();
  for (const current of stuck.rows) {
    if (!current.contactId || !current.providerConversationId) continue;

    const createdMs =
      current.createdAt instanceof Date
        ? current.createdAt.getTime()
        : new Date(String(current.createdAt ?? "")).getTime();
    if (Number.isFinite(createdMs) && now - createdMs > pollTimeoutMs) {
      const timedOut = await emitCallCompleted(options, {
        tenantId: current.tenantId,
        callId: current.callId,
        contactId: current.contactId,
        campaignId: current.campaignId,
        enrollmentId: current.enrollmentId,
        status: "failed",
        resultCode: "poll_timeout",
        providerConversationId: current.providerConversationId
      });
      if (timedOut) emitted += 1;
      continue;
    }

    const conversation = await fetchElevenLabsConversation(
      fetchImpl,
      options.elevenLabsApiKey,
      current.providerConversationId
    );
    const elStatus = String(conversation.status ?? "").toLowerCase();
    if (!isTerminalElevenLabsStatus(elStatus)) continue;

    const mappedStatus = elStatus === "failed" ? "failed" : "completed";
    const ok = await emitCallCompleted(options, {
      tenantId: current.tenantId,
      callId: current.callId,
      contactId: current.contactId,
      campaignId: current.campaignId,
      enrollmentId: current.enrollmentId,
      status: mappedStatus,
      resultCode: elStatus || mappedStatus,
      intent: conversation.intent,
      providerConversationId: current.providerConversationId,
      transcriptExcerpt: conversation.transcriptExcerpt
    });
    if (ok) emitted += 1;
  }
  return emitted;
}

export function isTerminalElevenLabsStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized === "done" || normalized === "failed" || normalized === "completed";
}

async function emitCallCompleted(
  options: OutcomePollerOptions,
  input: {
    tenantId: string;
    callId: string;
    contactId: string;
    campaignId: string | null;
    enrollmentId: string | null;
    status: "completed" | "failed";
    resultCode: string;
    disposition?: string;
    intent?: string;
    amdLabel?: string;
    providerConversationId?: string;
    transcriptExcerpt?: string;
  }
): Promise<boolean> {
  const correlationId = randomUUID();
  let emitted = false;
  await options.db.transaction(async (tx: DatabaseExecutor) => {
    const updated = await tx.query(
      `update voice.calls
          set status = $3,
              result_code = $4,
              disposition = $5,
              intent = $6,
              amd_label = coalesce($7, amd_label),
              provider_conversation_id = coalesce($8, provider_conversation_id),
              completed_at = now(),
              updated_at = now()
        where tenant_id = $1 and call_id = $2
          and status not in ('completed', 'failed')`,
      [
        input.tenantId,
        input.callId,
        input.status,
        input.resultCode,
        input.disposition ?? null,
        input.intent ?? null,
        input.amdLabel ?? null,
        input.providerConversationId ?? null
      ]
    );
    if ((updated.rowCount ?? 0) === 0) return;

    await insertVoiceOutboxEvent(tx, {
      eventId: randomUUID(),
      eventType: "voice.call.completed",
      tenantId: input.tenantId,
      correlationId,
      businessIdempotencyKey: `voice-completed:${input.callId}`,
      payload: voiceCallCompletedPayloadSchema.parse({
        call_id: input.callId,
        contact_id: input.contactId,
        campaign_id: input.campaignId ?? undefined,
        enrollment_id: input.enrollmentId ?? undefined,
        status: input.status,
        result_code: input.resultCode,
        disposition: input.disposition,
        intent: input.intent,
        amd_label: input.amdLabel,
        provider_conversation_id: input.providerConversationId,
        transcript_excerpt: input.transcriptExcerpt
      }),
      destination: options.novaDestination
    });
    emitted = true;
  });
  return emitted;
}

async function markLocalNeedsReconciliation(db: DatabaseClient, dialerCallRef: string): Promise<void> {
  await db.query(
    `update voice.calls
        set status = 'needs_reconciliation', updated_at = now()
      where dialer_call_ref = $1 and status not in ('completed', 'failed')`,
    [dialerCallRef]
  );
}

function coerceAnalysisValue(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    const text = String(raw).trim();
    return text.length > 0 ? text : undefined;
  }
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of ["value", "result", "answer", "selected"]) {
      const nested = coerceAnalysisValue(obj[key]);
      if (nested) return nested;
    }
  }
  return undefined;
}

export async function fetchElevenLabsConversation(
  fetchImpl: typeof fetch,
  apiKey: string,
  conversationId: string
): Promise<ElevenLabsConversationSnapshot> {
  const response = await fetchImpl(`https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`, {
    headers: { "xi-api-key": apiKey }
  });
  if (!response.ok) return {};
  const body = (await response.json()) as Record<string, unknown>;
  const analysis = (body.analysis as Record<string, unknown> | undefined) ?? {};
  const dataCollection = (analysis.data_collection_results as Record<string, unknown> | undefined) ?? {};
  const intent =
    coerceAnalysisValue(dataCollection.intencion) ??
    coerceAnalysisValue(dataCollection.intent) ??
    coerceAnalysisValue(dataCollection.disposition) ??
    coerceAnalysisValue(analysis.call_successful);
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
  return {
    status: body.status !== undefined ? String(body.status) : undefined,
    intent,
    transcriptExcerpt: transcript,
    callSuccessful: coerceAnalysisValue(analysis.call_successful)
  };
}
