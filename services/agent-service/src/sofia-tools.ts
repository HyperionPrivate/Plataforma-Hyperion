import type { DatabaseClient } from "@hyperion/database";
import { createInternalAuthorizationHeaders } from "@hyperion/service-runtime";
import { z } from "zod";
import type { LlmToolDefinition } from "./llm-provider.js";

const uuid = z.string().uuid();
const LAST_AVAILABILITY_SCHEMA_VERSION = 3;
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const localTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

const businessSchemas = {
  get_catalog: z.object({}),
  update_patient_name: z.object({ fullName: z.string().trim().min(2).max(160) }),
  search_availability: z.object({
    from: z.string().datetime().optional(),
    localDate: dateOnly.optional(),
    localTime: localTime.optional(),
    days: z.number().int().min(1).max(31).optional(),
    siteId: uuid.optional(),
    professionalId: uuid.optional(),
    payerId: uuid.optional(),
    appointmentTypeId: uuid.optional()
  }),
  create_appointment_hold: z.object({
    siteId: uuid,
    professionalId: uuid,
    payerId: uuid,
    appointmentTypeId: uuid,
    scheduledAt: z.string().datetime()
  }),
  book_appointment: z.object({ holdId: uuid }),
  list_patient_appointments: z.object({}),
  cancel_appointment: z.object({ appointmentId: uuid, reason: z.string().trim().min(2).max(300) }),
  reschedule_appointment: z.object({
    appointmentId: uuid,
    siteId: uuid,
    professionalId: uuid,
    payerId: uuid,
    appointmentTypeId: uuid,
    scheduledAt: z.string().datetime(),
    reason: z.string().trim().min(2).max(300)
  })
} as const;

const availabilityQueryStateSchema = businessSchemas.search_availability;

export type SofiaToolName = keyof typeof businessSchemas;

const definitions: Record<
  SofiaToolName,
  { description: string; properties: Record<string, unknown>; required: string[] }
> = {
  get_catalog: {
    description: "Consulta sedes, convenios, tipos de cita, preparaciones y profesionales activos en Hyperion.",
    properties: {},
    required: []
  },
  update_patient_name: {
    description: "Actualiza el nombre administrativo que el paciente acaba de proporcionar.",
    properties: { fullName: { type: "string", description: "Nombre completo expresado por el paciente" } },
    required: ["fullName"]
  },
  search_availability: {
    description:
      "Consulta disponibilidad real configurada. Muestra al paciente exclusivamente localDate y localTime en timeZone; nunca presentes startsAt o scheduledAt como hora local. Al crear o reagendar, copia exactamente el valor UTC de scheduledAt/startsAt devuelto por el slot, sin reinterpretarlo ni convertirlo. Nunca inventes horarios fuera del resultado.",
    properties: {
      from: { type: "string", description: "Fecha y hora ISO 8601 inicial" },
      localDate: { type: "string", description: "Fecha local exacta YYYY-MM-DD solicitada por el paciente" },
      localTime: { type: "string", description: "Hora local exacta HH:mm solicitada por el paciente" },
      days: { type: "integer", minimum: 1, maximum: 31 },
      siteId: { type: "string", format: "uuid" },
      professionalId: { type: "string", format: "uuid" },
      payerId: { type: "string", format: "uuid" },
      appointmentTypeId: { type: "string", format: "uuid" }
    },
    required: []
  },
  create_appointment_hold: {
    description:
      "Prepara la reserva del slot elegido. La plataforma bloqueará la escritura y pedirá confirmación si el mensaje actual no es una confirmación explícita.",
    properties: slotProperties(),
    required: ["siteId", "professionalId", "payerId", "appointmentTypeId", "scheduledAt"]
  },
  book_appointment: {
    description: "Confirma en la agenda interna un hold creado en este turno explícitamente confirmado.",
    properties: { holdId: { type: "string", format: "uuid" } },
    required: ["holdId"]
  },
  list_patient_appointments: {
    description: "Lista las citas administrativas del paciente identificado en esta conversación.",
    properties: {},
    required: []
  },
  cancel_appointment: {
    description:
      "Cancela una cita. La plataforma bloqueará la acción y pedirá confirmación si el mensaje actual no es una confirmación explícita.",
    properties: {
      appointmentId: { type: "string", format: "uuid" },
      reason: { type: "string", description: "Motivo administrativo expresado por el paciente" }
    },
    required: ["appointmentId", "reason"]
  },
  reschedule_appointment: {
    description:
      "Reagenda atómicamente una cita a un slot disponible. Requiere confirmación explícita en el mensaje actual.",
    properties: { appointmentId: { type: "string", format: "uuid" }, ...slotProperties(), reason: { type: "string" } },
    required: ["appointmentId", "siteId", "professionalId", "payerId", "appointmentTypeId", "scheduledAt", "reason"]
  }
};

export const SOFIA_TOOL_DEFINITIONS: LlmToolDefinition[] = Object.entries(definitions).map(([name, definition]) => ({
  type: "function",
  function: {
    name,
    description: definition.description,
    parameters: {
      type: "object",
      properties: definition.properties,
      required: definition.required,
      additionalProperties: false
    }
  }
}));

export interface SofiaToolContext {
  tenantId: string;
  patientId: string;
  conversationId: string;
  currentMessageId: string;
  currentMessageBody: string;
  jobId: string;
  sequence: number;
}

type ConfirmableToolName = "create_appointment_hold" | "cancel_appointment" | "reschedule_appointment";

interface PendingAction {
  tool: ConfirmableToolName;
  arguments: Record<string, unknown>;
  stagedAt: string;
  jobId: string;
}

interface ConfirmationGrant {
  actionId: string;
  tool: "book_appointment";
  holdId: string;
  expiresAt: string;
  confirmationMessageId?: string;
  arguments?: Record<string, unknown>;
}

export type SofiaConfirmedAction = "book" | "cancel" | "reschedule";

interface ConfirmationExecution {
  actionId: string;
  tool: ConfirmableToolName;
  arguments: Record<string, unknown>;
  confirmationMessageId: string;
  claimedAt: string;
}

export interface SofiaConfirmationAppointment {
  id?: string;
  status: string;
  verificationMode?: string;
  origin?: string;
  localDate?: string;
  localTime?: string;
  timeZone?: string;
  siteName?: string | null;
  professionalName?: string | null;
  payerName?: string | null;
  appointmentTypeName?: string | null;
}

export interface SofiaConfirmationReceipt {
  schemaVersion: 1;
  confirmationMessageId: string;
  actionId: string;
  action: SofiaConfirmedAction;
  outcome: "completed" | "terminal_failure";
  completedAt: string;
  appointment?: SofiaConfirmationAppointment;
  previousAppointmentId?: string;
  code?: string;
  message?: string;
}

interface ExpiredConfirmationAction {
  actionId: string;
  tool: ConfirmableToolName;
}

interface ConfirmationState {
  pendingAction?: PendingAction;
  confirmationExecution?: ConfirmationExecution;
  confirmationGrant?: ConfirmationGrant;
  confirmationReceipts: Record<string, SofiaConfirmationReceipt>;
  expiredAction?: ExpiredConfirmationAction;
}

