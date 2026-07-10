import { randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseClient } from "@hyperion/database";
import type { RouteRegistrar } from "@hyperion/service-runtime";
import { z } from "zod";
import type { LlmMessage, LlmProvider } from "./llm-provider.js";
import { isExplicitConfirmation, SOFIA_TOOL_DEFINITIONS, SofiaToolClient } from "./sofia-tools.js";

const inboundEventSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  threadBindingId: z.string().uuid(),
  externalMessageId: z.string().min(1),
  phoneHash: z.string().regex(/^[a-f0-9]{64}$/),
  phoneMasked: z.string().min(3),
  body: z.string().min(1).max(2_000),
  occurredAt: z.string().datetime(),
  attemptCount: z.number().int().nonnegative()
});

const jobInputSchema = z.object({
  patientId: z.string().uuid(),
  messageId: z.string().uuid(),
  threadBindingId: z.string().uuid(),
  occurredAt: z.string().datetime()
});

const AVAILABILITY_CONTEXT_SCHEMA_VERSION = 2;
const AVAILABILITY_CONTEXT_TTL_MS = 10 * 60 * 1_000;
const authoritativeAvailabilitySlotSchema = z.object({
  siteId: z.string().uuid(),
  siteName: z.string().min(1),
  professionalId: z.string().uuid(),
  professionalName: z.string().min(1),
  payerId: z.string().uuid().nullable(),
  payerName: z.string().min(1).nullable(),
  appointmentTypeId: z.string().uuid(),
  appointmentTypeName: z.string().min(1),
  startsAt: z.string().datetime(),
  scheduledAt: z.string().datetime(),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  timeZone: z.string().min(1)
});
const successfulAvailabilityResultSchema = z.object({
  ok: z.literal(true),
  data: z.object({ slots: z.array(authoritativeAvailabilitySlotSchema) })
});

interface ClaimedJob {
  id: string;
  tenantId: string;
  conversationId: string;
  inboundEventId: string;
  attemptCount: number;
  maxAttempts: number;
  input: unknown;
}

interface PromptFlow {
  id: string;
  version: number;
  systemPrompt: string;
  urgentMessage?: string;
}

export interface SofiaRuntimeOptions {
  db: DatabaseClient;
  logger: { warn(message: string, metadata?: Record<string, unknown>): void };
  llm: LlmProvider;
  internalServiceToken: string;
  channelUrl: string;
  promptFlowUrl: string;
  pulsoIrisUrl: string;
  auditUrl: string;
  fetchImpl?: typeof fetch;
  workerId?: string;
  pollIntervalMs?: number;
}

export class SofiaRuntime {
  private readonly fetchImpl: typeof fetch;
  private readonly workerId: string;
  private readonly tools: SofiaToolClient;
  private readonly pollIntervalMs: number;
  private ingestTimer?: NodeJS.Timeout;
  private jobTimer?: NodeJS.Timeout;
  private ingesting = false;
  private processing = false;

  constructor(private readonly options: SofiaRuntimeOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.workerId = options.workerId ?? `sofia-${randomUUID()}`;
    this.pollIntervalMs = options.pollIntervalMs ?? 750;
    this.tools = new SofiaToolClient({
      pulsoIrisUrl: options.pulsoIrisUrl,
      internalServiceToken: options.internalServiceToken,
      db: options.db,
      fetchImpl: this.fetchImpl
    });
  }

  start(): void {
    if (this.ingestTimer || this.jobTimer) return;
    this.ingestTimer = setInterval(() => void this.ingestTick(), this.pollIntervalMs);
    this.jobTimer = setInterval(() => void this.jobTick(), this.pollIntervalMs);
    this.ingestTimer.unref();
    this.jobTimer.unref();
    void this.ingestTick();
    void this.jobTick();
  }

  stop(): void {
    if (this.ingestTimer) clearInterval(this.ingestTimer);
    if (this.jobTimer) clearInterval(this.jobTimer);
    this.ingestTimer = undefined;
    this.jobTimer = undefined;
  }

  isRunning(): boolean {
    return Boolean(this.ingestTimer && this.jobTimer);
  }

