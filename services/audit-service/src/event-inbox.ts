import { createHash } from "node:crypto";
import { auditEventSchema, type AuditEventInput } from "@hyperion/contracts";
import type { ServiceContext } from "@hyperion/service-runtime";

const EVENT_VERSION = 1 as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const ENVELOPE_KEYS = new Set(["id", "type", "version", "occurredAt", "tenantId", "payload"]);

export const AUDIT_EVENT_CONTRACTS = {
  sofia: {
    eventType: "sofia.audit.event.record.v1",
    sourceService: "sofia-automation"
  },
  lumen: {
    eventType: "lumen.audit.event.record.v1",
    sourceService: "lumen-service"
  }
} as const;

/** Drain-only wire contract retained until the pre-provenance durable is empty. */
export const LEGACY_AUDIT_EVENT_CONTRACT = {
  eventType: "audit.event.record.v1",
  persistedEventType: "legacy.audit.event.record.v1",
  sourceService: "legacy-unknown"
} as const;

export type AuditEventContract = (typeof AUDIT_EVENT_CONTRACTS)[keyof typeof AUDIT_EVENT_CONTRACTS];
export type AuditEventType = AuditEventContract["eventType"] | typeof LEGACY_AUDIT_EVENT_CONTRACT.persistedEventType;
export type AuditSourceService = AuditEventContract["sourceService"] | typeof LEGACY_AUDIT_EVENT_CONTRACT.sourceService;

interface ResolvedAuditEventContract {
  readonly wireEventType: string;
  readonly persistedEventType: AuditEventType;
  readonly sourceService: AuditSourceService;
}

type DatabaseClient = NonNullable<ServiceContext["db"]>;

export interface InternalAuditEventEnvelope {
  id: string;
  type: AuditEventType;
  version: typeof EVENT_VERSION;
  occurredAt: string;
  tenantId: string | null;
  /** Derived from the accepted event type; callers cannot persist an arbitrary origin. */
  sourceService: AuditSourceService;
  payload: AuditEventInput;
}

export interface StoredAuditEvent {
  id: string;
  tenant_id: string | null;
  actor_id: string | null;
  event_type: string;
  entity_type: string;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  source_event_id: string;
  created_at: string | Date;
}

export type AuditInboxResult =
  | { status: "accepted"; eventId: string; auditEvent: StoredAuditEvent }
  | { status: "duplicate"; eventId: string }
  | { status: "conflict"; eventId: string };

export type AuditEnvelopeParseResult =
  { success: true; data: InternalAuditEventEnvelope } | { success: false; issues: string[] };

export function parseInternalAuditEventEnvelope(
  body: unknown,
  expectedSourceService?: AuditSourceService
): AuditEnvelopeParseResult {
  return parseAuditEventEnvelope(
    body,
    Object.values(AUDIT_EVENT_CONTRACTS).map((contract) => ({
      wireEventType: contract.eventType,
      persistedEventType: contract.eventType,
      sourceService: contract.sourceService
    })),
    expectedSourceService
  );
}

export function parseLegacyAuditEventEnvelope(body: unknown): AuditEnvelopeParseResult {
  return parseAuditEventEnvelope(body, [
    {
      wireEventType: LEGACY_AUDIT_EVENT_CONTRACT.eventType,
      persistedEventType: LEGACY_AUDIT_EVENT_CONTRACT.persistedEventType,
      sourceService: LEGACY_AUDIT_EVENT_CONTRACT.sourceService
    }
  ]);
}

function parseAuditEventEnvelope(
  body: unknown,
  contracts: readonly ResolvedAuditEventContract[],
  expectedSourceService?: AuditSourceService
): AuditEnvelopeParseResult {
  if (!isRecord(body)) {
    return { success: false, issues: ["Envelope must be a JSON object"] };
  }

  const unexpectedKeys = Object.keys(body).filter((key) => !ENVELOPE_KEYS.has(key));
  if (unexpectedKeys.length > 0) {
    return { success: false, issues: ["Envelope contains unsupported fields"] };
  }

  const issues: string[] = [];
  if (typeof body.id !== "string" || !UUID_PATTERN.test(body.id)) {
    issues.push("id must be a UUID");
  }
  const contract = resolveAuditEventContract(body.type, contracts);
  if (!contract) {
    issues.push(`type must be one of: ${contracts.map(({ wireEventType }) => wireEventType).join(", ")}`);
  } else if (expectedSourceService && contract.sourceService !== expectedSourceService) {
    issues.push(`type does not belong to ${expectedSourceService}`);
  }
  if (body.version !== EVENT_VERSION) {
    issues.push(`version must be ${EVENT_VERSION}`);
  }
  if (typeof body.occurredAt !== "string" || !isIsoDateTime(body.occurredAt)) {
    issues.push("occurredAt must be an ISO datetime with a timezone");
  }
  if (
    Object.hasOwn(body, "tenantId") &&
    body.tenantId !== null &&
    (typeof body.tenantId !== "string" || !UUID_PATTERN.test(body.tenantId))
  ) {
    issues.push("tenantId must be a UUID or null");
  }

  const parsedPayload = auditEventSchema.safeParse(body.payload);
  if (!parsedPayload.success) {
    issues.push("payload must match auditEventSchema");
  }

  if (
    parsedPayload.success &&
    isValidNullableTenantId(body.tenantId) &&
    normalizeTenantId(body.tenantId) !== normalizeTenantId(parsedPayload.data.tenantId)
  ) {
    issues.push("tenantId must match payload.tenantId");
  }

  if (issues.length > 0 || !parsedPayload.success || !contract) {
    return { success: false, issues };
  }

  return {
    success: true,
    data: {
      id: body.id as string,
      type: contract.persistedEventType,
      version: EVENT_VERSION,
      occurredAt: body.occurredAt as string,
      tenantId: (body.tenantId as string | null | undefined) ?? null,
      sourceService: contract.sourceService,
      payload: parsedPayload.data
    }
  };
}