export type SofiaConfirmationResult =
  | {
      handled: false;
      ok: false;
      status: "not_confirmation";
      code: "not_explicit_confirmation";
      message: string;
    }
  | {
      handled: true;
      ok: false;
      status: "no_action" | "action_mismatch" | "expired" | "state_changed" | "retryable_failure";
      code: string;
      message: string;
      action?: SofiaConfirmedAction;
      actionId?: string;
    }
  | {
      handled: true;
      ok: false;
      status: "terminal_failure";
      code: string;
      message: string;
      action: SofiaConfirmedAction;
      actionId: string;
      receipt: SofiaConfirmationReceipt;
    }
  | {
      handled: true;
      ok: true;
      status: "completed";
      action: SofiaConfirmedAction;
      actionId: string;
      data: Record<string, unknown>;
      receipt: SofiaConfirmationReceipt;
      replayed: boolean;
    };

const CONFIRMATION_TTL_MS = 15 * 60 * 1_000;
const CONFIRMATION_EXECUTION_LEASE_MS = 5 * 60 * 1_000;

export class SofiaToolClient {
  constructor(
    private readonly options: {
      pulsoIrisUrl: string;
      pulsoToken?: string;
      /** Test-only compatibility; production never falls back to this shared credential. */
      internalServiceToken?: string;
      db: DatabaseClient;
      fetchImpl?: typeof fetch;
      signal?: AbortSignal;
      /** Test-only owner transport that bypasses HTTP for confirmation-state CAS. */
      ownerState?: {
        load(
          tenantId: string,
          conversationId: string
        ): Promise<{
          state: unknown;
          expiredAction?: { actionId: string; tool: ConfirmableToolName };
        }>;
        mutate(tenantId: string, conversationId: string, mutation: Record<string, unknown>): Promise<boolean>;
      };
    }
  ) {}

  async identifyPatient(input: {
    tenantId: string;
    phoneHash: string;
    phoneMasked: string;
    threadBindingId: string;
    externalMessageId: string;
    body: string;
  }): Promise<{ patientId: string; conversationId: string; messageId: string }> {
    this.options.signal?.throwIfAborted();
    const data = await this.call(input.tenantId, "identify_patient_by_phone", input);
    return z.object({ patientId: uuid, conversationId: uuid, messageId: uuid }).parse(data);
  }

  async confirmPendingAction(context: SofiaToolContext): Promise<SofiaConfirmationResult> {
    this.options.signal?.throwIfAborted();
    const confirmationIntent = parseExplicitConfirmation(context.currentMessageBody);
    if (!confirmationIntent) {
      return {
        handled: false,
        ok: false,
        status: "not_confirmation",
        code: "not_explicit_confirmation",
        message: "El mensaje actual no contiene una confirmación explícita."
      };
    }

    let state = await this.loadConfirmationState(context.tenantId, context.conversationId);
    const existingReceipt = state.confirmationReceipts[context.currentMessageId];
    if (existingReceipt) return confirmationResultFromReceipt(existingReceipt, true);

    if (state.expiredAction) {
      return {
        handled: true,
        ok: false,
        status: "expired",
        code: "confirmation_action_expired",
        message: "La acción pendiente venció. Consulta nuevamente la agenda antes de intentar confirmarla.",
        action: confirmedActionForTool(state.expiredAction.tool),
        actionId: state.expiredAction.actionId
      };
    }

    if (state.confirmationExecution) {
      if (state.confirmationExecution.confirmationMessageId !== context.currentMessageId) {
        return confirmationBusy(state.confirmationExecution);
      }
      if (!confirmationMatchesTool(confirmationIntent, state.confirmationExecution.tool)) {
        return confirmationMismatch(state.confirmationExecution.tool, state.confirmationExecution.actionId);
      }
      return this.resumeConfirmationExecution(context, state.confirmationExecution);
    }

    if (state.confirmationGrant) {
      if (
        state.confirmationGrant.confirmationMessageId &&
        state.confirmationGrant.confirmationMessageId !== context.currentMessageId
      ) {
        return confirmationBusy({
          actionId: state.confirmationGrant.actionId,
          tool: "create_appointment_hold"
        });
      }
      if (!confirmationMatchesTool(confirmationIntent, "book_appointment")) {
        return confirmationMismatch("create_appointment_hold", state.confirmationGrant.actionId);
      }
      return this.bookGrantedHold(context, state.confirmationGrant);
    }

    const pending = state.pendingAction;
    if (!pending) {
      return {
        handled: true,
        ok: false,
        status: "no_action",
        code: "confirmation_action_missing",
        message: "No hay una acción pendiente para confirmar."
      };
    }
    if (pending.jobId === context.jobId) {
      return {
        handled: true,
        ok: false,
        status: "no_action",
        code: "confirmation_same_message",
        message: "Una acción no puede prepararse y confirmarse con el mismo mensaje.",
        action: confirmedActionForTool(pending.tool),
        actionId: pending.jobId
      };
    }
    if (!confirmationMatchesTool(confirmationIntent, pending.tool)) {
      return confirmationMismatch(pending.tool, pending.jobId);
    }
    const persisted = validateToolArguments(pending.tool, pending.arguments);
    if (!persisted.ok || !isConfirmableTool(pending.tool)) {
      return {
        handled: true,
        ok: false,
        status: "state_changed",
        code: "pending_action_invalid",
        message: "La acción pendiente no es válida. Solicítala nuevamente.",
        action: confirmedActionForTool(pending.tool),
        actionId: pending.jobId
      };
    }

    const execution: ConfirmationExecution = {
      actionId: pending.jobId,
      tool: pending.tool,
      arguments: persisted.data,
      confirmationMessageId: context.currentMessageId,
      claimedAt: new Date().toISOString()
    };
    const claimed = await this.claimPendingAction(context, pending, execution);
    if (!claimed) {
      state = await this.loadConfirmationState(context.tenantId, context.conversationId);
      const receipt = state.confirmationReceipts[context.currentMessageId];
      if (receipt) return confirmationResultFromReceipt(receipt, true);
      if (
        state.confirmationExecution?.actionId === execution.actionId &&
        state.confirmationExecution.confirmationMessageId === context.currentMessageId
      ) {
        return this.resumeConfirmationExecution(context, state.confirmationExecution);
      }
      return {
        handled: true,
        ok: false,
        status: "state_changed",
        code: "confirmation_state_changed",
        message: "La acción pendiente cambió y no fue ejecutada.",
        action: confirmedActionForTool(pending.tool),
        actionId: pending.jobId
      };
    }
    return this.resumeConfirmationExecution(context, execution);
  }

