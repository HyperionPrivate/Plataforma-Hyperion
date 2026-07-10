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
    description:
      "Consulta disponibilidad real configurada. Muestra al paciente exclusivamente localDate y localTime en timeZone; nunca presentes startsAt o scheduledAt como hora local. Al crear o reagendar, copia exactamente el valor UTC de scheduledAt/startsAt devuelto por el slot, sin reinterpretarlo ni convertirlo. Nunca inventes horarios fuera del resultado.",
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
  actionId: string;
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
      if (
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
        const parsed = parseRawToolArguments(toolName, rawArguments);
        if (!parsed.ok) return parsed.error;
        const staged = await this.stagePendingAction(toolName, parsed.data, context, state);
        if (!staged) return confirmationStateChanged();
        return confirmationStaged("La acción no estaba preparada y no fue ejecutada.");
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
        const staged = await this.stagePendingAction(toolName, toolArguments, context, state);
        if (!staged) return confirmationStateChanged();
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
    } else if (toolName === "book_appointment") {
      await this.clearConfirmedGrant(
        context.tenantId,
        context.conversationId,
        confirmedActionId!,
        String(toolArguments.holdId)
      );
    } else if (isMutation(toolName)) {
      await this.clearConfirmedPending(context.tenantId, context.conversationId, confirmedActionId!);
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
    const updated = await this.options.db.query(
      `update pulso_iris.conversations
       set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('sofiaState',
         coalesce(metadata->'sofiaState', '{}'::jsonb) || $5::jsonb),
         updated_at = now()
       where tenant_id = $1 and id = $2
         and (($3::text is null
               and coalesce(metadata #> '{sofiaState,pendingAction}', 'null'::jsonb) = 'null'::jsonb)
              or metadata #>> '{sofiaState,pendingAction,jobId}' = $3)
         and (($4::text is null
               and coalesce(metadata #> '{sofiaState,confirmationGrant}', 'null'::jsonb) = 'null'::jsonb)
              or coalesce(metadata #>> '{sofiaState,confirmationGrant,actionId}',
                          metadata #>> '{sofiaState,confirmationGrant,jobId}') = $4)`,
      [
        context.tenantId,
        context.conversationId,
        expected.pendingAction?.jobId ?? null,
        expected.confirmationGrant?.actionId ?? null,
        JSON.stringify(patch)
      ]
    );
    return (updated.rowCount ?? 0) > 0;
  }

  private async replacePendingWithGrant(
    tenantId: string,
    conversationId: string,
    actionId: string,
    grant: ConfirmationGrant | null
  ): Promise<void> {
    await this.options.db.query(
      `update pulso_iris.conversations
       set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('sofiaState',
         coalesce(metadata->'sofiaState', '{}'::jsonb) || $4::jsonb),
         updated_at = now()
       where tenant_id = $1 and id = $2
         and metadata #>> '{sofiaState,pendingAction,jobId}' = $3`,
      [tenantId, conversationId, actionId, JSON.stringify({ pendingAction: null, confirmationGrant: grant })]
    );
  }

  private async clearConfirmedGrant(
    tenantId: string,
    conversationId: string,
    actionId: string,
    holdId: string
  ): Promise<void> {
    await this.options.db.query(
      `update pulso_iris.conversations
       set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('sofiaState',
         coalesce(metadata->'sofiaState', '{}'::jsonb)
           || '{"pendingAction":null,"confirmationGrant":null}'::jsonb),
         updated_at = now()
       where tenant_id = $1 and id = $2
         and coalesce(metadata #>> '{sofiaState,confirmationGrant,actionId}',
                      metadata #>> '{sofiaState,confirmationGrant,jobId}') = $3
         and metadata #>> '{sofiaState,confirmationGrant,holdId}' = $4`,
      [tenantId, conversationId, actionId, holdId]
    );
  }

  private async clearConfirmedPending(tenantId: string, conversationId: string, actionId: string): Promise<void> {
    await this.options.db.query(
      `update pulso_iris.conversations
       set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('sofiaState',
         coalesce(metadata->'sofiaState', '{}'::jsonb)
           || '{"pendingAction":null,"confirmationGrant":null}'::jsonb),
         updated_at = now()
       where tenant_id = $1 and id = $2
         and metadata #>> '{sofiaState,pendingAction,jobId}' = $3`,
      [tenantId, conversationId, actionId]
    );
  }

  private async loadConfirmationState(tenantId: string, conversationId: string) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await this.options.db.query<{
        state: unknown;
        pendingExpired: boolean;
        grantExpired: boolean;
      }>(
        `select coalesce(metadata->'sofiaState', '{}'::jsonb) as state,
                coalesce((metadata #>> '{sofiaState,pendingAction,stagedAt}')::timestamptz
                  + interval '15 minutes' <= now(), false) as "pendingExpired",
                coalesce((metadata #>> '{sofiaState,confirmationGrant,expiresAt}')::timestamptz
                  <= now(), false) as "grantExpired"
         from pulso_iris.conversations
         where tenant_id = $1 and id = $2`,
        [tenantId, conversationId]
      );
      const row = result.rows[0];
      const state = parseConfirmationState(row?.state);
      const expiredPending = row?.pendingExpired ? state.pendingAction : undefined;
      const expiredGrant = row?.grantExpired ? state.confirmationGrant : undefined;
      if (!expiredPending && !expiredGrant) return state;

      const patch = {
        ...(expiredPending ? { pendingAction: null } : {}),
        ...(expiredGrant ? { confirmationGrant: null } : {})
      };
      const cleared = await this.options.db.query<{ state: unknown }>(
        `update pulso_iris.conversations
         set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('sofiaState',
           coalesce(metadata->'sofiaState', '{}'::jsonb) || $8::jsonb),
           updated_at = now()
         where tenant_id = $1 and id = $2
           and ($3::text is null or (
             metadata #>> '{sofiaState,pendingAction,jobId}' = $3
             and metadata #>> '{sofiaState,pendingAction,stagedAt}' = $4
             and (metadata #>> '{sofiaState,pendingAction,stagedAt}')::timestamptz
               + interval '15 minutes' <= now()
           ))
           and ($5::text is null or (
             coalesce(metadata #>> '{sofiaState,confirmationGrant,actionId}',
                      metadata #>> '{sofiaState,confirmationGrant,jobId}') = $5
             and metadata #>> '{sofiaState,confirmationGrant,holdId}' = $6
             and metadata #>> '{sofiaState,confirmationGrant,expiresAt}' = $7
             and (metadata #>> '{sofiaState,confirmationGrant,expiresAt}')::timestamptz <= now()
           ))
         returning coalesce(metadata->'sofiaState', '{}'::jsonb) as state`,
        [
          tenantId,
          conversationId,
          expiredPending?.jobId ?? null,
          expiredPending?.stagedAt ?? null,
          expiredGrant?.actionId ?? null,
          expiredGrant?.holdId ?? null,
          expiredGrant?.expiresAt ?? null,
          JSON.stringify(patch)
        ]
      );
      if (cleared.rows[0]) return parseConfirmationState(cleared.rows[0].state);
    }
    throw new Error("Confirmation state changed concurrently");
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

function confirmationRequired(detail: string): Record<string, unknown> {
  return {
    ok: false,
    code: "explicit_confirmation_required",
    message: `${detail} Pide al paciente que responda exactamente CONFIRMO en un mensaje nuevo.`
  };
}

function confirmationStaged(detail: string): Record<string, unknown> {
  return {
    ok: false,
    code: "confirmation_action_staged",
    message: `${detail} Presenta sus datos exactos y pide al paciente un nuevo mensaje CONFIRMO.`
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
      actionId: uuid.optional(),
      jobId: uuid.optional(),
      tool: z.literal("book_appointment"),
      holdId: uuid,
      expiresAt: z.string().datetime()
    })
    .refine((value) => Boolean(value.actionId ?? value.jobId))
    .safeParse(value.confirmationGrant);
  return {
    pendingAction: pending.success ? pending.data : undefined,
    confirmationGrant: grant.success
      ? {
          actionId: grant.data.actionId ?? grant.data.jobId!,
          tool: grant.data.tool,
          holdId: grant.data.holdId,
          expiresAt: grant.data.expiresAt
        }
      : undefined
  };
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