export function hashAuditPayload(payload: AuditEventInput): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/**
 * Binds idempotency to the declared producer contract as well as its payload.
 * The unit separator is safe because contract names are fixed and the remaining
 * fields are validated integers, UUIDs and lowercase SHA-256 values.
 */
export function hashAuditContract(
  event: InternalAuditEventEnvelope,
  payloadHash = hashAuditPayload(event.payload)
): string {
  return createHash("sha256")
    .update(
      [
        event.sourceService,
        event.type,
        String(event.version),
        normalizeTenantId(event.tenantId) ?? "<none>",
        payloadHash
      ].join("\u001f")
    )
    .digest("hex");
}

export async function receiveInternalAuditEvent(
  db: DatabaseClient,
  event: InternalAuditEventEnvelope
): Promise<AuditInboxResult> {
  const payloadHash = hashAuditPayload(event.payload);
  const contractHash = hashAuditContract(event, payloadHash);

  return db.transaction(async (transaction) => {
    const insertedInboxEvent = await transaction.query<{ event_id: string }>(
      `
        insert into audit_runtime.inbox_events (
          event_id, tenant_id, source_service, event_type, event_version,
          payload_hash, contract_hash, occurred_at
        )
        values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::timestamptz)
        on conflict (event_id) do nothing
        returning event_id
      `,
      [
        event.id,
        event.tenantId,
        event.sourceService,
        event.type,
        event.version,
        payloadHash,
        contractHash,
        event.occurredAt
      ]
    );

    if (insertedInboxEvent.rows.length === 0) {
      const existingInboxEvent = await transaction.query<{ contract_hash: string; occurred_at: string | Date }>(
        `
          select contract_hash, occurred_at
          from audit_runtime.inbox_events
          where event_id = $1::uuid
        `,
        [event.id]
      );
      const existing = existingInboxEvent.rows[0];

      if (!existing) {
        throw new Error("Inbox event disappeared after a uniqueness conflict");
      }

      return existing.contract_hash === contractHash && sameInstant(existing.occurred_at, event.occurredAt)
        ? { status: "duplicate", eventId: event.id }
        : { status: "conflict", eventId: event.id };
    }

    const auditEvent = event.payload;
    const insertedAuditEvent = await transaction.query<StoredAuditEvent>(
      `
        insert into platform.audit_events (
          tenant_id, actor_id, event_type, entity_type, entity_id, metadata, source_event_id
        )
        values ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7::uuid)
        returning id, tenant_id, actor_id, event_type, entity_type, entity_id, metadata,
          source_event_id, created_at
      `,
      [
        auditEvent.tenantId ?? null,
        auditEvent.actorId ?? null,
        auditEvent.eventType,
        auditEvent.entityType,
        auditEvent.entityId ?? null,
        JSON.stringify(auditEvent.metadata),
        event.id
      ]
    );
    const storedAuditEvent = insertedAuditEvent.rows[0];

    if (!storedAuditEvent) {
      throw new Error("Audit event insert returned no row");
    }

    return { status: "accepted", eventId: event.id, auditEvent: storedAuditEvent };
  });
}

function canonicalJson(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }

  throw new TypeError("Audit payload contains a non-JSON value");
}

function isIsoDateTime(value: string): boolean {
  return ISO_DATETIME_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function isValidNullableTenantId(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || (typeof value === "string" && UUID_PATTERN.test(value));
}

function normalizeTenantId(value: string | null | undefined): string | null {
  return value?.toLowerCase() ?? null;
}

function resolveAuditEventContract(
  value: unknown,
  contracts: readonly ResolvedAuditEventContract[]
): ResolvedAuditEventContract | undefined {
  return contracts.find(({ wireEventType }) => wireEventType === value);
}

function sameInstant(left: string | Date, right: string): boolean {
  const leftEpoch = left instanceof Date ? left.getTime() : Date.parse(left);
  return Number.isFinite(leftEpoch) && leftEpoch === Date.parse(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