  async finalizePendingConfirmation(
    context: SofiaToolContext,
    code: string,
    message: string
  ): Promise<SofiaConfirmationResult> {
    this.options.signal?.throwIfAborted();
    const state = await this.loadConfirmationState(context.tenantId, context.conversationId);
    const existingReceipt = state.confirmationReceipts[context.currentMessageId];
    if (existingReceipt) return confirmationResultFromReceipt(existingReceipt, true);

    const terminalCode = /^[a-z0-9_.-]{1,100}$/i.test(code) ? code : "confirmation_retries_exhausted";
    const terminalMessage = message.trim().slice(0, 300) || "La operación no pudo completarse de forma concluyente.";
    if (state.confirmationExecution) {
      if (state.confirmationExecution.confirmationMessageId !== context.currentMessageId) {
        return confirmationBusy(state.confirmationExecution);
      }
      return this.finishTerminalExecution(context, state.confirmationExecution, terminalCode, terminalMessage);
    }
    if (state.confirmationGrant) {
      if (
        state.confirmationGrant.confirmationMessageId &&
        state.confirmationGrant.confirmationMessageId !== context.currentMessageId
      ) {
        return confirmationBusy({
          actionId: state.confirmationGrant.actionId,
          tool: "create_appointment_hold"
        });
      }
      return this.finishTerminalGrant(context, state.confirmationGrant, terminalCode, terminalMessage);
    }
    if (state.pendingAction) {
      const confirmationIntent = parseExplicitConfirmation(context.currentMessageBody);
      if (!confirmationIntent) {
        return {
          handled: false,
          ok: false,
          status: "not_confirmation",
          code: "not_explicit_confirmation",
          message: "El mensaje actual no contiene una confirmación explícita."
        };
      }
      if (state.pendingAction.jobId === context.jobId) {
        return {
          handled: true,
          ok: false,
          status: "no_action",
          code: "confirmation_same_message",
          message: "Una acción no puede prepararse y finalizarse con el mismo mensaje.",
          action: confirmedActionForTool(state.pendingAction.tool),
          actionId: state.pendingAction.jobId
        };
      }
      if (!confirmationMatchesTool(confirmationIntent, state.pendingAction.tool)) {
        return confirmationMismatch(state.pendingAction.tool, state.pendingAction.jobId);
      }
      return this.finishTerminalPending(context, state.pendingAction, terminalCode, terminalMessage);
    }
    return {
      handled: true,
      ok: false,
      status: "no_action",
      code: "confirmation_action_missing",
      message: "No hay una ejecución confirmada pendiente de finalizar."
    };
  }

