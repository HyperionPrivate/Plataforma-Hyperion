export const AUDIT_BASELINE_MIGRATION = "001-audit-autonomous-baseline.sql" as const;
export const AUDIT_PROVIDER_MIGRATIONS = [AUDIT_BASELINE_MIGRATION] as const;
export const AUDIT_PROVIDER_LEDGER = [
  {
    name: AUDIT_BASELINE_MIGRATION,
    checksum: "30ec6157679c70641ea6ce9c030a84e0938258167888a04eb4af18798db0a571"
  }
] as const;
export const AUDIT_PROVIDER_SCHEMAS = ["platform", "audit_runtime"] as const;
export const AUDIT_PROVIDER_TABLES = [
  "platform.audit_events",
  "audit_runtime.inbox_events",
  "audit_runtime.migration_ledger"
] as const;

export const AUDIT_SOURCE_CONTRACTS = [
  { sourceService: "nova-core-service", eventType: "nova.audit.event.record.v1" },
  { sourceService: "sofia-automation", eventType: "sofia.audit.event.record.v1" },
  { sourceService: "lumen-service", eventType: "lumen.audit.event.record.v1" },
  { sourceService: "pulso-iris-service", eventType: "pulso.audit.event.record.v1" },
  { sourceService: "whatsapp-channel-service", eventType: "channel.audit.event.record.v1" },
  { sourceService: "legacy-unknown", eventType: "legacy.audit.event.record.v1" }
] as const;

export const AUDIT_RUNTIME_MIGRATION_REQUIREMENT = {
  schema: "audit_runtime",
  migrationNames: AUDIT_PROVIDER_MIGRATIONS,
  exactMigrationLedger: AUDIT_PROVIDER_LEDGER
} as const;

export interface AuditSchemaClient {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export interface AuditSchemaInspection {
  ledgerPresent: boolean;
  auditEventsPresent: boolean;
  inboxPresent: boolean;
  sourceContractValid: boolean;
  sourceContractDefinition: string | null;
}

export async function inspectAuditSchema(client: AuditSchemaClient): Promise<AuditSchemaInspection> {
  const relations = await client.query<{
    ledger_present: boolean;
    audit_events_present: boolean;
    inbox_present: boolean;
  }>(`
    select to_regclass('audit_runtime.migration_ledger') is not null as ledger_present,
           to_regclass('platform.audit_events') is not null as audit_events_present,
           to_regclass('audit_runtime.inbox_events') is not null as inbox_present
  `);
  const relation = relations.rows[0];
  if (!relation) throw new Error("Audit schema inspection returned no relation state");

  if (!relation.inbox_present) {
    return {
      ledgerPresent: relation.ledger_present,
      auditEventsPresent: relation.audit_events_present,
      inboxPresent: false,
      sourceContractValid: false,
      sourceContractDefinition: null
    };
  }

  const constraint = await client.query<{ definition: string; validated: boolean }>(`
    select pg_get_constraintdef(constraint_catalog.oid, true) as definition,
           constraint_catalog.convalidated as validated
      from pg_constraint constraint_catalog
     where constraint_catalog.conrelid = 'audit_runtime.inbox_events'::regclass
       and constraint_catalog.conname = 'ck_audit_inbox_source_contract'
  `);
  const sourceContract = constraint.rows[0];
  const definition = sourceContract?.definition ?? null;
  const containsEveryContract = AUDIT_SOURCE_CONTRACTS.every(
    ({ sourceService, eventType }) => definition?.includes(sourceService) && definition.includes(eventType)
  );
  return {
    ledgerPresent: relation.ledger_present,
    auditEventsPresent: relation.audit_events_present,
    inboxPresent: true,
    sourceContractValid: Boolean(sourceContract?.validated && containsEveryContract),
    sourceContractDefinition: definition
  };
}

export function assertAuditSchemaReady(inspection: AuditSchemaInspection): void {
  if (!inspection.ledgerPresent || !inspection.auditEventsPresent || !inspection.inboxPresent) {
    throw new Error("Audit provider schema is incomplete");
  }
  if (!inspection.sourceContractValid) {
    throw new Error("Audit source contract is missing, unvalidated, or incomplete");
  }
}