  async ingestOnce(): Promise<number> {
    const payload = await this.callChannel("/internal/v1/whatsapp/inbound/claim", "POST", {
      workerId: this.workerId,
      limit: 5
    });
    const events = z.object({ events: z.array(inboundEventSchema) }).parse(payload).events;
    for (const event of events) {
      try {
        const identity = await this.tools.identifyPatient({
          tenantId: event.tenantId,
          phoneHash: event.phoneHash,
          phoneMasked: event.phoneMasked,
          threadBindingId: event.threadBindingId,
          externalMessageId: event.externalMessageId,
          body: event.body
        });
        const insertedJob = await this.options.db.query<{ id: string }>(
          `insert into agent_runtime.jobs
             (tenant_id, conversation_id, inbound_event_id, idempotency_key, status, input)
           values ($1, $2, $3, $4, 'queued', $5::jsonb)
           on conflict (tenant_id, inbound_event_id) do nothing
           returning id`,
          [
            event.tenantId,
            identity.conversationId,
            event.id,
            `sofia-inbound:${event.id}`,
            JSON.stringify({
              patientId: identity.patientId,
              messageId: identity.messageId,
              threadBindingId: event.threadBindingId,
              occurredAt: event.occurredAt
            })
          ]
        );
        if (insertedJob.rows[0]) {
          await this.options.db.query(
            `update pulso_iris.conversations
             set metadata = metadata || jsonb_build_object(
                   'sofiaStatus', 'queued',
                   'lastSofiaActivityAt', now()
                 ), updated_at = now()
             where tenant_id = $1 and id = $2`,
            [event.tenantId, identity.conversationId]
          );
        }
        await this.callChannel(`/internal/v1/tenants/${event.tenantId}/whatsapp/inbound/${event.id}/complete`, "POST", {
          workerId: this.workerId
        });
      } catch (error) {
        await this.failInbound(event.tenantId, event.id, error);
      }
    }
    return events.length;
  }

  async processOne(): Promise<boolean> {
    const claimed = await this.options.db.query<ClaimedJob>(
      `select id, tenant_id as "tenantId", conversation_id as "conversationId",
              inbound_event_id as "inboundEventId", attempt_count as "attemptCount",
              max_attempts as "maxAttempts", input
       from agent_runtime.claim_next_job($1)`,
      [this.workerId]
    );
    const job = claimed.rows[0];
    if (!job) return false;
    try {
      await this.processJob(job);
    } catch (error) {
      await this.failJob(job, error);
    }
    return true;
  }

  private async ingestTick(): Promise<void> {
    if (this.ingesting) return;
    this.ingesting = true;
    try {
      await this.ingestOnce();
    } catch (error) {
      this.options.logger.warn("SOFIA inbound polling failed", { error: sanitizeError(error) });
    } finally {
      this.ingesting = false;
    }
  }