  async execute(name: string, rawArguments: string, context: SofiaToolContext): Promise<unknown> {
    this.options.signal?.throwIfAborted();
    if (!(name in businessSchemas)) return { ok: false, code: "unknown_tool", message: "Herramienta no disponible" };
    const toolName = name as SofiaToolName;
    let toolArguments: Record<string, unknown>;
    let confirmedActionId: string | undefined;
    const confirmationIntent = parseExplicitConfirmation(context.currentMessageBody);
    const explicitConfirmation = confirmationIntent !== undefined;
    if (isMutation(toolName) && explicitConfirmation) {
      if (!confirmationMatchesTool(confirmationIntent, toolName)) {
        return {
          ok: false,
          code: "confirmation_action_mismatch",
          message: "La confirmación escrita corresponde a otra acción y no fue ejecutada."
        };
      }
      const state = await this.loadConfirmationState(context.tenantId, context.conversationId);
      if (state.confirmationExecution) {
        return {
          ok: false,
          code: "confirmation_state_changed",
          message: "La acción confirmada está en proceso y no puede reemplazarse."
        };
      } else if (
        toolName === "book_appointment" &&
        state.confirmationGrant?.tool === toolName &&
        Date.parse(state.confirmationGrant.expiresAt) >= Date.now()
      ) {
        confirmedActionId = state.confirmationGrant.actionId;
        toolArguments = { holdId: state.confirmationGrant.holdId };
      } else if (toolName === "book_appointment") {
        return {
          ok: false,
          code: "confirmation_action_mismatch",
          message: "No existe un hold confirmado que autorice esta reserva."
        };
      } else if (state.confirmationGrant) {
        return {
          ok: false,
          code: "confirmation_action_mismatch",
          message: "Existe una reserva pendiente de finalizar; no la reemplaces con otra acción."
        };
      } else if (state.pendingAction) {
        const pending = state.pendingAction;
        if (pending.tool !== toolName) {
          return {
            ok: false,
            code: "confirmation_action_mismatch",
            message: "La confirmación corresponde a otra acción pendiente; no la reemplaces ni ejecutes."
          };
        }
        if (pending.jobId === context.jobId) {
          return confirmationRequired("Una acción no puede confirmarse en el mismo mensaje en que fue preparada.");
        }
        const persisted = validateToolArguments(toolName, pending.arguments);
        if (!persisted.ok) {
          return {
            ok: false,
            code: "pending_action_invalid",
            message: "La acción pendiente no es válida; preséntala nuevamente antes de pedir confirmación."
          };
        }
        confirmedActionId = pending.jobId;
        toolArguments = persisted.data;
      } else {
        return {
          ok: false,
          code: "confirmation_action_missing",
          message: "No hay una acción pendiente para confirmar."
        };
      }
    } else {
      const parsed = parseRawToolArguments(toolName, rawArguments);
      if (!parsed.ok) return parsed.error;
      toolArguments = parsed.data;
      if (isMutation(toolName)) {
        const state = await this.loadConfirmationState(context.tenantId, context.conversationId);
        if (toolName === "book_appointment") {
          return {
            ok: false,
            code: "confirmation_action_mismatch",
            message: "book_appointment solo puede usar el hold exacto autorizado por Hyperion."
          };
        }
        if (state.confirmationExecution) {
          return {
            ok: false,
            code: "confirmation_state_changed",
            message: "Existe una acción confirmada en proceso; no la reemplaces con otra acción."
          };
        }
        if (state.confirmationGrant) {
          return {
            ok: false,
            code: "confirmation_action_mismatch",
            message: "Existe una reserva pendiente de finalizar; no la reemplaces con otra acción."
          };
        }
        if (state.pendingAction?.tool !== undefined && state.pendingAction.tool !== toolName) {
          return {
            ok: false,
            code: "confirmation_action_mismatch",
            message: "Ya existe otra acción pendiente; no la reemplaces ni ejecutes."
          };
        }
        if (state.pendingAction?.jobId === context.jobId) {
          return confirmationRequired("La acción ya fue preparada en este mensaje.");
        }
        if (
          state.pendingAction &&
          isConfirmableTool(toolName) &&
          hasSameOperationalIdentity(state.pendingAction, toolName, toolArguments)
        ) {
          return confirmationRequired("La misma acción ya está preparada y espera confirmación.", true);
        }
        const staged = await this.stagePendingAction(toolName, toolArguments, context, state);
        if (!staged) {
          const current = await this.loadConfirmationState(context.tenantId, context.conversationId);
          if (
            current.pendingAction &&
            isConfirmableTool(toolName) &&
            hasSameOperationalIdentity(current.pendingAction, toolName, toolArguments)
          ) {
            return confirmationRequired("La misma acción ya está preparada y espera confirmación.", true);
          }
          return confirmationStateChanged();
        }
        return confirmationRequired("La acción fue preparada sin ejecutarse.");
      }
    }

    if (isMutation(toolName) && !confirmedActionId) {
      return {
        ok: false,
        code: "explicit_confirmation_required",
        message: "La acción no cuenta con una confirmación asociada y no fue ejecutada."
      };
    }

    const idempotency = `${confirmedActionId ?? context.jobId}:${toolName}`;
    const common = { patientId: context.patientId, conversationId: context.conversationId };
    const payload =
      toolName === "update_patient_name"
        ? { ...toolArguments, patientId: context.patientId }
        : toolName === "list_patient_appointments"
          ? { patientId: context.patientId }
          : isMutation(toolName)
            ? {
                ...toolArguments,
                ...common,
                confirmationMessageId: context.currentMessageId,
                idempotencyKey: idempotency
              }
            : toolArguments;

    let data: unknown;
    try {
      data = await this.call(context.tenantId, toolName, payload);
    } catch (error) {
      this.options.signal?.throwIfAborted();
      if (error instanceof ToolCallError) {
        return { ok: false, status: error.status, ...error.payload };
      }
      throw error;
    }
    if (toolName === "search_availability") {
      await this.saveAvailabilityState(context, toolArguments, data);
    } else if (toolName === "create_appointment_hold") {
      const holdId = readHoldId(data);
      await this.replacePendingWithGrant(
        context.tenantId,
        context.conversationId,
        confirmedActionId!,
        holdId
          ? {
              actionId: confirmedActionId!,
              tool: "book_appointment",
              holdId,
              expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS).toISOString()
            }
          : null
      );
      await this.clearLastAvailability(context.tenantId, context.conversationId);
    } else if (toolName === "book_appointment") {
      await this.clearConfirmedGrant(
        context.tenantId,
        context.conversationId,
        confirmedActionId!,
        String(toolArguments.holdId)
      );
      await this.clearLastAvailability(context.tenantId, context.conversationId);
    } else if (isMutation(toolName)) {
      await this.clearConfirmedPending(context.tenantId, context.conversationId, confirmedActionId!);
      await this.clearLastAvailability(context.tenantId, context.conversationId);
    }
    return { ok: true, data };
  }


  private async mutateSofiaState(
    tenantId: string,
    conversationId: string,
    mutation: Record<string, unknown>
  ): Promise<boolean> {
    if (this.options.ownerState) {
      return this.options.ownerState.mutate(tenantId, conversationId, mutation);
    }
    const payload = await this.callOwner(
      `/internal/v1/tenants/${encodeURIComponent(tenantId)}/pulso-iris/conversations/${encodeURIComponent(conversationId)}/sofia-state/mutate`,
      mutation
    );
    return z.object({ applied: z.boolean() }).parse(payload).applied;
  }

  private async callOwner(path: string, body: unknown): Promise<unknown> {
    this.options.signal?.throwIfAborted();
    const token =
      this.options.pulsoToken ?? (process.env.NODE_ENV === "test" ? this.options.internalServiceToken : undefined);
    if (!token) throw new Error("SOFIA_TO_PULSO_TOKEN is required for SOFIA tools");
    const timeoutSignal = AbortSignal.timeout(5_000);
    const response = await (this.options.fetchImpl ?? fetch)(`${this.options.pulsoIrisUrl}${path}`, {
      method: "POST",
      headers: {
        ...createInternalAuthorizationHeaders("agent-service", token),
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal: this.options.signal ? AbortSignal.any([this.options.signal, timeoutSignal]) : timeoutSignal
    });
    this.options.signal?.throwIfAborted();
    const payload = (await response.json()) as { data?: unknown };
    if (!response.ok) throw new Error(`SOFIA owner mutation failed with status ${response.status}`);
    return payload.data;
  }

  private async claimPendingAction(
    context: SofiaToolContext,
    pending: PendingAction,
    execution: ConfirmationExecution
  ): Promise<boolean> {
    return this.mutateSofiaState(context.tenantId, context.conversationId, {
      op: "claim_pending_action",
      pendingJobId: pending.jobId,
      pendingTool: pending.tool,
      execution
    });
  }

  private async resumeConfirmationExecution(
    context: SofiaToolContext,
    execution: ConfirmationExecution
  ): Promise<SofiaConfirmationResult> {
    const persisted = validateToolArguments(execution.tool, execution.arguments);
    if (!persisted.ok) {
      return this.finishTerminalExecution(
        context,
        execution,
        "pending_action_invalid",
        "La acción pendiente dejó de ser válida y no fue ejecutada."
      );
    }

    const called = await this.callConfirmedMutation(
      context,
      execution.tool,
      persisted.data,
      execution.actionId,
      execution.confirmationMessageId
    );
    if (!called.ok) {
      if (called.retryable) {
        return {
          handled: true,
          ok: false,
          status: "retryable_failure",
          code: called.code,
          message: called.message,
          action: confirmedActionForTool(execution.tool),
          actionId: execution.actionId
        };
      }
      return this.finishTerminalExecution(context, execution, called.code, called.message);
    }

    if (execution.tool === "create_appointment_hold") {
      const holdId = readHoldId(called.data);
      if (!holdId) {
        return {
          handled: true,
          ok: false,
          status: "retryable_failure",
          code: "invalid_hold_response",
          message: "La agenda no devolvió una reserva temporal válida. Se reintentará sin duplicar la operación.",
          action: "book",
          actionId: execution.actionId
        };
      }
      const grant: ConfirmationGrant = {
        actionId: execution.actionId,
        tool: "book_appointment",
        holdId,
        expiresAt: readHoldExpiresAt(called.data) ?? new Date(Date.now() + CONFIRMATION_TTL_MS).toISOString(),
        confirmationMessageId: execution.confirmationMessageId,
        arguments: persisted.data
      };
      const moved = await this.moveExecutionToGrant(context, execution, grant);
      if (!moved) {
        const state = await this.loadConfirmationState(context.tenantId, context.conversationId);
        const receipt = state.confirmationReceipts[context.currentMessageId];
        if (receipt) return confirmationResultFromReceipt(receipt, true);
        if (state.confirmationGrant?.actionId === grant.actionId && state.confirmationGrant.holdId === grant.holdId) {
          return this.bookGrantedHold(context, state.confirmationGrant);
        }
        return confirmationStateChangedResult(execution);
      }
      return this.bookGrantedHold(context, grant);
    }

    const action = confirmedActionForTool(execution.tool);
    const receipt = buildCompletedReceipt(
      context.currentMessageId,
      execution.actionId,
      action,
      persisted.data,
      called.data
    );
    if (!receipt) {
      return {
        handled: true,
        ok: false,
        status: "retryable_failure",
        code: "invalid_mutation_response",
        message: "La agenda no devolvió evidencia completa de la operación. Se consultará nuevamente sin duplicarla.",
        action,
        actionId: execution.actionId
      };
    }
    const stored = await this.storeExecutionReceipt(context, execution, receipt);
    if (!stored) return this.readReceiptOrStateChanged(context, execution);
    return confirmationResultFromReceipt(receipt, false, called.data);
  }

  private async bookGrantedHold(context: SofiaToolContext, grant: ConfirmationGrant): Promise<SofiaConfirmationResult> {
    const called = await this.callConfirmedMutation(
      context,
      "book_appointment",
      { holdId: grant.holdId },
      grant.actionId,
      grant.confirmationMessageId ?? context.currentMessageId
    );
    if (!called.ok) {
      if (called.retryable) {
        return {
          handled: true,
          ok: false,
          status: "retryable_failure",
          code: called.code,
          message: called.message,
          action: "book",
          actionId: grant.actionId
        };
      }
      return this.finishTerminalGrant(context, grant, called.code, called.message);
    }

    const receipt = buildCompletedReceipt(
      context.currentMessageId,
      grant.actionId,
      "book",
      grant.arguments,
      called.data
    );
    if (!receipt) {
      return {
        handled: true,
        ok: false,
        status: "retryable_failure",
        code: "invalid_mutation_response",
        message: "La agenda no devolvió evidencia completa de la cita. Se consultará nuevamente sin duplicarla.",
        action: "book",
        actionId: grant.actionId
      };
    }
    const stored = await this.storeGrantReceipt(context, grant, receipt);
    if (!stored) {
      return this.readReceiptOrStateChanged(context, {
        actionId: grant.actionId,
        tool: "create_appointment_hold",
        arguments: {},
        confirmationMessageId: context.currentMessageId,
        claimedAt: new Date().toISOString()
      });
    }
    return confirmationResultFromReceipt(receipt, false, called.data);
  }

  private async callConfirmedMutation(
    context: SofiaToolContext,
    toolName: ConfirmableToolName | "book_appointment",
    toolArguments: Record<string, unknown>,
    actionId: string,
    confirmationMessageId: string
  ): Promise<{ ok: true; data: unknown } | { ok: false; retryable: boolean; code: string; message: string }> {
    try {
      const data = await this.call(context.tenantId, toolName, {
        ...toolArguments,
        patientId: context.patientId,
        conversationId: context.conversationId,
        confirmationMessageId,
        idempotencyKey: `${actionId}:${toolName}`
      });
      return { ok: true, data };
    } catch (error) {
      this.options.signal?.throwIfAborted();
      if (error instanceof ToolCallError) return classifyToolCallFailure(error);
      return {
        ok: false,
        retryable: true,
        code: "agenda_temporarily_unavailable",
        message: "La agenda no respondió. La operación podrá reintentarse sin duplicarse."
      };
    }
  }

  private async moveExecutionToGrant(
    context: SofiaToolContext,
    execution: ConfirmationExecution,
    grant: ConfirmationGrant
  ): Promise<boolean> {
    return this.mutateSofiaState(context.tenantId, context.conversationId, {
      op: "move_execution_to_grant",
      executionActionId: execution.actionId,
      confirmationMessageId: execution.confirmationMessageId,
      executionTool: execution.tool,
      grant
    });
  }

  private async finishTerminalExecution(
    context: SofiaToolContext,
    execution: ConfirmationExecution,
    code: string,
    message: string
  ): Promise<SofiaConfirmationResult> {
    const receipt = buildTerminalReceipt(
      context.currentMessageId,
      execution.actionId,
      confirmedActionForTool(execution.tool),
      code,
      message
    );
    const stored = await this.storeExecutionReceipt(context, execution, receipt);
    if (!stored) return this.readReceiptOrStateChanged(context, execution);
    return confirmationResultFromReceipt(receipt, false);
  }

  private async finishTerminalPending(
    context: SofiaToolContext,
    pending: PendingAction,
    code: string,
    message: string
  ): Promise<SofiaConfirmationResult> {
    const receipt = buildTerminalReceipt(
      context.currentMessageId,
      pending.jobId,
      confirmedActionForTool(pending.tool),
      code,
      message
    );
    const stored = await this.storePendingReceipt(context, pending, receipt);
    if (!stored) {
      const state = await this.loadConfirmationState(context.tenantId, context.conversationId);
      const existingReceipt = state.confirmationReceipts[context.currentMessageId];
      return existingReceipt
        ? confirmationResultFromReceipt(existingReceipt, true)
        : confirmationStateChangedResult({
            actionId: pending.jobId,
            tool: pending.tool,
            arguments: pending.arguments,
            confirmationMessageId: context.currentMessageId,
            claimedAt: new Date().toISOString()
          });
    }
    return confirmationResultFromReceipt(receipt, false);
  }

  private async finishTerminalGrant(
    context: SofiaToolContext,
    grant: ConfirmationGrant,
    code: string,
    message: string
  ): Promise<SofiaConfirmationResult> {
    const receipt = buildTerminalReceipt(context.currentMessageId, grant.actionId, "book", code, message);
    const stored = await this.storeGrantReceipt(context, grant, receipt);
    if (!stored) {
      return this.readReceiptOrStateChanged(context, {
        actionId: grant.actionId,
        tool: "create_appointment_hold",
        arguments: {},
        confirmationMessageId: context.currentMessageId,
        claimedAt: new Date().toISOString()
      });
    }
    return confirmationResultFromReceipt(receipt, false);
  }

  private async storeExecutionReceipt(
    context: SofiaToolContext,
    execution: ConfirmationExecution,
    receipt: SofiaConfirmationReceipt
  ): Promise<boolean> {
    return this.mutateSofiaState(context.tenantId, context.conversationId, {
      op: "store_execution_receipt",
      executionActionId: execution.actionId,
      confirmationMessageId: execution.confirmationMessageId,
      executionTool: execution.tool,
      receipt
    });
  }

  private async storePendingReceipt(
    context: SofiaToolContext,
    pending: PendingAction,
    receipt: SofiaConfirmationReceipt
  ): Promise<boolean> {
    return this.mutateSofiaState(context.tenantId, context.conversationId, {
      op: "store_pending_receipt",
      pendingJobId: pending.jobId,
      pendingTool: pending.tool,
      currentMessageId: context.currentMessageId,
      receipt
    });
  }

  private async storeGrantReceipt(
    context: SofiaToolContext,
    grant: ConfirmationGrant,
    receipt: SofiaConfirmationReceipt
  ): Promise<boolean> {
    return this.mutateSofiaState(context.tenantId, context.conversationId, {
      op: "store_grant_receipt",
      grantActionId: grant.actionId,
      holdId: grant.holdId,
      currentMessageId: context.currentMessageId,
      confirmationMessageId: grant.confirmationMessageId ?? null,
      receipt
    });
  }

  private async readReceiptOrStateChanged(
    context: SofiaToolContext,
    execution: ConfirmationExecution
  ): Promise<SofiaConfirmationResult> {
    const state = await this.loadConfirmationState(context.tenantId, context.conversationId);
    const receipt = state.confirmationReceipts[context.currentMessageId];
    return receipt ? confirmationResultFromReceipt(receipt, true) : confirmationStateChangedResult(execution);
  }

  private async call(tenantId: string, toolName: string, body: unknown): Promise<unknown> {
    this.options.signal?.throwIfAborted();
    const token =
      this.options.pulsoToken ?? (process.env.NODE_ENV === "test" ? this.options.internalServiceToken : undefined);
    if (!token) throw new Error("SOFIA_TO_PULSO_TOKEN is required for SOFIA tools");
    const timeoutSignal = AbortSignal.timeout(5_000);
    const response = await (this.options.fetchImpl ?? fetch)(
      `${this.options.pulsoIrisUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/pulso-iris/sofia/tools/${toolName}`,
      {
        method: "POST",
        headers: {
          ...createInternalAuthorizationHeaders("agent-service", token),
          "content-type": "application/json"
        },
        body: JSON.stringify(body),
        signal: this.options.signal ? AbortSignal.any([this.options.signal, timeoutSignal]) : timeoutSignal
      }
    );
    this.options.signal?.throwIfAborted();
    const payload = (await response.json()) as { data?: unknown };
    if (!response.ok) throw new ToolCallError(response.status, isRecord(payload.data) ? payload.data : {});
    return payload.data;
  }

  private async saveConversationState(tenantId: string, conversationId: string, patch: Record<string, unknown>) {
    await this.mutateSofiaState(tenantId, conversationId, { op: "save_conversation_state", patch });
  }

  private async saveAvailabilityState(
    context: SofiaToolContext,
    toolArguments: Record<string, unknown>,
    data: unknown
  ): Promise<void> {
    const query = availabilityQueryStateSchema.parse(toolArguments);
    const selection: Record<string, string> = {};
    for (const key of ["siteId", "professionalId", "payerId", "appointmentTypeId"] as const) {
      const value = query[key];
      if (typeof value === "string") selection[key] = value;
    }
    const availabilityPatch = {
      lastAvailability: data,
      lastAvailabilityAt: new Date().toISOString(),
      lastAvailabilitySchemaVersion: LAST_AVAILABILITY_SCHEMA_VERSION,
      lastAvailabilityJobId: context.jobId,
      lastAvailabilityQuery: query
    };
    await this.mutateSofiaState(context.tenantId, context.conversationId, {
      op: "save_availability_state",
      availabilityPatch,
      selection
    });
  }

  private async clearLastAvailability(tenantId: string, conversationId: string): Promise<void> {
    await this.mutateSofiaState(tenantId, conversationId, { op: "clear_last_availability" });
  }

  private async stagePendingAction(
    toolName: SofiaToolName,
    toolArguments: Record<string, unknown>,
    context: SofiaToolContext,
    expected: ReturnType<typeof parseConfirmationState>
  ): Promise<boolean> {
    const patch = {
      pendingAction: {
        tool: toolName,
        arguments: toolArguments,
        stagedAt: new Date().toISOString(),
        jobId: context.jobId
      },
      confirmationGrant: null
    };
    return this.mutateSofiaState(context.tenantId, context.conversationId, {
      op: "stage_pending_action",
      expectedPendingJobId: expected.pendingAction?.jobId ?? null,
      expectedGrantActionId: expected.confirmationGrant?.actionId ?? expected.confirmationGrant?.jobId ?? null,
      patch
    });
  }

  private async replacePendingWithGrant(
    tenantId: string,
    conversationId: string,
    actionId: string,
    grant: ConfirmationGrant | null
  ): Promise<void> {
    await this.mutateSofiaState(tenantId, conversationId, {
      op: "replace_pending_with_grant",
      pendingJobId: actionId,
      patch: { pendingAction: null, confirmationGrant: grant }
    });
  }

  private async clearConfirmedGrant(
    tenantId: string,
    conversationId: string,
    actionId: string,
    holdId: string
  ): Promise<void> {
    await this.mutateSofiaState(tenantId, conversationId, {
      op: "clear_confirmed_grant",
      actionId,
      holdId
    });
  }

  private async clearConfirmedPending(tenantId: string, conversationId: string, actionId: string): Promise<void> {
    await this.mutateSofiaState(tenantId, conversationId, {
      op: "clear_confirmed_pending",
      actionId
    });
  }

  private async loadConfirmationState(tenantId: string, conversationId: string) {
    const payload = this.options.ownerState
      ? await this.options.ownerState.load(tenantId, conversationId)
      : await this.callOwner(
          `/internal/v1/tenants/${encodeURIComponent(tenantId)}/pulso-iris/conversations/${encodeURIComponent(conversationId)}/sofia-state/load`,
          {}
        );
    const parsed = z
      .object({
        state: z.unknown(),
        expiredAction: z
          .object({
            actionId: z.string(),
            tool: z.enum(["create_appointment_hold", "cancel_appointment", "reschedule_appointment"])
          })
          .optional()
      })
      .parse(payload);
    return {
      ...parseConfirmationState(parsed.state),
      expiredAction: parsed.expiredAction
    };
  }
}

