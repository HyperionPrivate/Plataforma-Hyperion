import { randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseClient } from "@hyperion/database";
import type { RouteRegistrar } from "@hyperion/service-runtime";
import { z } from "zod";
import {
  extractAgendaRequestConstraints,
  isLocalDateTimeAtOrBeforeNow,
  type AgendaRequestConstraints
} from "./availability-request-constraints.js";
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

const AVAILABILITY_CONTEXT_SCHEMA_VERSION = 3;
const AVAILABILITY_CONTEXT_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_AGENDA_TIME_ZONE = "America/Bogota";
const availabilitySearchArgumentsSchema = z.object({
  from: z.string().datetime().optional(),
  localDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  localTime: z
    .string()
    .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
    .optional(),
  days: z.number().int().min(1).max(31).optional(),
  siteId: z.string().uuid().optional(),
  professionalId: z.string().uuid().optional(),
  payerId: z.string().uuid().optional(),
  appointmentTypeId: z.string().uuid().optional()
});
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
const successfulAppointmentListResultSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    appointments: z.array(
      z.object({
        id: z.string().uuid(),
        status: z.string().min(1),
        scheduledAt: z.string().datetime().nullable().optional()
      })
    )
  })
});
const RESCHEDULABLE_APPOINTMENT_STATUSES = new Set([
  "pending_external_confirmation",
  "verified",
  "confirmed",
  "deferred",
  "verification_failed"
]);

type AvailabilitySearchArguments = z.infer<typeof availabilitySearchArgumentsSchema>;
type AuthoritativeAvailabilitySlot = z.infer<typeof authoritativeAvailabilitySlotSchema>;
type AgendaSelection = Partial<
  Pick<AvailabilitySearchArguments, "siteId" | "professionalId" | "payerId" | "appointmentTypeId">
>;

interface CatalogEntity {
  id: string;
  name: string;
}

interface CatalogIndex {
  sites: CatalogEntity[];
  professionals: CatalogEntity[];
  payers: CatalogEntity[];
  appointmentTypes: CatalogEntity[];
}

interface AvailabilityRuntimeContext {
  timeZone: string;
  state: Record<string, unknown>;
  catalog: unknown;
}

