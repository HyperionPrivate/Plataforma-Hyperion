import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "@hyperion/database";
import {
  createInternalAuthorizationHeaders,
  isCiDeploymentEnvironment,
  validateInternalAuthorization,
  type RouteRegistrar
} from "@hyperion/service-runtime";
import { z } from "zod";
import {
  extractAgendaRequestConstraints,
  isLocalDateTimeAtOrBeforeNow,
  type AgendaRequestConstraints
} from "./availability-request-constraints.js";
import type { LlmMessage, LlmProvider } from "./llm-provider.js";
import {
  createPulsoSofiaContextClient,
  PulsoSofiaContextDependencyError,
  type PulsoSofiaContextClient
} from "./pulso-sofia-context-client.js";
import {
  isExplicitConfirmation,
  SOFIA_TOOL_DEFINITIONS,
  SofiaToolClient,
  type SofiaConfirmationAppointment,
  type SofiaConfirmationResult,
  type SofiaConfirmedAction
} from "./sofia-tools.js";

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
        scheduledAt: z.string().datetime().nullable().optional(),
        localDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .optional(),
        localTime: z
          .string()
          .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
          .nullable()
          .optional(),
        timeZone: z.string().min(1).nullable().optional(),
        siteName: z.string().min(1).nullable().optional(),
        professionalName: z.string().min(1).nullable().optional(),
        payerName: z.string().min(1).nullable().optional(),
        appointmentTypeName: z.string().min(1).nullable().optional()
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

type AppointmentListItem = z.infer<typeof successfulAppointmentListResultSchema>["data"]["appointments"][number];

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

interface RecoverableConfirmationCandidate extends ClaimedJob {
  updatedAt: Date | string;
  createdAt: Date | string;
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
  auditToken?: string;
  channelToken?: string;
  promptFlowToken?: string;
  pulsoToken?: string;
  /** Test-only compatibility; production never falls back to this shared credential. */
  internalServiceToken?: string;
  channelUrl: string;
  promptFlowUrl: string;
  pulsoIrisUrl: string;
  auditUrl: string;
  fetchImpl?: typeof fetch;
  workerId?: string;
  pollIntervalMs?: number;
  inboundPollingEnabled?: boolean;
}

export class SofiaRuntime {
  private readonly fetchImpl: typeof fetch;
  private readonly workerId: string;
  private readonly tools: SofiaToolClient;
  private readonly pulsoContext: PulsoSofiaContextClient;
  private readonly pollIntervalMs: number;
  private ingestTimer?: NodeJS.Timeout;
  private jobTimer?: NodeJS.Timeout;
  private acceptingWork = false;
  private activeIngest?: Promise<void>;
  private activeJob?: Promise<void>;
  private stopPromise?: Promise<void>;
  private readonly shutdownController = new AbortController();
  private readonly credentials: {
    channel: string;
    promptFlow: string;
    pulso: string;
  };

  constructor(private readonly options: SofiaRuntimeOptions) {
    const legacyTestToken = isCiDeploymentEnvironment(process.env) ? options.internalServiceToken : undefined;
    this.credentials = {
      channel: requireWorkloadCredential(options.channelToken ?? legacyTestToken, "SOFIA_TO_CHANNEL_TOKEN"),
      promptFlow: requireWorkloadCredential(options.promptFlowToken ?? legacyTestToken, "SOFIA_TO_PROMPT_FLOW_TOKEN"),
      pulso: requireWorkloadCredential(options.pulsoToken ?? legacyTestToken, "SOFIA_TO_PULSO_TOKEN")
    };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.workerId = options.workerId ?? `sofia-${randomUUID()}`;
    this.pollIntervalMs = options.pollIntervalMs ?? 750;
    this.tools = new SofiaToolClient({
      pulsoIrisUrl: options.pulsoIrisUrl,
      pulsoToken: this.credentials.pulso,
      db: options.db,
      fetchImpl: this.fetchImpl,
      signal: this.shutdownController.signal
    });
    this.pulsoContext = createPulsoSofiaContextClient({
      pulsoIrisUrl: options.pulsoIrisUrl,
      credential: this.credentials.pulso,
      fetch: this.fetchImpl,
      signal: this.shutdownController.signal
    });
  }

