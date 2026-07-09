import type { DatabaseClient } from "@hyperion/database";
import { z } from "zod";
import type { LlmToolDefinition } from "./llm-provider.js";

const uuid = z.string().uuid();

const businessSchemas = {
  get_catalog: z.object({}),
  update_patient_name: z.object({ fullName: z.string().trim().min(2).max(160) }),
  search_availability: z.object({
    from: z.string().datetime().optional(),
    days: z.number().int().min(1).max(31).optional(),
    siteId: uuid.optional(),
    professionalId: uuid.optional(),
    payerId: uuid.optional(),
    appointmentTypeId: uuid.optional()
  }),
  create_appointment_hold: z.object({
    siteId: uuid,
    professionalId: uuid,
    payerId: uuid.optional(),
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
    payerId: uuid.optional(),
    appointmentTypeId: uuid,
    scheduledAt: z.string().datetime(),
    reason: z.string().trim().min(2).max(300)
  })
} as const;

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
    description: "Consulta disponibilidad real configurada. Nunca inventes horarios fuera del resultado.",
    properties: {
      from: { type: "string", description: "Fecha y hora ISO 8601 inicial" },
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
    required: ["siteId", "professionalId", "appointmentTypeId", "scheduledAt"]
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
    required: ["appointmentId", "siteId", "professionalId", "appointmentTypeId", "scheduledAt", "reason"]
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

interface PendingAction {
  tool: SofiaToolName;
  arguments: Record<string, unknown>;
  stagedAt: string;
  jobId: string;
}

interface ConfirmationGrant {
  jobId: string;
  tool: "book_appointment";
  holdId: string;
  expiresAt: string;
}

const CONFIRMATION_TTL_MS = 15 * 60 * 1_000;

export class SofiaToolClient {
  constructor(
    private readonly options: {
      pulsoIrisUrl: string;
      internalServiceToken: string;
      db: DatabaseClient;
      fetchImpl?: typeof fetch;
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
    const data = await this.call(input.tenantId, "identify_patient_by_phone", input);
    return z.object({ patientId: uuid, conversationId: uuid, messageId: uuid }).parse(data);
  }

  async execute(name: string, rawArguments: string, context: SofiaToolContext): Promise<unknown> {
    if (!(name in businessSchemas)) return { ok: false, code: "unknown_tool", message: "Herramienta no disponible" };
    const toolName = name as SofiaToolName;
    let decoded: unknown;
    try {
      decoded = JSON.parse(rawArguments || "{}");
    } catch {
      return { ok: false, code: "invalid_arguments", message: "Argumentos JSON inválidos" };
    }
    const parsed = businessSchemas[toolName].safeParse(decoded);
    if (!parsed.success) {
      return {
        ok: false,
        code: "invalid_arguments",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      };
    }

    if (isMutation(toolName)) {
      if (!isExplicitConfirmation(context.currentMessageBody)) {
        const state = await this.loadConfirmationState(context.tenantId, context.conversationId);
        if (state.pendingAction?.jobId === context.jobId) {
          return {
            ok: false,
            code: "explicit_confirmation_required",
            message: "Pide al paciente que responda exactamente CONFIRMO antes de ejecutar la acción."
          };
        }
        await this.saveConversationState(context.tenantId, context.conversationId, {
          pendingAction: {
            tool: toolName,
            arguments: parsed.data,
            stagedAt: new Date().toISOString(),
            jobId: context.jobId
          },
          confirmationGrant: null
        });
        return {
          ok: false,
          code: "explicit_confirmation_required",
          message: "Pide al paciente que responda exactamente CONFIRMO antes de ejecutar la acción."
        };
      }

      const authorized = await this.isConfirmedAction(toolName, parsed.data, context);
      if (!authorized) {
        return {
          ok: false,
          code: "confirmation_action_mismatch",
          message: "La confirmación no corresponde a esta acción. Presenta nuevamente el cambio y pide CONFIRMO."
        };
      }
    }

    const idempotency = `${context.jobId}:${toolName}`;
    const common = { patientId: context.patientId, conversationId: context.conversationId };
    const payload =
      toolName === "update_patient_name"
        ? { ...parsed.data, patientId: context.patientId }
        : toolName === "list_patient_appointments"
          ? { patientId: context.patientId }
          : isMutation(toolName)
            ? {
                ...parsed.data,
                ...common,
                confirmationMessageId: context.currentMessageId,
                idempotencyKey: idempotency
              }
            : parsed.data;

    let data: unknown;
    try {
      data = await this.call(context.tenantId, toolName, payload);
    } catch (error) {
      if (error instanceof ToolCallError) {
        return { ok: false, status: error.status, ...error.payload };
      }
      throw error;
    }
    if (toolName === "search_availability") {
      await this.saveConversationState(context.tenantId, context.conversationId, {
        lastAvailability: data,
        lastAvailabilityAt: new Date().toISOString()
      });
    } else if (toolName === "create_appointment_hold") {
      const holdId = readHoldId(data);
      await this.saveConversationState(context.tenantId, context.conversationId, {
        pendingAction: null,
        confirmationGrant: holdId
          ? {
              jobId: context.jobId,
              tool: "book_appointment",
              holdId,
              expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS).toISOString()
            }
          : null
      });
    } else if (isMutation(toolName)) {
      await this.saveConversationState(context.tenantId, context.conversationId, {
        pendingAction: null,
        confirmationGrant: null
      });
    }
    return { ok: true, data };
  }

  private async call(tenantId: string, toolName: string, body: unknown): Promise<unknown> {
    const response = await (this.options.fetchImpl ?? fetch)(
      `${this.options.pulsoIrisUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/pulso-iris/sofia/tools/${toolName}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.internalServiceToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000)
      }
    );
    const payload = (await response.json()) as { data?: unknown };
    if (!response.ok) throw new ToolCallError(response.status, isRecord(payload.data) ? payload.data : {});
    return payload.data;
  }

  private async saveConversationState(tenantId: string, conversationId: string, patch: Record<string, unknown>) {
    await this.options.db.query(
      `update pulso_iris.conversations
       set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('sofiaState',
         coalesce(metadata->'sofiaState', '{}'::jsonb) || $3::jsonb),
         updated_at = now()
       where tenant_id = $1 and id = $2`,
      [tenantId, conversationId, JSON.stringify(patch)]
    );
  }

  private async isConfirmedAction(
    toolName: SofiaToolName,
    toolArguments: unknown,
    context: SofiaToolContext
  ): Promise<boolean> {
    const state = await this.loadConfirmationState(context.tenantId, context.conversationId);
    if (
      toolName === "book_appointment" &&
      state.confirmationGrant?.jobId === context.jobId &&
      state.confirmationGrant.tool === toolName &&
      state.confirmationGrant.holdId === readStringProperty(toolArguments, "holdId") &&
      Date.parse(state.confirmationGrant.expiresAt) >= Date.now()
    ) {
      return true;
    }

    const pending = state.pendingAction;
    if (!pending || pending.tool !== toolName || !isFresh(pending.stagedAt)) return false;
    return JSON.stringify(pending.arguments) === JSON.stringify(toolArguments);
  }

  private async loadConfirmationState(tenantId: string, conversationId: string) {
    const result = await this.options.db.query<{ state: unknown }>(
      `select coalesce(metadata->'sofiaState', '{}'::jsonb) as state
       from pulso_iris.conversations
       where tenant_id = $1 and id = $2`,
      [tenantId, conversationId]
    );
    return parseConfirmationState(result.rows[0]?.state);
  }
}

export function isExplicitConfirmation(body: string): boolean {
  const normalized = body
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /^(si\s+)?confirmo(\s+(agendar|reservar|cancelar|reagendar|la\s+cita|el\s+cambio))?$/.test(normalized);
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
    scheduledAt: { type: "string", description: "Inicio ISO 8601 exacto devuelto por disponibilidad" }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseConfirmationState(value: unknown): {
  pendingAction?: PendingAction;
  confirmationGrant?: ConfirmationGrant;
} {
  if (!isRecord(value)) return {};
  const pending = z
    .object({
      tool: z.enum([
        "get_catalog",
        "update_patient_name",
        "search_availability",
        "create_appointment_hold",
        "book_appointment",
        "list_patient_appointments",
        "cancel_appointment",
        "reschedule_appointment"
      ]),
      arguments: z.record(z.string(), z.unknown()),
      stagedAt: z.string().datetime(),
      jobId: uuid
    })
    .safeParse(value.pendingAction);
  const grant = z
    .object({
      jobId: uuid,
      tool: z.literal("book_appointment"),
      holdId: uuid,
      expiresAt: z.string().datetime()
    })
    .safeParse(value.confirmationGrant);
  return {
    pendingAction: pending.success ? pending.data : undefined,
    confirmationGrant: grant.success ? grant.data : undefined
  };
}

function isFresh(stagedAt: string): boolean {
  const age = Date.now() - Date.parse(stagedAt);
  return age >= 0 && age <= CONFIRMATION_TTL_MS;
}

function readStringProperty(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function readHoldId(value: unknown): string | undefined {
  return isRecord(value) && isRecord(value.hold) && typeof value.hold.id === "string" ? value.hold.id : undefined;
}

class ToolCallError extends Error {
  constructor(
    readonly status: number,
    readonly payload: Record<string, unknown>
  ) {
    super(`SOFIA tool failed with status ${status}`);
  }
}