interface DerivedAgendaSelection {
  selection: AgendaSelection;
  unresolvedChangedDimensions: Array<keyof AgendaSelection>;
}

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
    let responseText: string | undefined;
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
        const requestConstraints = extractAgendaRequestConstraints(currentBody, {
          now: new Date(input.occurredAt),
          timeZone: context.availabilityRuntime.timeZone
        });
        const catalogIndex = buildCatalogIndex(context.availabilityRuntime.catalog);
        const derivedAgendaSelection = deriveAgendaSelection(
          currentBody,
          requestConstraints,
          context.availabilityRuntime,
          catalogIndex
        );
        const agendaSelection = derivedAgendaSelection.selection;
        const previousAvailabilityQuery = readLastAvailabilityQuery(context.availabilityRuntime.state, catalogIndex);
        const missingAgendaDimensions = missingMinimumAgendaSelection(agendaSelection);
        let availabilitySearchAttempted = false;
        let freshAvailabilitySucceeded = false;
        let freshAvailability: z.infer<typeof successfulAvailabilityResultSchema>["data"] | undefined;
        let freshAvailabilityQuery: AvailabilitySearchArguments | undefined;
        let preparedAvailabilitySlot: z.infer<typeof authoritativeAvailabilitySlotSchema> | undefined;
        let preparedAvailabilityAction: "book" | "reschedule" | undefined;
        if (freshAvailabilityRequired && requestConstraints.invalidReason) {
          executionStatus = "fallback";
          responseText = agendaConstraintFallback(requestConstraints.invalidReason);
        } else if (freshAvailabilityRequired && derivedAgendaSelection.unresolvedChangedDimensions.length > 0) {
          responseText = agendaDimensionClarification(derivedAgendaSelection.unresolvedChangedDimensions);
        } else if (freshAvailabilityRequired && missingAgendaDimensions.length > 0) {
          responseText = agendaSelectionClarification(missingAgendaDimensions);
        }
        roundLoop: for (let round = 0; responseText === undefined && round < 6; round += 1) {
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
            let effectiveArguments = toolCall.arguments;
            let canonicalSearch: AvailabilitySearchArguments | undefined;
            if (toolCall.name === "search_availability") {
              availabilitySearchAttempted = true;
              freshAvailabilitySucceeded = false;
              freshAvailability = undefined;
              const canonical = canonicalizeAvailabilitySearchArguments(
                toolCall.arguments,
                requestConstraints,
                agendaSelection,
                catalogIndex,
                previousAvailabilityQuery,
                { now: new Date(input.occurredAt), timeZone: context.availabilityRuntime.timeZone }
              );
              if (!canonical.ok) {
                messages.push({
                  role: "tool",
                  toolCallId: toolCall.id,
                  content: JSON.stringify({ ok: false, code: canonical.code, message: canonical.message })
                });
                continue;
              }
              canonicalSearch = canonical.arguments;
              effectiveArguments = JSON.stringify(canonical.arguments);
            }
            if (
              !isExplicitConfirmation(currentBody) &&
              isSlotMutation(toolCall.name) &&
              (!hasMinimumAgendaSelection(freshAvailabilityQuery) ||
                !matchesAuthoritativeAvailabilitySlot(
                  effectiveArguments,
                  mutationEligibleSlots(freshAvailability?.slots ?? [], freshAvailabilityQuery)
                ))
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
              ? findAuthoritativeAvailabilitySlot(
                  effectiveArguments,
                  mutationEligibleSlots(freshAvailability?.slots ?? [], freshAvailabilityQuery)
                )
              : undefined;
            toolNames.push(toolCall.name);
            const result = await this.tools.execute(toolCall.name, effectiveArguments, {
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
              if (
                parsedAvailability.success &&
                canonicalSearch &&
                availabilityMatchesSearch(parsedAvailability.data.data.slots, canonicalSearch)
              ) {
                freshAvailabilitySucceeded = true;
                freshAvailability = parsedAvailability.data.data;
                freshAvailabilityQuery = canonicalSearch;
                const exactSlots = canonicalSearch.localTime
                  ? freshAvailability.slots.filter((slot) => slot.localTime === canonicalSearch.localTime)
                  : [];
                if (
                  requestConstraints.bookingIntent &&
                  !requestConstraints.rescheduleIntent &&
                  canonicalSearch.localDate &&
                  canonicalSearch.localTime &&
                  hasMinimumAgendaSelection(canonicalSearch)
                ) {
                  const exactSlot = exactSlots.length === 1 ? exactSlots[0] : undefined;
                  if (exactSlot?.payerId) {
                    toolNames.push("create_appointment_hold");
                    const staged = await this.tools.execute(
                      "create_appointment_hold",
                      JSON.stringify({
                        siteId: exactSlot.siteId,
                        professionalId: exactSlot.professionalId,
                        payerId: exactSlot.payerId,
                        appointmentTypeId: exactSlot.appointmentTypeId,
                        scheduledAt: exactSlot.scheduledAt
                      }),
                      {
                        tenantId: job.tenantId,
                        patientId: input.patientId,
                        conversationId: job.conversationId,
                        currentMessageId: input.messageId,
                        currentMessageBody: currentBody,
                        jobId: job.id,
                        sequence: toolNames.length
                      }
                    );
                    if (isRecord(staged) && staged.code === "explicit_confirmation_required") {
                      preparedAvailabilitySlot = exactSlot;
                      preparedAvailabilityAction = "book";
                      responseText = renderAuthoritativeConfirmation(exactSlot, "book");
                    } else {
                      executionStatus = "fallback";
                      responseText = deterministicFallback();
                    }
                    break roundLoop;
                  }
                }
                const canPrepareReschedule =
                  requestConstraints.rescheduleIntent &&
                  canonicalSearch.localDate !== undefined &&
                  canonicalSearch.localTime !== undefined &&
                  exactSlots.length === 1 &&
                  hasMinimumAgendaSelection(canonicalSearch);
                if (canPrepareReschedule) {
                  const exactSlot = exactSlots[0]!;
                  toolNames.push("list_patient_appointments");
                  const listed = await this.tools.execute("list_patient_appointments", "{}", {
                    tenantId: job.tenantId,
                    patientId: input.patientId,
                    conversationId: job.conversationId,
                    currentMessageId: input.messageId,
                    currentMessageBody: currentBody,
                    jobId: job.id,
                    sequence: toolNames.length
                  });
                  const parsedList = successfulAppointmentListResultSchema.safeParse(listed);
                  const occurredAt = new Date(input.occurredAt).getTime();
                  const activeAppointments = parsedList.success
                    ? parsedList.data.data.appointments.filter(
                        (appointment) =>
                          RESCHEDULABLE_APPOINTMENT_STATUSES.has(appointment.status) &&
                          typeof appointment.scheduledAt === "string" &&
                          new Date(appointment.scheduledAt).getTime() > occurredAt
                      )
                    : [];
                  if (!parsedList.success) {
                    executionStatus = "fallback";
                    responseText = deterministicFallback();
                  } else if (activeAppointments.length === 0) {
                    responseText =
                      "No encontré una cita activa que pueda reagendar. Puedo ayudarte a agendar una nueva.";
                  } else if (activeAppointments.length > 1) {
                    responseText =
                      "Tienes más de una cita futura activa. Por seguridad no elegiré una automáticamente; solicita apoyo de un coordinador para identificar la cita que deseas reagendar.";
                  } else if (
                    activeAppointments[0]!.scheduledAt &&
                    new Date(activeAppointments[0]!.scheduledAt!).getTime() ===
                      new Date(exactSlot.scheduledAt).getTime()
                  ) {
                    responseText =
                      "Tu cita ya está agendada en ese horario. Dime una hora diferente si deseas cambiarla.";
                  } else if (exactSlot.payerId) {
                    toolNames.push("reschedule_appointment");
                    const staged = await this.tools.execute(
                      "reschedule_appointment",
                      JSON.stringify({
                        appointmentId: activeAppointments[0]!.id,
                        siteId: exactSlot.siteId,
                        professionalId: exactSlot.professionalId,
                        payerId: exactSlot.payerId,
                        appointmentTypeId: exactSlot.appointmentTypeId,
                        scheduledAt: exactSlot.scheduledAt,
                        reason: "Solicitud explícita del paciente"
                      }),
                      {
                        tenantId: job.tenantId,
                        patientId: input.patientId,
                        conversationId: job.conversationId,
                        currentMessageId: input.messageId,
                        currentMessageBody: currentBody,
                        jobId: job.id,
                        sequence: toolNames.length
                      }
                    );
                    if (isRecord(staged) && staged.code === "explicit_confirmation_required") {
                      preparedAvailabilitySlot = exactSlot;
                      preparedAvailabilityAction = "reschedule";
                      responseText = renderAuthoritativeConfirmation(exactSlot, "reschedule");
                    } else {
                      executionStatus = "fallback";
                      responseText = deterministicFallback();
                    }
                  } else {
                    executionStatus = "fallback";
                    responseText = deterministicFallback();
                  }
                  break roundLoop;
                }
                if (canonicalSearch.localDate) {
                  responseText = renderAuthoritativeAvailability(freshAvailability.slots);
                  break roundLoop;
                }
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

    const boundedResponse = boundText(responseText ?? deterministicFallback());
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
  ): Promise<{
    messages: LlmMessage[];
    hadAvailabilityContext: boolean;
    availabilityRuntime: AvailabilityRuntimeContext;
  }> {
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
    const timeZone = readCatalogTimeZone(catalog);
    const runtimeContext = {
      now: new Date(now).toISOString(),
      timezone: timeZone,
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
      hadAvailabilityContext: sanitized.availabilityStatus !== "absent",
      availabilityRuntime: {
        timeZone,
        state: sanitized.state,
        catalog
      }
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
       where selected.runtime_key = 'sofia_whatsapp_internal_v5'
         and exists (
           select 1 from platform.schema_migrations
           where name = '016-sofia-search-constraints.sql'
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
    "lastAvailabilityJobId",
    "lastAvailabilityQuery"
  ] as const;
  const hasAvailabilityContext = availabilityKeys.some((key) => Object.prototype.hasOwnProperty.call(state, key));
  if (!hasAvailabilityContext) return { state, availabilityStatus: "absent" };

  const timestamp = typeof state.lastAvailabilityAt === "string" ? Date.parse(state.lastAvailabilityAt) : Number.NaN;
  const availability = state.lastAvailability;
  const query = availabilitySearchArgumentsSchema.safeParse(state.lastAvailabilityQuery);
  const slots =
    isRecord(availability) && Array.isArray(availability.slots)
      ? availability.slots
          .map((slot) => authoritativeAvailabilitySlotSchema.safeParse(slot))
          .filter((result): result is { success: true; data: AuthoritativeAvailabilitySlot } => result.success)
          .map((result) => result.data)
      : [];
  const valid =
    state.lastAvailabilitySchemaVersion === AVAILABILITY_CONTEXT_SCHEMA_VERSION &&
    isRecord(availability) &&
    Array.isArray(availability.slots) &&
    slots.length === availability.slots.length &&
    query.success &&
    availabilityMatchesSearch(slots, query.data) &&
    Number.isFinite(timestamp) &&
    timestamp <= now + 60_000 &&
    now - timestamp <= AVAILABILITY_CONTEXT_TTL_MS;
  if (valid) return { state, availabilityStatus: "valid" };

  for (const key of availabilityKeys) delete state[key];
  return { state, availabilityStatus: "invalid" };
}

export function canonicalizeAvailabilitySearchArguments(
  rawArguments: string,
  constraints: AgendaRequestConstraints,
  selection: AgendaSelection,
  catalog: CatalogIndex,
  previousQuery?: AvailabilitySearchArguments,
  clock?: { now: Date; timeZone: string }
): { ok: true; arguments: AvailabilitySearchArguments } | { ok: false; code: string; message: string } {
  if (constraints.invalidReason) {
    return {
      ok: false,
      code: "invalid_patient_date_constraint",
      message: "La fecha u hora expresada por el paciente requiere aclaración."
    };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawArguments || "{}");
  } catch {
    return { ok: false, code: "invalid_arguments", message: "Argumentos JSON inválidos." };
  }
  const parsed = availabilitySearchArgumentsSchema.safeParse(decoded);
  if (!parsed.success) {
    return { ok: false, code: "invalid_arguments", message: "Argumentos de disponibilidad inválidos." };
  }
  const argumentsValue: AvailabilitySearchArguments = { ...parsed.data };
  const entitySets: Record<keyof AgendaSelection, Set<string>> = {
    siteId: new Set(catalog.sites.map((entity) => entity.id)),
    professionalId: new Set(catalog.professionals.map((entity) => entity.id)),
    payerId: new Set(catalog.payers.map((entity) => entity.id)),
    appointmentTypeId: new Set(catalog.appointmentTypes.map((entity) => entity.id))
  };
  for (const key of ["siteId", "professionalId", "payerId", "appointmentTypeId"] as const) {
    const supplied = argumentsValue[key];
    const selected = selection[key];
    if (selected && !entitySets[key].has(selected)) {
      return {
        ok: false,
        code: "invalid_catalog_reference",
        message: "La búsqueda contiene una referencia que no pertenece al catálogo del tenant."
      };
    }
    if (selected) {
      argumentsValue[key] = selected;
    } else if (supplied) {
      if (key === "professionalId") {
        delete argumentsValue.professionalId;
        continue;
      }
      return {
        ok: false,
        code: "untrusted_catalog_reference",
        message: "La referencia de catálogo no fue seleccionada por el paciente ni por el estado estructurado."
      };
    }
  }

  let localDate: string | undefined;
  let localTime: string | undefined;
  if (constraints.localDate) {
    localDate = constraints.localDate;
    localTime = constraints.localTime;
  } else if (constraints.localTime) {
    if (!previousQuery?.localDate) {
      return {
        ok: false,
        code: "missing_structured_date",
        message: "La hora requiere una fecha seleccionada previamente o expresada en el mensaje actual."
      };
    }
    localDate = previousQuery.localDate;
    localTime = constraints.localTime;
  } else if (previousQuery?.localDate) {
    localDate = previousQuery.localDate;
    localTime = previousQuery.localTime;
  } else if (argumentsValue.localDate || argumentsValue.from) {
    return {
      ok: false,
      code: "untrusted_date_reference",
      message: "La fecha debe provenir del mensaje actual o del estado estructurado."
    };
  }

  delete argumentsValue.from;
  delete argumentsValue.localDate;
  delete argumentsValue.localTime;
  if (localDate) {
    argumentsValue.localDate = localDate;
    argumentsValue.days = 1;
    if (localTime) argumentsValue.localTime = localTime;
  }
  if (
    clock &&
    argumentsValue.localDate &&
    argumentsValue.localTime &&
    isLocalDateTimeAtOrBeforeNow(argumentsValue.localDate, argumentsValue.localTime, clock)
  ) {
    return {
      ok: false,
      code: "past_patient_date_constraint",
      message: "La fecha y hora seleccionadas ya pasaron en la zona horaria de la agenda."
    };
  }
  return { ok: true, arguments: argumentsValue };
}

export function availabilityMatchesSearch(
  slots: AuthoritativeAvailabilitySlot[],
  search: AvailabilitySearchArguments
): boolean {
  if (search.localTime && !search.localDate) return false;
  return slots.every(
    (slot) =>
      (!search.localDate || slot.localDate === search.localDate) &&
      (!search.localTime || slot.localTime >= search.localTime) &&
      (!search.siteId || slot.siteId === search.siteId) &&
      (!search.professionalId || slot.professionalId === search.professionalId) &&
      (!search.payerId || slot.payerId === search.payerId) &&
      (!search.appointmentTypeId || slot.appointmentTypeId === search.appointmentTypeId)
  );
}

export function deriveAgendaSelection(
  currentBody: string,
  constraints: AgendaRequestConstraints,
  runtime: AvailabilityRuntimeContext,
  catalog: CatalogIndex
): DerivedAgendaSelection {
  const explicit = findCatalogSelection(currentBody, catalog);
  const query = readLastAvailabilityQuery(runtime.state, catalog);
  const stored = readStoredAgendaSelection(runtime.state, catalog);
  const homogeneous = readHomogeneousAvailabilitySelection(runtime.state, catalog);
  const changed = constraints.requestsChange
    ? detectChangedAgendaDimensions(currentBody)
    : new Set<keyof AgendaSelection>();
  const selection: AgendaSelection = {};
  const unresolvedChangedDimensions: Array<keyof AgendaSelection> = [];
  for (const key of ["siteId", "professionalId", "payerId", "appointmentTypeId"] as const) {
    if (changed.has(key)) {
      if (explicit[key]) selection[key] = explicit[key];
      else unresolvedChangedDimensions.push(key);
      continue;
    }
    selection[key] = explicit[key] ?? query?.[key] ?? homogeneous[key] ?? stored[key];
  }
  return { selection, unresolvedChangedDimensions };
}

function findCatalogSelection(value: string, catalog: CatalogIndex): AgendaSelection {
  const normalized = normalizeForIntent(value);
  return {
    siteId: findUniqueEntityMention(normalized, catalog.sites),
    professionalId: findUniqueEntityMention(normalized, catalog.professionals),
    payerId: findUniqueEntityMention(normalized, catalog.payers),
    appointmentTypeId: findUniqueEntityMention(normalized, catalog.appointmentTypes)
  };
}

function findUniqueEntityMention(value: string, entities: CatalogEntity[]): string | undefined {
  const matches = entities.filter((entity) => {
    const name = normalizeForIntent(entity.name);
    return name.length >= 3 && value.includes(name);
  });
  return matches.length === 1 ? matches[0]!.id : undefined;
}

function readLastAvailabilityQuery(
  state: Record<string, unknown>,
  catalog: CatalogIndex
): AvailabilitySearchArguments | undefined {
  const parsed = availabilitySearchArgumentsSchema.safeParse(state.lastAvailabilityQuery);
  if (!parsed.success) return undefined;
  const trustedSelection = validateAgendaSelection(parsed.data, catalog);
  return {
    ...parsed.data,
    siteId: trustedSelection.siteId,
    professionalId: trustedSelection.professionalId,
    payerId: trustedSelection.payerId,
    appointmentTypeId: trustedSelection.appointmentTypeId
  };
}

function detectChangedAgendaDimensions(value: string): Set<keyof AgendaSelection> {
  const normalized = normalizeForIntent(value);
  const changed = new Set<keyof AgendaSelection>();
  const dimensions: Array<[keyof AgendaSelection, string]> = [
    ["siteId", "sede"],
    ["payerId", "convenio"],
    ["professionalId", "(?:profesional|doctor|doctora|optometra|oftalmologo)"],
    ["appointmentTypeId", "tipo(?:\\s+de\\s+cita)?"]
  ];
  for (const [key, term] of dimensions) {
    const pattern = new RegExp(
      `\\b(?:otra|otro|diferente|distinta|distinto|nueva|nuevo)\\s+${term}\\b|` +
        `\\b${term}\\s+(?:diferente|distinta|distinto|nueva|nuevo)\\b|` +
        `\\b(?:cambiar|cambio)\\s+(?:de|el|la)?\\s*${term}\\b`
    );
    if (pattern.test(normalized)) changed.add(key);
  }
  return changed;
}

function readStoredAgendaSelection(state: Record<string, unknown>, catalog: CatalogIndex): AgendaSelection {
  if (!isRecord(state.agendaSelection)) return {};
  return validateAgendaSelection(state.agendaSelection, catalog);
}

function readHomogeneousAvailabilitySelection(state: Record<string, unknown>, catalog: CatalogIndex): AgendaSelection {
  if (!isRecord(state.lastAvailability) || !Array.isArray(state.lastAvailability.slots)) return {};
  const slots = state.lastAvailability.slots
    .map((slot) => authoritativeAvailabilitySlotSchema.safeParse(slot))
    .filter((result): result is { success: true; data: AuthoritativeAvailabilitySlot } => result.success)
    .map((result) => result.data);
  if (slots.length === 0) return {};
  const candidate: Record<string, unknown> = {};
  for (const key of ["siteId", "professionalId", "payerId", "appointmentTypeId"] as const) {
    const values = new Set(
      slots.map((slot) => slot[key]).filter((value): value is string => typeof value === "string")
    );
    if (values.size === 1) candidate[key] = [...values][0];
  }
  return validateAgendaSelection(candidate, catalog);
}

function validateAgendaSelection(value: Record<string, unknown>, catalog: CatalogIndex): AgendaSelection {
  const allowed: Record<keyof AgendaSelection, Set<string>> = {
    siteId: new Set(catalog.sites.map((entity) => entity.id)),
    professionalId: new Set(catalog.professionals.map((entity) => entity.id)),
    payerId: new Set(catalog.payers.map((entity) => entity.id)),
    appointmentTypeId: new Set(catalog.appointmentTypes.map((entity) => entity.id))
  };
  const selection: AgendaSelection = {};
  for (const key of ["siteId", "professionalId", "payerId", "appointmentTypeId"] as const) {
    const id = value[key];
    if (typeof id === "string" && allowed[key].has(id)) selection[key] = id;
  }
  return selection;
}

function buildCatalogIndex(value: unknown): CatalogIndex {
  return {
    sites: readCatalogEntities(value, "sites"),
    professionals: readCatalogEntities(value, "professionals"),
    payers: readCatalogEntities(value, "payers"),
    appointmentTypes: readCatalogEntities(value, "appointmentTypes")
  };
}

function readCatalogEntities(value: unknown, key: string): CatalogEntity[] {
  if (!isRecord(value) || !Array.isArray(value[key])) return [];
  return value[key]
    .map((entry) => z.object({ id: z.string().uuid(), name: z.string().min(1) }).safeParse(entry))
    .filter((result): result is { success: true; data: CatalogEntity } => result.success)
    .map((result) => result.data);
}

function readCatalogTimeZone(value: unknown): string {
  const candidate =
    isRecord(value) && isRecord(value.agendaSettings) && typeof value.agendaSettings.timezone === "string"
      ? value.agendaSettings.timezone
      : DEFAULT_AGENDA_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format();
    return candidate;
  } catch {
    return DEFAULT_AGENDA_TIME_ZONE;
  }
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

function agendaConstraintFallback(reason: NonNullable<AgendaRequestConstraints["invalidReason"]>): string {
  if (reason === "past_date" || reason === "past_datetime") {
    return "La fecha u hora indicada ya pasó. Dime una fecha y hora futuras para consultar la agenda.";
  }
  if (reason === "weekday_mismatch") {
    return "El día de la semana no coincide con la fecha indicada. Confírmame la fecha exacta antes de consultar.";
  }
  return "No pude determinar una única fecha y hora válidas. Escríbelas de forma exacta, por ejemplo: 13 de julio de 2026 a las 9:00 a. m.";
}

function agendaDimensionClarification(dimensions: Array<keyof AgendaSelection>): string {
  const labels: Record<keyof AgendaSelection, string> = {
    siteId: "la sede",
    professionalId: "el profesional",
    payerId: "el convenio",
    appointmentTypeId: "el tipo de cita"
  };
  const requested = dimensions.map((dimension) => labels[dimension]).join(", ");
  return `Indícame exactamente ${requested} que deseas cambiar antes de consultar nuevamente.`;
}

function agendaSelectionClarification(dimensions: Array<keyof AgendaSelection>): string {
  const labels: Record<keyof AgendaSelection, string> = {
    siteId: "la sede",
    professionalId: "el profesional",
    payerId: "el convenio",
    appointmentTypeId: "el tipo de cita"
  };
  const requested = dimensions.map((dimension) => labels[dimension]).join(", ");
  return `Antes de consultar la agenda, necesito que indiques ${requested}. No voy a elegir esos datos por ti.`;
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

function hasMinimumAgendaSelection(search?: AvailabilitySearchArguments): boolean {
  return missingMinimumAgendaSelection(search).length === 0;
}

function missingMinimumAgendaSelection(search?: AvailabilitySearchArguments): Array<keyof AgendaSelection> {
  return (["siteId", "payerId", "appointmentTypeId"] as const).filter((key) => !search?.[key]);
}

function mutationEligibleSlots(
  slots: AuthoritativeAvailabilitySlot[],
  search?: AvailabilitySearchArguments
): AuthoritativeAvailabilitySlot[] {
  if (!search?.localTime) return slots;
  return slots.filter((slot) => slot.localTime === search.localTime);
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