  private async jobTick(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      for (let index = 0; index < 5 && (await this.processOne()); index += 1) {
        // Drain a bounded batch and yield to the event loop.
      }
    } catch (error) {
      this.options.logger.warn("SOFIA job polling failed", { error: sanitizeError(error) });
    } finally {
      this.processing = false;
    }
  }

  private async processJob(job: ClaimedJob): Promise<void> {
    const input = jobInputSchema.parse(job.input);
    const current = await this.options.db.query<{ body: string; conversationStatus: string }>(
      `select m.body, c.status as "conversationStatus"
       from pulso_iris.messages m
       join pulso_iris.conversations c
         on c.tenant_id = m.tenant_id and c.id = m.conversation_id
       where m.tenant_id = $1 and m.id = $2 and m.conversation_id = $3`,
      [job.tenantId, input.messageId, job.conversationId]
    );
    const currentMessage = current.rows[0];
    const currentBody = currentMessage?.body;
    if (!currentBody) throw new Error("Inbound message is missing");

    await this.setConversationRuntime(job.tenantId, job.conversationId, "processing");
    const prompt = await this.loadPrompt(job.tenantId);
    const startedAt = Date.now();
    let responseText = "";
    let executionStatus: "completed" | "fallback" = "completed";
    let model = this.options.llm.model;
    let inputTokens = 0;
    let outputTokens = 0;
    let totalLatencyMs = 0;
    const toolNames: string[] = [];

    const execution = await this.options.db.query<{ id: string }>(
      `insert into agent_runtime.executions
         (tenant_id, job_id, agent_code, provider, model, status, attempt_number)
       values ($1, $2, 'SOFIA', $3, $4, 'running', $5)
       on conflict (tenant_id, job_id, attempt_number)
       do update set status = 'running', error_code = null, started_at = now(), completed_at = null
       returning id`,
      [job.tenantId, job.id, this.options.llm.name, this.options.llm.model, job.attemptCount]
    );

    try {
      if (currentMessage.conversationStatus === "handoff_required" || isUrgencySignal(currentBody)) {
        responseText =
          prompt.urgentMessage ??
          "Por seguridad, no puedo orientar síntomas por este canal. Busca atención médica urgente o comunícate con los servicios de emergencia de tu zona.";
        if (currentMessage.conversationStatus !== "handoff_required") {
          try {
            await this.callPulsoTool(job.tenantId, "create_urgent_handoff", {
              patientId: input.patientId,
              conversationId: job.conversationId,
              triggerCode: "symptom_or_urgency_signal"
            });
            toolNames.push("create_urgent_handoff");
          } catch (error) {
            executionStatus = "fallback";
            this.options.logger.warn("SOFIA urgency handoff could not be persisted", { error: sanitizeError(error) });
          }
        }
      } else {
        const context = await this.buildMessages(job, input, prompt);
        const messages = context.messages;
        const freshAvailabilityRequired = requiresFreshAvailability(currentBody, context.hadAvailabilityContext);
        let availabilitySearchAttempted = false;
        let freshAvailabilitySucceeded = false;
        let freshAvailability: z.infer<typeof successfulAvailabilityResultSchema>["data"] | undefined;
        let preparedAvailabilitySlot: z.infer<typeof authoritativeAvailabilitySlotSchema> | undefined;
        let preparedAvailabilityAction: "book" | "reschedule" | undefined;
        roundLoop: for (let round = 0; round < 6; round += 1) {
          const completion = await this.options.llm.complete({
            messages,
            tools: SOFIA_TOOL_DEFINITIONS,
            ...(round === 0 && freshAvailabilityRequired
              ? { toolChoice: { name: "search_availability" } as const }
              : {})
          });
          model = completion.model;
          inputTokens += completion.inputTokens ?? 0;
          outputTokens += completion.outputTokens ?? 0;
          totalLatencyMs += completion.latencyMs;
          messages.push({ role: "assistant", content: completion.content, toolCalls: completion.toolCalls });
          if (completion.toolCalls.length === 0) {
            if ((freshAvailabilityRequired || availabilitySearchAttempted) && !freshAvailabilitySucceeded) {
              executionStatus = "fallback";
              responseText = availabilityFallback();
            } else if (freshAvailabilityRequired && preparedAvailabilitySlot && preparedAvailabilityAction) {
              responseText = renderAuthoritativeConfirmation(preparedAvailabilitySlot, preparedAvailabilityAction);
            } else if (freshAvailability) {
              responseText = renderAuthoritativeAvailability(freshAvailability.slots);
            } else {
              responseText = completion.content?.trim() || deterministicFallback();
            }
            break;
          }
          for (const toolCall of completion.toolCalls) {
            if (round === 0 && freshAvailabilityRequired && toolCall.name !== "search_availability") {
              messages.push({
                role: "tool",
                toolCallId: toolCall.id,
                content: JSON.stringify({
                  ok: false,
                  code: "fresh_availability_required",
                  message: "Debes ejecutar search_availability antes de usar otra herramienta en este turno."
                })
              });
              continue;
            }
            if (
              !isExplicitConfirmation(currentBody) &&
              isSlotMutation(toolCall.name) &&
              !matchesAuthoritativeAvailabilitySlot(toolCall.arguments, freshAvailability?.slots ?? [])
            ) {
              messages.push({
                role: "tool",
                toolCallId: toolCall.id,
                content: JSON.stringify({
                  ok: false,
                  code: "fresh_availability_required",
                  message: "La acción no coincide con un slot consultado en este mismo turno."
                })
              });
              continue;
            }
            const matchedAvailabilitySlot = isSlotMutation(toolCall.name)
              ? findAuthoritativeAvailabilitySlot(toolCall.arguments, freshAvailability?.slots ?? [])
              : undefined;
            if (toolCall.name === "search_availability") {
              availabilitySearchAttempted = true;
              freshAvailabilitySucceeded = false;
              freshAvailability = undefined;
            }
            toolNames.push(toolCall.name);
            const result = await this.tools.execute(toolCall.name, toolCall.arguments, {
              tenantId: job.tenantId,
              patientId: input.patientId,
              conversationId: job.conversationId,
              currentMessageId: input.messageId,
              currentMessageBody: currentBody,
              jobId: job.id,
              sequence: toolNames.length
            });
            if (toolCall.name === "search_availability") {
              const parsedAvailability = successfulAvailabilityResultSchema.safeParse(result);
              if (parsedAvailability.success) {
                freshAvailabilitySucceeded = true;
                freshAvailability = parsedAvailability.data.data;
              }
            } else if (
              matchedAvailabilitySlot &&
              isRecord(result) &&
              result.code === "explicit_confirmation_required"
            ) {
              preparedAvailabilitySlot = matchedAvailabilitySlot;
              preparedAvailabilityAction = toolCall.name === "reschedule_appointment" ? "reschedule" : "book";
            }
            messages.push({
              role: "tool",
              toolCallId: toolCall.id,
              content: JSON.stringify(result).slice(0, 20_000)
            });
            if (preparedAvailabilitySlot && preparedAvailabilityAction) {
              responseText = renderAuthoritativeConfirmation(preparedAvailabilitySlot, preparedAvailabilityAction);
              break roundLoop;
            }
          }
          if (round === 5) {
            responseText =
              (freshAvailabilityRequired || availabilitySearchAttempted) && !freshAvailabilitySucceeded
                ? availabilityFallback()
                : freshAvailability
                  ? renderAuthoritativeAvailability(freshAvailability.slots)
                  : deterministicFallback();
          }
        }
        responseText ??=
          (freshAvailabilityRequired || availabilitySearchAttempted) && !freshAvailabilitySucceeded
            ? availabilityFallback()
            : freshAvailability
              ? renderAuthoritativeAvailability(freshAvailability.slots)
              : deterministicFallback();
      }
    } catch (error) {
      executionStatus = "fallback";
      responseText = deterministicFallback();
      this.options.logger.warn("SOFIA used deterministic fallback", { error: sanitizeError(error) });
    }

    const boundedResponse = boundText(responseText);
    const elapsedMs = Date.now() - new Date(input.occurredAt).getTime();
    const messageId = await this.persistResponse(job, input, boundedResponse, {
      model,
      promptVersion: prompt.version,
      toolNames,
      latencyMs: elapsedMs
    });
    await this.callChannel(`/internal/v1/tenants/${job.tenantId}/whatsapp/messages`, "POST", {
      threadBindingId: input.threadBindingId,
      messageId,
      text: boundedResponse,
      idempotencyKey: `sofia-job:${job.id}`
    });

    await this.options.db.transaction(async (tx) => {
      await tx.query(
        `update agent_runtime.executions
         set status = $3, model = $4, latency_ms = $5, input_tokens = $6, output_tokens = $7,
             tool_names = $8::jsonb, completed_at = now()
         where tenant_id = $1 and id = $2`,
        [
          job.tenantId,
          execution.rows[0]!.id,
          executionStatus,
          model,
          totalLatencyMs || Date.now() - startedAt,
          inputTokens,
          outputTokens,
          JSON.stringify([...new Set(toolNames)])
        ]
      );
      await tx.query(
        `update agent_runtime.jobs
         set status = 'completed', completed_at = now(), locked_at = null, locked_by = null, updated_at = now()
         where tenant_id = $1 and id = $2`,
        [job.tenantId, job.id]
      );
    });
    await this.setConversationRuntime(job.tenantId, job.conversationId, "responded", inferIntent(toolNames));
    this.emitAudit(job.tenantId, "agent.execution.completed", "agent_execution", execution.rows[0]!.id, {
      model,
      toolNames: [...new Set(toolNames)],
      latencyMs: totalLatencyMs,
      fallback: executionStatus === "fallback"
    });
    this.emitAudit(job.tenantId, "agent.response.created", "message", messageId, {
      provider: "whatsapp_web_test",
      latencyMs: elapsedMs
    });
  }

  private async buildMessages(
    job: ClaimedJob,
    input: z.infer<typeof jobInputSchema>,
    prompt: PromptFlow
  ): Promise<{ messages: LlmMessage[]; hadAvailabilityContext: boolean }> {
    const [history, state, patient, catalog] = await Promise.all([
      this.options.db.query<{ sender: string; body: string }>(
        `select sender, body from (
           select sender, body, created_at from pulso_iris.messages
           where tenant_id = $1 and conversation_id = $2
           order by created_at desc limit 12
         ) recent order by created_at`,
        [job.tenantId, job.conversationId]
      ),
      this.options.db.query<{ sofiaState: unknown }>(
        `select coalesce(metadata->'sofiaState', '{}'::jsonb) as "sofiaState"
         from pulso_iris.conversations where tenant_id = $1 and id = $2`,
        [job.tenantId, job.conversationId]
      ),
      this.options.db.query<{ fullName?: string }>(
        `select full_name as "fullName" from pulso_iris.administrative_patients
         where tenant_id = $1 and id = $2`,
        [job.tenantId, input.patientId]
      ),
      this.callPulsoTool(job.tenantId, "get_catalog", {})
    ]);
    const now = Date.now();
    const sanitized = sanitizeSofiaState(state.rows[0]?.sofiaState, now);
    const runtimeContext = {
      now: new Date(now).toISOString(),
      timezone: "America/Bogota",
      patientName: patient.rows[0]?.fullName ?? null,
      availabilityContextValid: sanitized.availabilityStatus === "valid",
      state: sanitized.state,
      catalog
    };
    return {
      messages: [
        {
          role: "system",
          content: `${prompt.systemPrompt}\n\nContexto estructurado de Hyperion:\n${JSON.stringify(runtimeContext)}`
        },
        ...history.rows.map((message): LlmMessage => ({
          role: message.sender === "patient" ? "user" : "assistant",
          content: message.body
        }))
      ],
      hadAvailabilityContext: sanitized.availabilityStatus !== "absent"
    };
  }

  private async loadPrompt(tenantId: string): Promise<PromptFlow> {
    const payload = await this.callInternal(
      `${this.options.promptFlowUrl}/internal/v1/tenants/${tenantId}/prompt-flows/SOFIA/active`,
      "GET"
    );
    return z
      .object({
        id: z.string().uuid(),
        version: z.number().int().positive(),
        systemPrompt: z.string().min(20),
        urgentMessage: z.string().min(20).optional()
      })
      .parse(payload);
  }

  private async persistResponse(
    job: ClaimedJob,
    input: z.infer<typeof jobInputSchema>,
    body: string,
    metadata: Record<string, unknown>
  ): Promise<string> {
    const externalId = `sofia-job:${job.id}`;
    const inserted = await this.options.db.query<{ id: string }>(
      `insert into pulso_iris.messages
         (tenant_id, conversation_id, sender, body, provider, external_message_id, delivery_status, metadata)
       values ($1, $2, 'sofia', $3, 'whatsapp_web_test', $4, 'queued', $5::jsonb)
       on conflict (tenant_id, provider, external_message_id)
         where provider is not null and external_message_id is not null
       do update set body = pulso_iris.messages.body
       returning id`,
      [job.tenantId, job.conversationId, body, externalId, JSON.stringify(metadata)]
    );
    return inserted.rows[0]!.id;
  }

  private async failInbound(tenantId: string, eventId: string, error: unknown): Promise<void> {
    try {
      await this.callChannel(`/internal/v1/tenants/${tenantId}/whatsapp/inbound/${eventId}/fail`, "POST", {
        workerId: this.workerId,
        errorCode: "sofia_ingest_failed"
      });
    } catch {
      // The stale claim lease makes this event recoverable without a second side effect.
    }
    this.options.logger.warn("SOFIA inbound event failed", { eventId, error: sanitizeError(error) });
  }

  private async failJob(job: ClaimedJob, error: unknown): Promise<void> {
    const terminal = job.attemptCount >= job.maxAttempts;
    await this.options.db.query(
      `update agent_runtime.jobs
       set status = $3, next_attempt_at = now() + interval '5 seconds',
           locked_at = null, locked_by = null, last_error_code = 'job_failed',
           last_error_message = $4, updated_at = now()
       where tenant_id = $1 and id = $2`,
      [job.tenantId, job.id, terminal ? "dead_letter" : "retry_scheduled", sanitizeError(error)]
    );
    await this.setConversationRuntime(job.tenantId, job.conversationId, "failed");
    this.options.logger.warn("SOFIA job failed", { jobId: job.id, terminal, error: sanitizeError(error) });
  }

  private async setConversationRuntime(tenantId: string, conversationId: string, status: string, intent?: string) {
    await this.options.db.query(
      `update pulso_iris.conversations
       set metadata = metadata || jsonb_build_object('sofiaStatus', $3::text, 'lastSofiaActivityAt', now()),
           primary_intent = coalesce($4, primary_intent), updated_at = now()
       where tenant_id = $1 and id = $2`,
      [tenantId, conversationId, status, intent ?? null]
    );
  }

  private async callChannel(path: string, method: "GET" | "POST", body?: unknown): Promise<unknown> {
    return this.callInternal(`${this.options.channelUrl}${path}`, method, body);
  }

  private async callPulsoTool(tenantId: string, toolName: string, body: unknown): Promise<unknown> {
    return this.callInternal(
      `${this.options.pulsoIrisUrl}/internal/v1/tenants/${tenantId}/pulso-iris/sofia/tools/${toolName}`,
      "POST",
      body
    );
  }

  private async callInternal(url: string, method: "GET" | "POST", body?: unknown): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${this.options.internalServiceToken}`, "content-type": "application/json" },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      signal: AbortSignal.timeout(5_000)
    });
    const payload = (await response.json()) as { data?: unknown };
    if (!response.ok) throw new Error(`Internal dependency returned status ${response.status}`);
    return payload.data;
  }

  private emitAudit(
    tenantId: string,
    eventType: string,
    entityType: string,
    entityId: string,
    metadata: Record<string, unknown>
  ): void {
    void this.fetchImpl(`${this.options.auditUrl}/v1/audit/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.internalServiceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ tenantId, actorId: "agent:SOFIA", eventType, entityType, entityId, metadata }),
      signal: AbortSignal.timeout(2_000)
    }).catch(() => undefined);
  }
}