export function isExplicitConfirmation(body: string): boolean {
  return parseExplicitConfirmation(body) !== undefined;
}

type ConfirmationIntent = "generic" | "book" | "cancel" | "reschedule";

function parseExplicitConfirmation(body: string): ConfirmationIntent | undefined {
  const normalized = body
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const match = /^(?:si\s+)?confirmo(?:\s+(agendar|reservar|cancelar|reagendar|la\s+cita|el\s+cambio))?$/.exec(
    normalized
  );
  const suffix = match?.[1];
  if (!match) return undefined;
  if (!suffix) return "generic";
  if (suffix === "cancelar") return "cancel";
  if (suffix === "reagendar" || suffix === "el cambio") return "reschedule";
  return "book";
}

function confirmationMatchesTool(intent: ConfirmationIntent, toolName: SofiaToolName): boolean {
  if (intent === "generic") return true;
  if (toolName === "create_appointment_hold" || toolName === "book_appointment") return intent === "book";
  if (toolName === "cancel_appointment") return intent === "cancel";
  if (toolName === "reschedule_appointment") return intent === "reschedule";
  return false;
}

type ParsedToolArguments = { ok: true; data: Record<string, unknown> } | { ok: false; error: Record<string, unknown> };

function parseRawToolArguments(toolName: SofiaToolName, rawArguments: string): ParsedToolArguments {
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawArguments || "{}");
  } catch {
    return {
      ok: false,
      error: { ok: false, code: "invalid_arguments", message: "Argumentos JSON inválidos" }
    };
  }
  return validateToolArguments(toolName, decoded);
}