  start(): void {
    if (this.acceptingWork || this.stopPromise) return;
    this.acceptingWork = true;
    if (this.options.inboundPollingEnabled ?? true) {
      this.ingestTimer = setInterval(() => void this.ingestTick(), this.pollIntervalMs);
      this.ingestTimer.unref();
      void this.ingestTick();
    }
    this.jobTimer = setInterval(() => void this.jobTick(), this.pollIntervalMs);
    this.jobTimer.unref();
    void this.jobTick();
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.acceptingWork = false;
    this.shutdownController.abort(new SofiaShutdownError());
    if (this.ingestTimer) clearInterval(this.ingestTimer);
    if (this.jobTimer) clearInterval(this.jobTimer);
    this.ingestTimer = undefined;
    this.jobTimer = undefined;

    const activeOperations = [this.activeIngest, this.activeJob].filter((operation): operation is Promise<void> =>
      Boolean(operation)
    );
    this.stopPromise = Promise.all(activeOperations).then(() => undefined);
    return this.stopPromise;
  }

  isRunning(): boolean {
    return Boolean(
      this.acceptingWork && this.jobTimer && (!(this.options.inboundPollingEnabled ?? true) || this.ingestTimer)
    );
  }

  async ingestOnce(): Promise<number> {
    if (this.shutdownController.signal.aborted) return 0;
    const payload = await this.callChannel("/internal/v1/whatsapp/inbound/claim", "POST", {
      workerId: this.workerId,
      limit: 5
    });
    const events = z.object({ events: z.array(inboundEventSchema) }).parse(payload).events;
    for (const event of events) {
      try {
        this.throwIfShuttingDown();
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
          await this.setConversationRuntime(event.tenantId, identity.conversationId, "queued");
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
    if (this.shutdownController.signal.aborted) return false;
    const recovered = await this.claimRecoverableConfirmationJob();
    const claimed = recovered
      ? undefined
      : await this.options.db.query<ClaimedJob>(
          `select id, tenant_id as "tenantId", conversation_id as "conversationId",
                  inbound_event_id as "inboundEventId", attempt_count as "attemptCount",
                  max_attempts as "maxAttempts", input
           from agent_runtime.claim_next_job($1)`,
          [this.workerId]
        );
    const job = recovered ?? claimed?.rows[0];
    if (!job) return false;
    try {
      this.throwIfShuttingDown();
      await this.processJob(job);
    } catch (error) {
      await this.failJob(job, error);
    }
    return true;
  }

  private async claimRecoverableConfirmationJob(): Promise<ClaimedJob | undefined> {
    let cursor: Pick<RecoverableConfirmationCandidate, "updatedAt" | "createdAt" | "id"> | undefined;
    for (;;) {
      const candidates = await this.options.db.query<RecoverableConfirmationCandidate>(
        `/* sofia-confirmation:recovery-candidates */
         select j.id, j.tenant_id as "tenantId", j.conversation_id as "conversationId",
                j.inbound_event_id as "inboundEventId", j.attempt_count as "attemptCount",
                j.max_attempts as "maxAttempts", j.input,
                j.updated_at as "updatedAt", j.created_at as "createdAt"
         from agent_runtime.jobs j
         where (
             j.status = 'dead_letter'
             or (j.status = 'running' and j.locked_at < now() - interval '2 minutes')
           )
           and j.attempt_count >= j.max_attempts
           and j.attempt_count < 10
           and (
             $1::timestamptz is null
             or (j.updated_at, j.created_at, j.id) > ($1::timestamptz, $2::timestamptz, $3::uuid)
           )
           and not exists (
             select 1
             from agent_runtime.jobs predecessor
             where predecessor.tenant_id = j.tenant_id
               and predecessor.stream_id = j.stream_id
               and predecessor.stream_sequence < j.stream_sequence
               and predecessor.status <> 'completed'
           )
         order by j.updated_at, j.created_at, j.id
         limit 10`,
        cursor ? [cursor.updatedAt, cursor.createdAt, cursor.id] : [null, null, null]
      );
      if (candidates.rows.length === 0) return undefined;

      for (const candidate of candidates.rows) {
        const input = jobInputSchema.safeParse(candidate.input);
        if (!input.success) continue;
        let inbound: Awaited<ReturnType<PulsoSofiaContextClient["lookupInbound"]>>;
        try {
          inbound = await this.pulsoContext.lookupInbound(candidate.tenantId, {
            conversationId: candidate.conversationId,
            messageId: input.data.messageId,
            patientId: input.data.patientId
          });
        } catch (error) {
          this.options.logger.warn("SOFIA confirmation recovery candidate lookup failed closed", {
            jobId: candidate.id,
            error: sanitizeError(error)
          });
          if (error instanceof PulsoSofiaContextDependencyError) return undefined;
          continue;
        }
        if (!inbound.found || !isExplicitConfirmation(inbound.message.body)) continue;

        const claimed = await this.options.db.query<ClaimedJob>(
          `/* sofia-confirmation:claim-recovered */
           update agent_runtime.jobs j
           set status = 'running',
               attempt_count = j.attempt_count + 1,
               max_attempts = least(10, greatest(j.max_attempts, j.attempt_count + 1)),
               locked_at = now(), locked_by = $1, completed_at = null, updated_at = now()
           where j.tenant_id = $2
             and j.id = $3
             and j.conversation_id = $4
             and j.input->>'messageId' = $5
             and j.input->>'patientId' = $6
             and (
               j.status = 'dead_letter'
               or (j.status = 'running' and j.locked_at < now() - interval '2 minutes')
             )
             and j.attempt_count >= j.max_attempts
             and j.attempt_count < 10
             and not exists (
               select 1
               from agent_runtime.jobs predecessor
               where predecessor.tenant_id = j.tenant_id
                 and predecessor.stream_id = j.stream_id
                 and predecessor.stream_sequence < j.stream_sequence
                 and predecessor.status <> 'completed'
             )
           returning j.id, j.tenant_id as "tenantId", j.conversation_id as "conversationId",
                     j.inbound_event_id as "inboundEventId", j.attempt_count as "attemptCount",
                     j.max_attempts as "maxAttempts", j.input`,
          [
            this.workerId,
            candidate.tenantId,
            candidate.id,
            candidate.conversationId,
            input.data.messageId,
            input.data.patientId
          ]
        );
        if (claimed.rows[0]) return claimed.rows[0];
      }

      const last = candidates.rows[candidates.rows.length - 1]!;
      cursor = { updatedAt: last.updatedAt, createdAt: last.createdAt, id: last.id };
    }
  }

  private ingestTick(): Promise<void> {
    if (!this.acceptingWork) return Promise.resolve();
    if (this.activeIngest) return this.activeIngest;

    const operation = this.runIngestTick();
    this.activeIngest = operation;
    void operation.finally(() => {
      if (this.activeIngest === operation) this.activeIngest = undefined;
    });
    return operation;
  }

  private async runIngestTick(): Promise<void> {
    try {
      await this.ingestOnce();
    } catch (error) {
      this.options.logger.warn("SOFIA inbound polling failed", { error: sanitizeError(error) });
    }
  }

  private jobTick(): Promise<void> {
    if (!this.acceptingWork) return Promise.resolve();
    if (this.activeJob) return this.activeJob;

    const operation = this.runJobTick();
    this.activeJob = operation;
    void operation.finally(() => {
      if (this.activeJob === operation) this.activeJob = undefined;
    });
    return operation;
  }

  private async runJobTick(): Promise<void> {
    try {
      for (let index = 0; this.acceptingWork && index < 5 && (await this.processOne()); index += 1) {
        // Drain a bounded batch and yield to the event loop.
      }
    } catch (error) {
      this.options.logger.warn("SOFIA job polling failed", { error: sanitizeError(error) });
    }
  }

  private async processJob(job: ClaimedJob): Promise<void> {
    this.throwIfShuttingDown();
    const input = jobInputSchema.parse(job.input);
    const current = await this.pulsoContext.lookupInbound(job.tenantId, {
      conversationId: job.conversationId,
      messageId: input.messageId,
      patientId: input.patientId
    });
    if (!current.found) throw new Error("Inbound message is missing or conflicts with the job identity");
    const currentMessage = current;
    const currentBody = current.message.body;
    const explicitConfirmation = isExplicitConfirmation(currentBody);

    await this.setConversationRuntime(job.tenantId, job.conversationId, "processing");
    const startedAt = Date.now();
    let prompt: PromptFlow | undefined;
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
      prompt = await this.loadPrompt(job.tenantId);
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
            this.throwIfShuttingDown();
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
        const cancellationRequest = isCancellationRequest(currentBody);
        const appointmentQuery = isAppointmentQuery(currentBody);
        let availabilitySearchAttempted = false;
        let freshAvailabilitySucceeded = false;
        let freshAvailability: z.infer<typeof successfulAvailabilityResultSchema>["data"] | undefined;
        let freshAvailabilityQuery: AvailabilitySearchArguments | undefined;
        let preparedAvailabilitySlot: z.infer<typeof authoritativeAvailabilitySlotSchema> | undefined;
        let preparedAvailabilityAction: "book" | "reschedule" | undefined;
        if (explicitConfirmation) {
          const confirmationContext = {
            tenantId: job.tenantId,
            patientId: input.patientId,
            conversationId: job.conversationId,
            currentMessageId: input.messageId,
            currentMessageBody: currentBody,
            jobId: job.id,
            sequence: 1
          };
          const confirmed = await this.tools.confirmPendingAction(confirmationContext);
          if (confirmed.ok) {
            if (!confirmed.replayed) toolNames.push(...confirmedActionToolNames(confirmed.action));
            responseText = renderAuthoritativeConfirmedAction(confirmed.receipt.appointment, confirmed.action);
          } else if (confirmed.status === "retryable_failure") {
            if (job.attemptCount < job.maxAttempts) throw new RetryableSofiaError(confirmed.code);
            const finalized = await this.tools.finalizePendingConfirmation(
              confirmationContext,
              "confirmation_retry_exhausted",
              "No pude comprobar que la operación se completara después de varios intentos. No voy a afirmar que se realizó; solicita apoyo de un coordinador para revisar su estado."
            );
            executionStatus = "fallback";
            responseText = confirmedActionFallback(finalized);
          } else {
            executionStatus = "fallback";
            responseText = confirmedActionFallback(confirmed);
          }
        } else if (cancellationRequest) {
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
          const now = Date.now();
          const activeAppointments = parsedList.success
            ? parsedList.data.data.appointments.filter(
                (appointment) =>
                  RESCHEDULABLE_APPOINTMENT_STATUSES.has(appointment.status) &&
                  typeof appointment.scheduledAt === "string" &&
                  new Date(appointment.scheduledAt).getTime() > now
              )
            : [];
          if (!parsedList.success) {
            executionStatus = "fallback";
            responseText = deterministicFallback();
          } else if (activeAppointments.length === 0) {
            responseText = "No encontré una cita futura activa que pueda cancelar.";
          } else if (activeAppointments.length > 1) {
            responseText =
              "Tienes más de una cita futura activa. Por seguridad no elegiré una automáticamente; solicita apoyo de un coordinador para identificar la cita que deseas cancelar.";
          } else {
            const appointment = activeAppointments[0]!;
            const confirmation = renderAuthoritativeCancellationConfirmation(appointment);
            if (!confirmation) {
              executionStatus = "fallback";
              responseText = deterministicFallback();
            } else {
              toolNames.push("cancel_appointment");
              const staged = await this.tools.execute(
                "cancel_appointment",
                JSON.stringify({
                  appointmentId: appointment.id,
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
                responseText = confirmation;
              } else {
                executionStatus = "fallback";
                responseText = deterministicFallback();
              }
            }
          }
        } else if (appointmentQuery) {
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
          if (!parsedList.success) {
            executionStatus = "fallback";
            responseText = deterministicFallback();
          } else {
            // Appointment state is operational data: a delayed/replayed inbound must
            // not make an appointment that has already elapsed look active again.
            const now = Date.now();
            const activeAppointments = parsedList.data.data.appointments.filter(
              (appointment) =>
                RESCHEDULABLE_APPOINTMENT_STATUSES.has(appointment.status) &&
                typeof appointment.scheduledAt === "string" &&
                new Date(appointment.scheduledAt).getTime() > now
            );
            activeAppointments.sort(
              (left, right) =>
                new Date(left.scheduledAt!).getTime() - new Date(right.scheduledAt!).getTime() ||
                left.id.localeCompare(right.id)
            );
            responseText = renderAuthoritativeActiveAppointments(activeAppointments);
            if (!responseText) {
              executionStatus = "fallback";
              responseText = deterministicFallback();
            }
          }
        } else if (freshAvailabilityRequired && requestConstraints.invalidReason) {
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
            signal: this.shutdownController.signal,
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
      this.throwIfShuttingDown();
      if (explicitConfirmation && job.attemptCount >= job.maxAttempts) {
        const confirmationContext = {
          tenantId: job.tenantId,
          patientId: input.patientId,
          conversationId: job.conversationId,
          currentMessageId: input.messageId,
          currentMessageBody: currentBody,
          jobId: job.id,
          sequence: 1
        };
        const finalized = await this.tools.finalizePendingConfirmation(
          confirmationContext,
          "confirmation_unexpected_failure",
          "No pude comprobar que la operación se completara. No voy a afirmar que se realizó; solicita apoyo de un coordinador para revisar su estado."
        );
        executionStatus = finalized.ok ? "completed" : "fallback";
        responseText = finalized.ok
          ? renderAuthoritativeConfirmedAction(finalized.receipt.appointment, finalized.action)
          : confirmationInconclusiveFallback();
      } else if (explicitConfirmation || error instanceof RetryableSofiaError) {
        throw error;
      } else {
        executionStatus = "fallback";
        responseText = deterministicFallback();
        this.options.logger.warn("SOFIA used deterministic fallback", { error: sanitizeError(error) });
      }
    }

    this.throwIfShuttingDown();
    const boundedResponse = boundText(responseText ?? deterministicFallback());
    const elapsedMs = Date.now() - new Date(input.occurredAt).getTime();
    const persistedResponse = await this.persistResponse(job, input, boundedResponse, {
      model,
      promptVersion: prompt?.version ?? null,
      toolNames,
      latencyMs: elapsedMs
    });
    this.throwIfShuttingDown();
    await this.callChannel(`/internal/v1/tenants/${job.tenantId}/whatsapp/messages`, "POST", {
      threadBindingId: input.threadBindingId,
      messageId: persistedResponse.id,
      text: persistedResponse.body,
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
      await tx.query(
        `insert into agent_runtime.outbox_events (
           tenant_id, event_type, event_version, aggregate_type, aggregate_id, payload
         ) values
           ($1, 'sofia.audit.event.record.v1', 1, 'agent_execution', $2, $4::jsonb),
           ($1, 'sofia.audit.event.record.v1', 1, 'message', $3, $5::jsonb)
         on conflict (tenant_id, event_type, aggregate_id) do nothing`,
        [
          job.tenantId,
          execution.rows[0]!.id,
          persistedResponse.id,
          JSON.stringify({
            tenantId: job.tenantId,
            actorId: "agent:SOFIA",
            eventType: "agent.execution.completed",
            entityType: "agent_execution",
            entityId: execution.rows[0]!.id,
            metadata: {
              model,
              toolNames: [...new Set(toolNames)],
              latencyMs: totalLatencyMs,
              fallback: executionStatus === "fallback"
            }
          }),
          JSON.stringify({
            tenantId: job.tenantId,
            actorId: "agent:SOFIA",
            eventType: "agent.response.created",
            entityType: "message",
            entityId: persistedResponse.id,
            metadata: { provider: "whatsapp_web_test", latencyMs: elapsedMs }
          })
        ]
      );
      await this.setConversationRuntime(job.tenantId, job.conversationId, "responded", inferIntent(toolNames));
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
    const [context, catalog] = await Promise.all([
      this.pulsoContext.loadConversation(job.tenantId, {
        conversationId: job.conversationId,
        patientId: input.patientId
      }),
      this.callPulsoTool(job.tenantId, "get_catalog", {})
    ]);
    const now = Date.now();
    const sanitized = sanitizeSofiaState(context.sofiaState, now);
    const timeZone = readCatalogTimeZone(catalog);
    const runtimeContext = {
      now: new Date(now).toISOString(),
      timezone: timeZone,
      patientName: context.patientName,
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
        ...context.history.map((message): LlmMessage => ({
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
      "GET",
      this.credentials.promptFlow
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
  ): Promise<{ id: string; body: string }> {
    const externalId = `sofia-job:${job.id}`;
    const payload = await this.callInternal(
      `${this.options.pulsoIrisUrl}/internal/v1/tenants/${encodeURIComponent(job.tenantId)}/pulso-iris/messages/sofia-outbound`,
      "POST",
      this.credentials.pulso,
      {
        conversationId: job.conversationId,
        body,
        externalMessageId: externalId,
        metadata
      }
    );
    return z.object({ id: z.string().uuid(), body: z.string() }).parse(payload);
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
    const shutdownInterrupted = this.shutdownController.signal.aborted || error instanceof SofiaShutdownError;
    const terminal = !shutdownInterrupted && job.attemptCount >= job.maxAttempts;
    const errorCode = shutdownInterrupted
      ? "shutdown_interrupted"
      : error instanceof RetryableSofiaError
        ? error.code
        : "job_failed";
    await this.options.db.query(
      `update agent_runtime.executions
       set status = 'failed', error_code = $4, completed_at = now()
       where tenant_id = $1 and job_id = $2 and attempt_number = $3 and status = 'running'`,
      [job.tenantId, job.id, job.attemptCount, errorCode]
    );
    await this.options.db.query(
      `update agent_runtime.jobs
       set status = $3, next_attempt_at = now() + interval '5 seconds',
           attempt_count = case when $6::boolean then greatest(attempt_count - 1, 0) else attempt_count end,
           locked_at = null, locked_by = null, last_error_code = $5,
           last_error_message = $4, updated_at = now()
       where tenant_id = $1 and id = $2`,
      [
        job.tenantId,
        job.id,
        shutdownInterrupted && job.attemptCount > job.maxAttempts
          ? "dead_letter"
          : terminal
            ? "dead_letter"
            : "retry_scheduled",
        sanitizeError(error),
        errorCode,
        shutdownInterrupted
      ]
    );
    await this.setConversationRuntime(
      job.tenantId,
      job.conversationId,
      shutdownInterrupted ? "queued" : "failed",
      undefined,
      {
        allowDuringShutdown: true
      }
    );
    this.options.logger.warn("SOFIA job failed", {
      jobId: job.id,
      terminal,
      shutdownInterrupted,
      error: sanitizeError(error)
    });
  }

  private async setConversationRuntime(
    tenantId: string,
    conversationId: string,
    status: string,
    intent?: string,
    options: { allowDuringShutdown?: boolean } = {}
  ) {
    await this.callInternal(
      `${this.options.pulsoIrisUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/pulso-iris/conversations/${encodeURIComponent(conversationId)}/sofia-runtime`,
      "PATCH",
      this.credentials.pulso,
      { sofiaStatus: status, primaryIntent: intent },
      options
    );
  }

  private async callChannel(path: string, method: "GET" | "POST", body?: unknown): Promise<unknown> {
    return this.callInternal(`${this.options.channelUrl}${path}`, method, this.credentials.channel, body);
  }

  private async callPulsoTool(tenantId: string, toolName: string, body: unknown): Promise<unknown> {
    return this.callInternal(
      `${this.options.pulsoIrisUrl}/internal/v1/tenants/${tenantId}/pulso-iris/sofia/tools/${toolName}`,
      "POST",
      this.credentials.pulso,
      body
    );
  }

  private async callInternal(
    url: string,
    method: "GET" | "POST" | "PATCH",
    token: string,
    body?: unknown,
    options: { allowDuringShutdown?: boolean } = {}
  ): Promise<unknown> {
    if (!options.allowDuringShutdown) this.throwIfShuttingDown();
    const timeoutSignal = AbortSignal.timeout(5_000);
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        ...createInternalAuthorizationHeaders("agent-service", token),
        "content-type": "application/json"
      },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
      signal: options.allowDuringShutdown
        ? timeoutSignal
        : AbortSignal.any([this.shutdownController.signal, timeoutSignal])
    });
    if (!options.allowDuringShutdown) this.throwIfShuttingDown();
    const payload = (await response.json()) as { data?: unknown };
    if (!response.ok) throw new Error(`Internal dependency returned status ${response.status}`);
    return payload.data;
  }

  private throwIfShuttingDown(): void {
    this.shutdownController.signal.throwIfAborted();
  }
}

class RetryableSofiaError extends Error {
  constructor(readonly code: string) {
    super(`Retryable SOFIA operation failed: ${code}`);
  }
}

class SofiaShutdownError extends Error {
  constructor() {
    super("SOFIA runtime is shutting down");
    this.name = "SofiaShutdownError";
  }
}

export function registerSofiaReadinessRoute(
  app: Parameters<RouteRegistrar>[0],
  options: {
    db: DatabaseClient;
    llm: LlmProvider;
    integrationToken?: string;
    /** Test-only compatibility; production never falls back to this shared credential. */
    internalServiceToken?: string;
    workerEnabled: boolean;
    runtime: Pick<SofiaRuntime, "isRunning">;
  }
): void {
  const integrationToken =
    options.integrationToken ?? (isCiDeploymentEnvironment(process.env) ? options.internalServiceToken : undefined);
  app.get("/internal/v1/tenants/:tenantId/sofia/readiness", async (request, reply) => {
    const authError = validateInternalAuthorization(request.headers, { "integration-service": integrationToken });
    if (authError) {
      return reply.code(authError.statusCode).send({ data: { error: authError.message }, requestId: request.id });
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
       where selected.runtime_key = 'sofia_whatsapp_internal_v5'`,
      [tenantId.data]
    );
    const workerRunning = options.runtime.isRunning();
    const promptFlowReady = (prompt.rows[0]?.count ?? 0) > 0;
    return {
      data: {
        ready: options.workerEnabled && workerRunning && options.llm.isConfigured() && promptFlowReady,
        model: options.llm.model,
        workerEnabled: options.workerEnabled,
        workerRunning,
        promptFlowReady
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
  if (hasExistingAppointmentQueryIntent(normalized)) return false;

  const availabilityRequest = /\b(disponib\w*|horarios?|cupos?|turnos?|espacios?|atend\w*|atiend\w*)\b/.test(
    normalized
  );
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

export function isCancellationRequest(body: string): boolean {
  const normalized = normalizeForIntent(body);
  if (/\b(?:no|nunca)\s+(?:(?:quiero|deseo|necesito)\s+)?(?:cancelar|anular)\b/.test(normalized)) {
    return false;
  }
  return (
    /\b(?:quiero|deseo|necesito|solicito)\s+(?:cancelar|anular)\b/.test(normalized) ||
    /\b(?:cancela|cancele|cancelar|anula|anule|anular)\s+(?:mi|la|el)\s+(?:cita|turno|reserva)\b/.test(normalized)
  );
}

export function isAppointmentQuery(body: string): boolean {
  const normalized = normalizeForIntent(body);
  return hasExistingAppointmentQueryIntent(normalized);
}

function hasExistingAppointmentQueryIntent(normalized: string): boolean {
  if (!/\bcitas?\b/.test(normalized)) return false;
  if (/\b(cancel\w*|anul\w*|reagend\w*|agend\w*|reserv\w*)\b/.test(normalized)) return false;
  if (/\b(disponib\w*|horarios?|cupos?|turnos?|espacios?|atend\w*|atiend\w*)\b/.test(normalized)) {
    return false;
  }
  const ownedAppointment = /\b(?:mi|mis)\s+citas?\b/.test(normalized);
  return (
    (ownedAppointment &&
      /\b(?:cual|cuando|donde|que|consult\w*|revis\w*|ver|activ\w*|vigent\w*|tengo|programad\w*)\b/.test(normalized)) ||
    /\bque\s+citas?\s+tengo\b/.test(normalized)
  );
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

function confirmedActionToolNames(action: SofiaConfirmedAction): string[] {
  if (action === "book") return ["create_appointment_hold", "book_appointment"];
  if (action === "cancel") return ["cancel_appointment"];
  return ["reschedule_appointment"];
}

function renderAuthoritativeConfirmedAction(
  appointment: SofiaConfirmationAppointment | undefined,
  action: SofiaConfirmedAction
): string {
  if (!appointment?.localDate || !appointment.localTime || !appointment.timeZone) {
    return "La agenda completó la operación, pero no devolvió todos los datos necesarios para mostrarla. Consulta tus citas antes de continuar.";
  }
  const appointmentType = appointment.appointmentTypeName ?? "Cita";
  const site = appointment.siteName ? ` en ${appointment.siteName}` : "";
  const professional = appointment.professionalName ? `, con ${appointment.professionalName}` : "";
  const payer = appointment.payerName ? `, convenio ${appointment.payerName}` : "";
  const details = `${appointmentType}${site}${professional}${payer}, el ${appointment.localDate} a las ${formatLocalClock(appointment.localTime)} (${appointment.timeZone})`;
  if (action === "cancel") return `Tu cita fue cancelada correctamente: ${details}.`;
  if (action === "reschedule") return `Tu cita fue reagendada correctamente: ${details}.`;
  return `Tu cita fue agendada correctamente: ${details}.`;
}

function confirmedActionFallback(result: SofiaConfirmationResult): string {
  if (!result.handled || result.status === "no_action") {
    return "No hay una acción pendiente para confirmar. Solicita primero una reserva, cancelación o reagenda.";
  }
  if (result.status === "expired") {
    return "La acción pendiente venció y no fue ejecutada. Consulta nuevamente la agenda antes de confirmar.";
  }
  if (result.status === "action_mismatch") {
    return "La confirmación no corresponde a la acción pendiente y no se ejecutó ningún cambio.";
  }
  if (result.status === "terminal_failure") return result.message;
  return "La acción pendiente cambió y no se ejecutó ningún cambio. Consulta nuevamente antes de confirmar.";
}

function confirmationInconclusiveFallback(): string {
  return "No pude comprobar que la operación se completara. No voy a afirmar que se realizó; solicita apoyo de un coordinador para revisar su estado.";
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

function renderAuthoritativeCancellationConfirmation(appointment: AppointmentListItem): string | undefined {
  if (!appointment.localDate || !appointment.localTime || !appointment.timeZone) return undefined;
  const appointmentType = appointment.appointmentTypeName ?? "tu cita";
  const site = appointment.siteName ? ` en ${appointment.siteName}` : "";
  const professional = appointment.professionalName ? `, con ${appointment.professionalName}` : "";
  const payer = appointment.payerName ? `, convenio ${appointment.payerName}` : "";
  return `Encontré esta cita activa: ${appointmentType}${site}${professional}${payer}, el ${appointment.localDate} a las ${formatLocalClock(appointment.localTime)} (${appointment.timeZone}). ¿Confirmas que deseas cancelarla? Responde CONFIRMO para continuar.`;
}

function renderAuthoritativeActiveAppointments(appointments: AppointmentListItem[]): string | undefined {
  if (appointments.length === 0) return "No encontré una cita futura activa.";
  const summaries = appointments.map(renderAuthoritativeAppointmentSummary);
  if (summaries.some((summary) => summary === undefined)) return undefined;
  if (summaries.length === 1) return `Tu cita activa es: ${summaries[0]}.`;
  return `Tus citas activas son:\n${summaries.map((summary, index) => `${index + 1}. ${summary}`).join("\n")}`;
}

function renderAuthoritativeAppointmentSummary(appointment: AppointmentListItem): string | undefined {
  if (!appointment.localDate || !appointment.localTime || !appointment.timeZone) return undefined;
  const appointmentType = appointment.appointmentTypeName ?? "cita";
  const site = appointment.siteName ? ` en ${appointment.siteName}` : "";
  const professional = appointment.professionalName ? `, con ${appointment.professionalName}` : "";
  const payer = appointment.payerName ? `, convenio ${appointment.payerName}` : "";
  return `${appointmentType}${site}${professional}${payer}, el ${appointment.localDate} a las ${formatLocalClock(appointment.localTime)} (${appointment.timeZone})`;
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

function requireWorkloadCredential(value: string | undefined, variableName: string): string {
  if (!value) throw new Error(`${variableName} is required for the SOFIA runtime`);
  return value;
}