export function registerSofiaReadinessRoute(
  app: Parameters<RouteRegistrar>[0],
  options: {
    db: DatabaseClient;
    llm: LlmProvider;
    internalServiceToken: string;
    workerEnabled: boolean;
    runtime: Pick<SofiaRuntime, "isRunning">;
  }
): void {
  app.get("/internal/v1/tenants/:tenantId/sofia/readiness", async (request, reply) => {
    if (!hasInternalToken(request.headers.authorization, options.internalServiceToken)) {
      return reply.code(401).send({ data: { error: "Internal authentication required" }, requestId: request.id });
    }
    const tenantId = z
      .string()
      .uuid()
      .safeParse((request.params as { tenantId?: unknown }).tenantId);
    if (!tenantId.success) return reply.code(400).send({ data: { error: "Invalid tenant" }, requestId: request.id });
    const prompt = await options.db.query<{ count: number }>(
      `select count(*)::int as count
       from (
         select f.definition ->> 'runtimeKey' as runtime_key
         from platform.prompt_flows f
         join platform.agents a on a.id = f.agent_id
         where f.tenant_id = $1 and a.tenant_id = $1 and a.code = 'SOFIA'
           and f.status = 'active' and a.status = 'active'
         order by f.version desc, f.updated_at desc
         limit 1
       ) selected
       where selected.runtime_key = 'sofia_whatsapp_internal_v4'
         and exists (
           select 1 from platform.schema_migrations
           where name = '015-sofia-fresh-availability.sql'
         )`,
      [tenantId.data]
    );
    const workerRunning = options.runtime.isRunning();
    return {
      data: {
        ready: options.workerEnabled && workerRunning && options.llm.isConfigured() && (prompt.rows[0]?.count ?? 0) > 0,
        model: options.llm.model,
        workerEnabled: options.workerEnabled,
        workerRunning
      }
    };
  });
}