function validateToolArguments(toolName: SofiaToolName, value: unknown): ParsedToolArguments {
  const parsed = businessSchemas[toolName].safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        ok: false,
        code: "invalid_arguments",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      }
    };
  }
  return { ok: true, data: parsed.data as Record<string, unknown> };
}

function confirmationRequired(detail: string, pendingActionReused = false): Record<string, unknown> {
  return {
    ok: false,
    code: "explicit_confirmation_required",
    message: `${detail} Pide al paciente que responda exactamente CONFIRMO en un mensaje nuevo.`,
    ...(pendingActionReused ? { pendingActionReused: true } : {})
  };
}

function confirmationStateChanged(): Record<string, unknown> {
  return {
    ok: false,
    code: "confirmation_state_changed",
    message: "La acción pendiente cambió y no fue ejecutada. Consulta nuevamente antes de confirmar."
  };
}

function isMutation(name: SofiaToolName): boolean {
  return (
    name === "create_appointment_hold" ||
    name === "book_appointment" ||
    name === "cancel_appointment" ||
    name === "reschedule_appointment"
  );
}

function slotProperties(): Record<string, unknown> {
  return {
    siteId: { type: "string", format: "uuid" },
    professionalId: { type: "string", format: "uuid" },
    payerId: { type: "string", format: "uuid" },
    appointmentTypeId: { type: "string", format: "uuid" },
    scheduledAt: {
      type: "string",
      description:
        "Instante UTC técnico: copia exactamente scheduledAt/startsAt del slot devuelto por search_availability, sin reinterpretarlo ni convertirlo. Para mostrar la hora al paciente usa localDate/localTime/timeZone del slot."
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseConfirmationState(value: unknown): ConfirmationState {
  if (!isRecord(value)) return { confirmationReceipts: {} };
  const pending = z
    .object({
      tool: z.enum(["create_appointment_hold", "cancel_appointment", "reschedule_appointment"]),
      arguments: z.record(z.string(), z.unknown()),
      stagedAt: z.string().datetime(),
      jobId: uuid
    })
    .safeParse(value.pendingAction);
  const execution = z
    .object({
      actionId: uuid,
      tool: z.enum(["create_appointment_hold", "cancel_appointment", "reschedule_appointment"]),
      arguments: z.record(z.string(), z.unknown()),
      confirmationMessageId: uuid,
      claimedAt: z.string().datetime()
    })
    .safeParse(value.confirmationExecution);
  const grant = z
    .object({
      actionId: uuid.optional(),
      jobId: uuid.optional(),
      tool: z.literal("book_appointment"),
      holdId: uuid,
      expiresAt: z.string().datetime(),
      confirmationMessageId: uuid.optional(),
      arguments: z.record(z.string(), z.unknown()).optional()
    })
    .refine((value) => Boolean(value.actionId ?? value.jobId))
    .safeParse(value.confirmationGrant);
  const appointmentSchema = z.object({
    id: uuid.optional(),
    status: z.string().min(1),
    verificationMode: z.string().min(1).optional(),
    origin: z.string().min(1).optional(),
    localDate: dateOnly.optional(),
    localTime: localTime.optional(),
    timeZone: z.string().min(1).optional(),
    siteName: z.string().nullable().optional(),
    professionalName: z.string().nullable().optional(),
    payerName: z.string().nullable().optional(),
    appointmentTypeName: z.string().nullable().optional()
  });
  const receiptSchema = z.object({
    schemaVersion: z.literal(1),
    confirmationMessageId: uuid,
    actionId: uuid,
    action: z.enum(["book", "cancel", "reschedule"]),
    outcome: z.enum(["completed", "terminal_failure"]),
    completedAt: z.string().datetime(),
    appointment: appointmentSchema.optional(),
    previousAppointmentId: uuid.optional(),
    code: z.string().min(1).max(100).optional(),
    message: z.string().min(1).max(300).optional()
  });
  const receipts = z.record(z.string(), receiptSchema).safeParse(value.confirmationReceipts);
  return {
    pendingAction: pending.success ? pending.data : undefined,
    confirmationExecution: execution.success ? execution.data : undefined,
    confirmationGrant: grant.success
      ? {
          actionId: grant.data.actionId ?? grant.data.jobId!,
          tool: grant.data.tool,
          holdId: grant.data.holdId,
          expiresAt: grant.data.expiresAt,
          ...(grant.data.confirmationMessageId ? { confirmationMessageId: grant.data.confirmationMessageId } : {}),
          ...(grant.data.arguments ? { arguments: grant.data.arguments } : {})
        }
      : undefined,
    confirmationReceipts: receipts.success
      ? Object.fromEntries(
          Object.entries(receipts.data).filter(([messageId, receipt]) => receipt.confirmationMessageId === messageId)
        )
      : {}
  };
}

function isConfirmableTool(toolName: SofiaToolName): toolName is ConfirmableToolName {
  return (
    toolName === "create_appointment_hold" || toolName === "cancel_appointment" || toolName === "reschedule_appointment"
  );
}

function hasSameOperationalIdentity(
  pending: PendingAction,
  toolName: ConfirmableToolName,
  incomingArguments: Record<string, unknown>
): boolean {
  if (pending.tool !== toolName) return false;
  const persisted = operationalIdentity(toolName, pending.arguments);
  const incoming = operationalIdentity(toolName, incomingArguments);
  return persisted !== undefined && persisted === incoming;
}

function operationalIdentity(toolName: ConfirmableToolName, rawArguments: Record<string, unknown>): string | undefined {
  const parsed = validateToolArguments(toolName, rawArguments);
  if (!parsed.ok) return undefined;
  const value = parsed.data;
  const uuidValue = (key: string) => String(value[key]).toLowerCase();

  if (toolName === "cancel_appointment") {
    return JSON.stringify([toolName, uuidValue("appointmentId")]);
  }

  const scheduledAt = new Date(String(value.scheduledAt)).toISOString();
  const slot = [
    uuidValue("siteId"),
    uuidValue("professionalId"),
    uuidValue("payerId"),
    uuidValue("appointmentTypeId"),
    scheduledAt
  ];
  return JSON.stringify(
    toolName === "reschedule_appointment" ? [toolName, uuidValue("appointmentId"), ...slot] : [toolName, ...slot]
  );
}

function confirmedActionForTool(toolName: ConfirmableToolName | "book_appointment"): SofiaConfirmedAction {
  if (toolName === "cancel_appointment") return "cancel";
  if (toolName === "reschedule_appointment") return "reschedule";
  return "book";
}

function confirmationMismatch(toolName: ConfirmableToolName, actionId: string): SofiaConfirmationResult {
  return {
    handled: true,
    ok: false,
    status: "action_mismatch",
    code: "confirmation_action_mismatch",
    message: "La confirmación escrita corresponde a otra acción y no fue ejecutada.",
    action: confirmedActionForTool(toolName),
    actionId
  };
}

function confirmationBusy(input: { actionId: string; tool: ConfirmableToolName }): SofiaConfirmationResult {
  return {
    handled: true,
    ok: false,
    status: "state_changed",
    code: "confirmation_already_processing",
    message: "La acción ya está siendo procesada por otro mensaje de confirmación.",
    action: confirmedActionForTool(input.tool),
    actionId: input.actionId
  };
}

function confirmationStateChangedResult(execution: ConfirmationExecution): SofiaConfirmationResult {
  return {
    handled: true,
    ok: false,
    status: "state_changed",
    code: "confirmation_state_changed",
    message: "La acción pendiente cambió. No se ejecutó una operación adicional.",
    action: confirmedActionForTool(execution.tool),
    actionId: execution.actionId
  };
}

function classifyToolCallFailure(error: ToolCallError): {
  ok: false;
  retryable: boolean;
  code: string;
  message: string;
} {
  const payloadCode = typeof error.payload.code === "string" ? error.payload.code : `agenda_http_${error.status}`;
  const code = /^[a-z0-9_.-]{1,100}$/i.test(payloadCode) ? payloadCode : `agenda_http_${error.status}`;
  const retryable = error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
  if (retryable) {
    return {
      ok: false,
      retryable: true,
      code,
      message: "La agenda está temporalmente indisponible. La operación podrá reintentarse sin duplicarse."
    };
  }
  const message =
    code === "slot_unavailable" || code === "hold_expired"
      ? "El horario seleccionado ya no está disponible. Consulta nuevas opciones antes de volver a confirmar."
      : code === "invalid_transition" || code === "max_reschedules"
        ? "La cita cambió de estado y esa operación ya no es válida."
        : "La agenda rechazó la operación solicitada. Revisa el estado actual antes de intentarlo de nuevo.";
  return { ok: false, retryable: false, code, message };
}

function buildCompletedReceipt(
  confirmationMessageId: string,
  actionId: string,
  action: SofiaConfirmedAction,
  actionArguments: unknown,
  data: unknown
): SofiaConfirmationReceipt | undefined {
  if (!isRecord(data) || !isRecord(data.appointment)) return undefined;
  let previousAppointmentId: string | undefined;
  if (action === "cancel") {
    const parsed = businessSchemas.cancel_appointment.safeParse(actionArguments);
    if (
      !parsed.success ||
      data.appointment.status !== "cancelled" ||
      data.appointment.id !== parsed.data.appointmentId ||
      !hasValidAppointmentDetails(data.appointment)
    ) {
      return undefined;
    }
  } else {
    if (action === "book") {
      const parsed = businessSchemas.create_appointment_hold.safeParse(actionArguments);
      if (
        !(parsed.success
          ? isExpectedVerifiedAppointment(data.appointment, parsed.data)
          : isVerifiedAppointmentWithValidDetails(data.appointment))
      ) {
        return undefined;
      }
    } else {
      const parsed = businessSchemas.reschedule_appointment.safeParse(actionArguments);
      if (!parsed.success || !isExpectedVerifiedAppointment(data.appointment, parsed.data)) return undefined;
      if (
        !isRecord(data.previousAppointment) ||
        data.previousAppointment.status !== "rescheduled" ||
        data.previousAppointment.id !== parsed.data.appointmentId ||
        data.appointment.id === parsed.data.appointmentId
      ) {
        return undefined;
      }
      previousAppointmentId = parsed.data.appointmentId;
    }
  }
  const appointment = readAppointmentSummary(data.appointment);
  if (!appointment) return undefined;
  return {
    schemaVersion: 1,
    confirmationMessageId,
    actionId,
    action,
    outcome: "completed",
    completedAt: new Date().toISOString(),
    appointment,
    ...(previousAppointmentId ? { previousAppointmentId } : {})
  };
}

function buildTerminalReceipt(
  confirmationMessageId: string,
  actionId: string,
  action: SofiaConfirmedAction,
  code: string,
  message: string
): SofiaConfirmationReceipt {
  return {
    schemaVersion: 1,
    confirmationMessageId,
    actionId,
    action,
    outcome: "terminal_failure",
    completedAt: new Date().toISOString(),
    code: code.slice(0, 100),
    message: message.slice(0, 300)
  };
}

function readAppointmentSummary(value: Record<string, unknown>): SofiaConfirmationAppointment | undefined {
  if (typeof value.status !== "string" || value.status.length === 0) return undefined;
  const summary: SofiaConfirmationAppointment = { status: value.status };
  if (typeof value.id === "string") summary.id = value.id;
  if (typeof value.verificationMode === "string") summary.verificationMode = value.verificationMode;
  if (typeof value.origin === "string") summary.origin = value.origin;
  if (typeof value.localDate === "string") summary.localDate = value.localDate;
  if (typeof value.localTime === "string") summary.localTime = value.localTime;
  if (typeof value.timeZone === "string") summary.timeZone = value.timeZone;
  for (const key of ["siteName", "professionalName", "payerName", "appointmentTypeName"] as const) {
    const field = value[key];
    if (typeof field === "string" || field === null) summary[key] = field;
  }
  return summary;
}

function isVerifiedSofiaInternalAppointment(value: Record<string, unknown>): boolean {
  const simulated =
    value.simulated === true ||
    value.verificationMode === "simulated" ||
    (isRecord(value.metadata) && value.metadata.simulated === true);
  return (
    value.status === "verified" && value.verificationMode === "internal" && value.origin === "sofia_wa" && !simulated
  );
}

function isExpectedVerifiedAppointment(
  value: Record<string, unknown>,
  expected: {
    siteId: string;
    professionalId: string;
    payerId: string;
    appointmentTypeId: string;
    scheduledAt: string;
  }
): boolean {
  const expectedTimestamp = Date.parse(expected.scheduledAt);
  return (
    isVerifiedAppointmentWithValidDetails(value) &&
    value.siteId === expected.siteId &&
    value.professionalId === expected.professionalId &&
    value.payerId === expected.payerId &&
    value.appointmentTypeId === expected.appointmentTypeId &&
    Number.isFinite(expectedTimestamp) &&
    Date.parse(String(value.scheduledAt)) === expectedTimestamp
  );
}

function isVerifiedAppointmentWithValidDetails(value: Record<string, unknown>): boolean {
  return hasValidAppointmentDetails(value) && isVerifiedSofiaInternalAppointment(value);
}

function hasValidAppointmentDetails(value: Record<string, unknown>): boolean {
  return (
    uuid.safeParse(value.id).success &&
    typeof value.scheduledAt === "string" &&
    Number.isFinite(Date.parse(value.scheduledAt)) &&
    dateOnly.safeParse(value.localDate).success &&
    localTime.safeParse(value.localTime).success &&
    typeof value.timeZone === "string" &&
    value.timeZone.trim().length > 0
  );
}

function confirmationResultFromReceipt(
  receipt: SofiaConfirmationReceipt,
  replayed: boolean,
  originalData?: unknown
): SofiaConfirmationResult {
  if (receipt.outcome === "terminal_failure") {
    return {
      handled: true,
      ok: false,
      status: "terminal_failure",
      code: receipt.code ?? "agenda_operation_rejected",
      message: receipt.message ?? "La agenda rechazó la operación solicitada.",
      action: receipt.action,
      actionId: receipt.actionId,
      receipt
    };
  }
  const reconstructed: Record<string, unknown> = { appointment: receipt.appointment };
  if (receipt.previousAppointmentId) reconstructed.previousAppointment = { id: receipt.previousAppointmentId };
  return {
    handled: true,
    ok: true,
    status: "completed",
    action: receipt.action,
    actionId: receipt.actionId,
    data: isRecord(originalData) ? originalData : reconstructed,
    receipt,
    replayed
  };
}

function readHoldId(value: unknown): string | undefined {
  return isRecord(value) && isRecord(value.hold) && typeof value.hold.id === "string" ? value.hold.id : undefined;
}

function readHoldExpiresAt(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.hold) || typeof value.hold.expiresAt !== "string") return undefined;
  return Number.isFinite(Date.parse(value.hold.expiresAt)) ? value.hold.expiresAt : undefined;
}

class ToolCallError extends Error {
  constructor(
    readonly status: number,
    readonly payload: Record<string, unknown>
  ) {
    super(`SOFIA tool failed with status ${status}`);
  }
}
