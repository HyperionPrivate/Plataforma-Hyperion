import { auditEventViewListSchema, type AuditEventSourceService } from "@hyperion/audit-contracts";
import type { DatabaseExecutor } from "@hyperion/database";

export interface SourceAuditEventQuery {
  tenantId: string;
  sourceService: AuditEventSourceService;
  entityType: string;
  entityId: string;
}

export async function listSourceAuditEvents(db: DatabaseExecutor, query: SourceAuditEventQuery) {
  const result = await db.query(
    `select audit_event.id,
            audit_event.event_type as "eventType",
            audit_event.actor_id as "actorId",
            audit_event.metadata,
            audit_event.created_at as "createdAt"
       from platform.audit_events audit_event
       join audit_runtime.inbox_events inbox
         on inbox.event_id = audit_event.source_event_id
        and inbox.tenant_id = audit_event.tenant_id
      where audit_event.tenant_id = $1::uuid
        and inbox.source_service = $2
        and audit_event.entity_type = $3
        and audit_event.entity_id = $4
      order by audit_event.created_at, audit_event.id
      limit 200`,
    [query.tenantId, query.sourceService, query.entityType, query.entityId]
  );
  return auditEventViewListSchema.parse(result.rows);
}