export function isUrgencySignal(body: string): boolean {
  const normalized = body
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return /\b(urgencia|emergencia|sintomas?|dolor|ardor|picazon|comezon|irritacion|enrojec\w*|ojo rojo|vision borrosa|veo borroso|perdi la vision|perdida de vision|no veo|destellos|moscas volantes|cortina|secrecion|lagrimeo|hinch\w*|inflam\w*|golpe|trauma|quimic\w*|sangrado)\b/.test(
    normalized
  );
}

export function requiresFreshAvailability(body: string, hasAvailabilityContext = false): boolean {
  if (isExplicitConfirmation(body)) return false;
  const normalized = normalizeForIntent(body);
  if (/\b(cancel\w*|anul\w*)\b/.test(normalized)) return false;
  if (/\b(mis citas|que citas|consult\w* citas)\b/.test(normalized)) return false;

  const availabilityRequest = /\b(disponib\w*|horarios?|cupos?|turnos?|espacios?|atend\w*)\b/.test(normalized);
  const schedulingRequest = /\b(citas?|agend\w*|reserv\w*|reagend\w*)\b/.test(normalized);
  const temporalReference =
    /\b(hoy|manana|pasado manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|fecha|dia|semana|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/.test(
      normalized
    ) ||
    /\b\d{1,2}(?:\s+\d{2})?\s*(?:a\s*m|p\s*m|am|pm)\b/.test(normalized) ||
    /\b(temprano|en la manana|en la tarde)\b/.test(normalized);
  const contextualSelection =
    hasAvailabilityContext &&
    (/\b(primer\w*|segund\w*|tercer\w*|ese|esa|aquel|aquella|el de|la de|prefiero|me sirve|esta bien|de acuerdo)\b/.test(
      normalized
    ) ||
      temporalReference);

  return availabilityRequest || (schedulingRequest && temporalReference) || contextualSelection;
}

export function sanitizeSofiaState(
  value: unknown,
  now = Date.now()
): {
  state: Record<string, unknown>;
  availabilityStatus: "absent" | "valid" | "invalid";
} {
  if (!isRecord(value)) return { state: {}, availabilityStatus: "absent" };
  const state = { ...value };
  const availabilityKeys = [
    "lastAvailability",
    "lastAvailabilityAt",
    "lastAvailabilitySchemaVersion",
    "lastAvailabilityJobId"
  ] as const;
  const hasAvailabilityContext = availabilityKeys.some((key) => Object.prototype.hasOwnProperty.call(state, key));
  if (!hasAvailabilityContext) return { state, availabilityStatus: "absent" };

  const timestamp = typeof state.lastAvailabilityAt === "string" ? Date.parse(state.lastAvailabilityAt) : Number.NaN;
  const availability = state.lastAvailability;
  const valid =
    state.lastAvailabilitySchemaVersion === AVAILABILITY_CONTEXT_SCHEMA_VERSION &&
    isRecord(availability) &&
    Array.isArray(availability.slots) &&
    availability.slots.every((slot) => authoritativeAvailabilitySlotSchema.safeParse(slot).success) &&
    Number.isFinite(timestamp) &&
    timestamp <= now + 60_000 &&
    now - timestamp <= AVAILABILITY_CONTEXT_TTL_MS;
  if (valid) return { state, availabilityStatus: "valid" };

  for (const key of availabilityKeys) delete state[key];
  return { state, availabilityStatus: "invalid" };
}

function inferIntent(toolNames: string[]): string | undefined {
  if (toolNames.includes("cancel_appointment")) return "cancel_appointment";
  if (toolNames.includes("reschedule_appointment")) return "reschedule_appointment";
  if (toolNames.includes("book_appointment")) return "book_appointment";
  if (toolNames.includes("search_availability")) return "search_availability";
  if (toolNames.includes("list_patient_appointments")) return "list_appointments";
  return undefined;
}

function deterministicFallback(): string {
  return "En este momento no pude completar la consulta. No voy a inventar información. Intenta nuevamente en unos minutos.";
}

function availabilityFallback(): string {
  return "En este momento no pude consultar la disponibilidad actual. No voy a ofrecer horarios sin verificarlos. Intenta nuevamente en unos minutos.";
}

export function hasUnverifiedAvailabilityClock(
  response: string,
  slots: Array<z.infer<typeof authoritativeAvailabilitySlotSchema>>
): boolean {
  const allowed = new Set(slots.map((slot) => slot.localTime));
  return extractClockTimes(response).some((time) => !allowed.has(time));
}

export function matchesAuthoritativeAvailabilitySlot(
  rawArguments: string,
  slots: Array<z.infer<typeof authoritativeAvailabilitySlotSchema>>
): boolean {
  return findAuthoritativeAvailabilitySlot(rawArguments, slots) !== undefined;
}

function findAuthoritativeAvailabilitySlot(
  rawArguments: string,
  slots: Array<z.infer<typeof authoritativeAvailabilitySlotSchema>>
): z.infer<typeof authoritativeAvailabilitySlotSchema> | undefined {
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(rawArguments);
  } catch {
    return undefined;
  }
  const parsed = z
    .object({
      siteId: z.string().uuid(),
      professionalId: z.string().uuid(),
      payerId: z.string().uuid(),
      appointmentTypeId: z.string().uuid(),
      scheduledAt: z.string().datetime()
    })
    .safeParse(argumentsValue);
  if (!parsed.success) return undefined;
  const scheduledAt = new Date(parsed.data.scheduledAt).getTime();
  return slots.find(
    (slot) =>
      slot.siteId === parsed.data.siteId &&
      slot.professionalId === parsed.data.professionalId &&
      slot.payerId === parsed.data.payerId &&
      slot.appointmentTypeId === parsed.data.appointmentTypeId &&
      new Date(slot.scheduledAt).getTime() === scheduledAt
  );
}

function isSlotMutation(toolName: string): boolean {
  return toolName === "create_appointment_hold" || toolName === "reschedule_appointment";
}

function renderAuthoritativeAvailability(slots: Array<z.infer<typeof authoritativeAvailabilitySlotSchema>>): string {
  if (slots.length === 0) {
    return "Consulté nuevamente la agenda y no encontré disponibilidad para esa solicitud. Puedo revisar otra fecha.";
  }
  const options = slots
    .slice(0, 5)
    .map(
      (slot) =>
        `- ${slot.localDate} a las ${formatLocalClock(slot.localTime)}: ${slot.appointmentTypeName}, ${slot.siteName}, con ${slot.professionalName}${slot.payerName ? `, convenio ${slot.payerName}` : ""}`
    )
    .join("\n");
  return `Consulté nuevamente la agenda. Estos son los horarios disponibles en hora local:\n${options}\n¿Cuál prefieres?`;
}

function renderAuthoritativeConfirmation(
  slot: z.infer<typeof authoritativeAvailabilitySlotSchema>,
  action: "book" | "reschedule"
): string {
  const verb = action === "reschedule" ? "reagendar tu cita" : "agendar tu cita";
  const payer = slot.payerName ? `, convenio ${slot.payerName}` : "";
  return `Encontré el horario solicitado: ${slot.appointmentTypeName} en ${slot.siteName}, con ${slot.professionalName}${payer}, el ${slot.localDate} a las ${formatLocalClock(slot.localTime)} (${slot.timeZone}). ¿Confirmas que deseas ${verb} con estos datos? Responde CONFIRMO para continuar.`;
}

function extractClockTimes(value: string): string[] {
  const times: string[] = [];
  const pattern = /\b(\d{1,2})(?::(\d{2}))?\s*(a\s*\.?\s*m\s*\.?|p\s*\.?\s*m\s*\.?)?/gi;
  for (const match of value.matchAll(pattern)) {
    if (match[2] === undefined && match[3] === undefined) continue;
    let hour = Number(match[1]);
    const minute = Number(match[2] ?? 0);
    if (hour > 23 || minute > 59) continue;
    const meridiem = match[3]?.replace(/[^apm]/gi, "").toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    times.push(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
  }
  return times;
}

function formatLocalClock(value: string): string {
  const [rawHour, minute] = value.split(":");
  const hour = Number(rawHour);
  const meridiem = hour >= 12 ? "p. m." : "a. m.";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${minute} ${meridiem}`;
}

function normalizeForIntent(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function boundText(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 2_000 ? trimmed : `${trimmed.slice(0, 1_997)}...`;
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b\d{8,15}\b/g, "[redacted]")
    .slice(0, 200);
}

function hasInternalToken(authorization: string | undefined, expected: string): boolean {
  if (!authorization?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorization.slice(7).trim());
  const target = Buffer.from(expected);
  return supplied.length === target.length && timingSafeEqual(supplied, target);
}
