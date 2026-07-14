import type { DatabaseClient } from "@hyperion/database";

const CONFIRMATION_EXECUTION_LEASE_MS = 5 * 60 * 1_000;

type ConfirmableToolName = "create_appointment_hold" | "cancel_appointment" | "reschedule_appointment";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asConfirmableTool(value: unknown): ConfirmableToolName {
  if (value === "cancel_appointment" || value === "reschedule_appointment" || value === "create_appointment_hold") {
    return value;
  }
  return "create_appointment_hold";
}

/**
 * Test-only owner-state transport that applies the PULSO confirmation CAS against a shared
 * admin database URL. Production SOFIA always reaches PULSO over HTTP.
 */
export function createIntegrationOwnerState(db: DatabaseClient) {
  return {
    async load(tenantId: string, conversationId: string) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = await db.query<{
          state: unknown;
          pendingExpired: boolean;
          grantExpired: boolean;
          executionExpired: boolean;
        }>(
          `select coalesce(metadata->'sofiaState', '{}'::jsonb) as state,
                  coalesce((metadata #>> '{sofiaState,pendingAction,stagedAt}')::timestamptz
                    + interval '15 minutes' <= now(), false) as "pendingExpired",
                  coalesce((metadata #>> '{sofiaState,confirmationGrant,expiresAt}')::timestamptz
                    <= now(), false) as "grantExpired",
                  coalesce((metadata #>> '{sofiaState,confirmationExecution,claimedAt}')::timestamptz
                    + ($3::int * interval '1 millisecond') <= now(), false) as "executionExpired"
           from pulso_iris.conversations
           where tenant_id = $1 and id = $2`,
          [tenantId, conversationId, CONFIRMATION_EXECUTION_LEASE_MS]
        );
        const row = result.rows[0];
        const state = asRecord(row?.state);
        const confirmationExecution = asRecord(state.confirmationExecution);
        const pendingAction = asRecord(state.pendingAction);
        const confirmationGrant = asRecord(state.confirmationGrant);

        if (row?.executionExpired && Object.keys(confirmationExecution).length > 0) {
          const receipt = {
            schemaVersion: 1,
            confirmationMessageId: String(confirmationExecution.confirmationMessageId ?? ""),
            actionId: String(confirmationExecution.actionId ?? ""),
            action: "book",
            outcome: "terminal_failure",
            completedAt: new Date().toISOString(),
            code: "confirmation_execution_expired",
            message:
              "La operación quedó sin evidencia concluyente. Consulta el estado actual antes de intentar otra acción."
          };
          const cleared = await db.query<{ state: unknown }>(
            `update pulso_iris.conversations
             set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
               'sofiaState',
               (coalesce(metadata->'sofiaState', '{}'::jsonb)
                 - 'lastAvailability'
                 - 'lastAvailabilityAt'
                 - 'lastAvailabilitySchemaVersion'
                 - 'lastAvailabilityJobId'
                 - 'lastAvailabilityQuery')
                 || jsonb_build_object(
                      'confirmationExecution', null,
                      'confirmationGrant', null,
                      'confirmationReceipts',
                        coalesce(metadata #> '{sofiaState,confirmationReceipts}', '{}'::jsonb)
                          || jsonb_build_object($4::text, $8::jsonb)
                    )
             ), updated_at = now()
             where tenant_id = $1 and id = $2
               and metadata #>> '{sofiaState,confirmationExecution,actionId}' = $3
               and metadata #>> '{sofiaState,confirmationExecution,confirmationMessageId}' = $4
               and metadata #>> '{sofiaState,confirmationExecution,tool}' = $5
               and metadata #>> '{sofiaState,confirmationExecution,claimedAt}' = $6
               and (metadata #>> '{sofiaState,confirmationExecution,claimedAt}')::timestamptz
                 + ($7::int * interval '1 millisecond') <= now()
             returning coalesce(metadata->'sofiaState', '{}'::jsonb) as state`,
            [
              tenantId,
              conversationId,
              confirmationExecution.actionId,
              confirmationExecution.confirmationMessageId,
              confirmationExecution.tool,
              confirmationExecution.claimedAt,
              CONFIRMATION_EXECUTION_LEASE_MS,
              JSON.stringify(receipt)
            ]
          );
          if (cleared.rows[0]) return { state: cleared.rows[0].state };
          continue;
        }

        const expiredPending = row?.pendingExpired ? pendingAction : undefined;
        const expiredGrant = row?.grantExpired ? confirmationGrant : undefined;
        if (!expiredPending && !expiredGrant) return { state };

        const patch = {
          ...(expiredPending ? { pendingAction: null } : {}),
          ...(expiredGrant ? { confirmationGrant: null } : {})
        };
        const cleared = await db.query<{ state: unknown }>(
          `update pulso_iris.conversations
           set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('sofiaState',
             coalesce(metadata->'sofiaState', '{}'::jsonb) || $3::jsonb),
             updated_at = now()
           where tenant_id = $1 and id = $2
           returning coalesce(metadata->'sofiaState', '{}'::jsonb) as state`,
          [tenantId, conversationId, JSON.stringify(patch)]
        );
        if (cleared.rows[0]) {
          return {
            state: cleared.rows[0].state,
            expiredAction: expiredPending
              ? {
                  actionId: String(expiredPending.jobId),
                  tool: asConfirmableTool(expiredPending.tool)
                }
              : expiredGrant
                ? {
                    actionId: String(expiredGrant.actionId ?? expiredGrant.jobId),
                    tool: "create_appointment_hold" as const
                  }
                : undefined
          };
        }
      }
      return { state: {} };
    },

    async mutate(tenantId: string, conversationId: string, mutation: Record<string, unknown>) {
      switch (mutation.op) {
        case "claim_pending_action": {
          const result = await db.query(
            `update pulso_iris.conversations
             set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
               'sofiaState',
               coalesce(metadata->'sofiaState', '{}'::jsonb) || jsonb_build_object(
                 'pendingAction', null,
                 'confirmationGrant', null,
                 'confirmationExecution', $5::jsonb
               )
             ), updated_at = now()
             where tenant_id = $1 and id = $2
               and metadata #>> '{sofiaState,pendingAction,jobId}' = $3
               and metadata #>> '{sofiaState,pendingAction,tool}' = $4
               and coalesce(metadata #> '{sofiaState,confirmationExecution}', 'null'::jsonb) = 'null'::jsonb
               and coalesce(metadata #> '{sofiaState,confirmationGrant}', 'null'::jsonb) = 'null'::jsonb`,
            [tenantId, conversationId, mutation.pendingJobId, mutation.pendingTool, JSON.stringify(mutation.execution)]
          );
          return (result.rowCount ?? 0) > 0;
        }
        case "store_execution_receipt": {
          const result = await db.query(
            `update pulso_iris.conversations
             set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
               'sofiaState',
               (coalesce(metadata->'sofiaState', '{}'::jsonb)
                 - 'lastAvailability'
                 - 'lastAvailabilityAt'
                 - 'lastAvailabilitySchemaVersion'
                 - 'lastAvailabilityJobId'
                 - 'lastAvailabilityQuery')
                 || jsonb_build_object(
                      'pendingAction', null,
                      'confirmationExecution', null,
                      'confirmationGrant', null,
                      'confirmationReceipts',
                        coalesce(metadata #> '{sofiaState,confirmationReceipts}', '{}'::jsonb)
                          || jsonb_build_object($4::text, $6::jsonb)
                    )
             ), updated_at = now()
             where tenant_id = $1 and id = $2
               and metadata #>> '{sofiaState,confirmationExecution,actionId}' = $3
               and metadata #>> '{sofiaState,confirmationExecution,confirmationMessageId}' = $4
               and metadata #>> '{sofiaState,confirmationExecution,tool}' = $5`,
            [
              tenantId,
              conversationId,
              mutation.executionActionId,
              mutation.confirmationMessageId,
              mutation.executionTool,
              JSON.stringify(mutation.receipt)
            ]
          );
          return (result.rowCount ?? 0) > 0;
        }
        case "store_pending_receipt": {
          const result = await db.query(
            `update pulso_iris.conversations
             set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
               'sofiaState',
               (coalesce(metadata->'sofiaState', '{}'::jsonb)
                 - 'lastAvailability'
                 - 'lastAvailabilityAt'
                 - 'lastAvailabilitySchemaVersion'
                 - 'lastAvailabilityJobId'
                 - 'lastAvailabilityQuery')
                 || jsonb_build_object(
                      'pendingAction', null,
                      'confirmationExecution', null,
                      'confirmationGrant', null,
                      'confirmationReceipts',
                        coalesce(metadata #> '{sofiaState,confirmationReceipts}', '{}'::jsonb)
                          || jsonb_build_object($4::text, $6::jsonb)
                    )
             ), updated_at = now()
             where tenant_id = $1 and id = $2
               and metadata #>> '{sofiaState,pendingAction,jobId}' = $3
               and metadata #>> '{sofiaState,pendingAction,tool}' = $5`,
            [
              tenantId,
              conversationId,
              mutation.pendingJobId,
              mutation.currentMessageId,
              mutation.pendingTool,
              JSON.stringify(mutation.receipt)
            ]
          );
          return (result.rowCount ?? 0) > 0;
        }
        case "stage_pending_action": {
          const updated = await db.query(
            `update pulso_iris.conversations
             set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('sofiaState',
               coalesce(metadata->'sofiaState', '{}'::jsonb) || $5::jsonb),
               updated_at = now()
             where tenant_id = $1 and id = $2
               and coalesce(metadata #> '{sofiaState,confirmationExecution}', 'null'::jsonb) = 'null'::jsonb
               and (($3::text is null
                     and coalesce(metadata #> '{sofiaState,pendingAction}', 'null'::jsonb) = 'null'::jsonb)
                    or metadata #>> '{sofiaState,pendingAction,jobId}' = $3)
               and (($4::text is null
                     and coalesce(metadata #> '{sofiaState,confirmationGrant}', 'null'::jsonb) = 'null'::jsonb)
                    or coalesce(metadata #>> '{sofiaState,confirmationGrant,actionId}',
                                metadata #>> '{sofiaState,confirmationGrant,jobId}') = $4)`,
            [
              tenantId,
              conversationId,
              mutation.expectedPendingJobId ?? null,
              mutation.expectedGrantActionId ?? null,
              JSON.stringify(mutation.patch)
            ]
          );
          return (updated.rowCount ?? 0) > 0;
        }
        case "save_conversation_state":
        case "replace_pending_with_grant": {
          await db.query(
            `update pulso_iris.conversations
             set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('sofiaState',
               coalesce(metadata->'sofiaState', '{}'::jsonb) || $3::jsonb),
               updated_at = now()
             where tenant_id = $1 and id = $2`,
            [tenantId, conversationId, JSON.stringify(mutation.patch)]
          );
          return true;
        }
        case "save_availability_state": {
          await db.query(
            `update pulso_iris.conversations
             set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
               'sofiaState',
               coalesce(metadata->'sofiaState', '{}'::jsonb)
                 || $3::jsonb
                 || jsonb_build_object(
                      'agendaSelection',
                      coalesce(metadata #> '{sofiaState,agendaSelection}', '{}'::jsonb) || $4::jsonb
                    )
             ), updated_at = now()
             where tenant_id = $1 and id = $2`,
            [tenantId, conversationId, JSON.stringify(mutation.availabilityPatch), JSON.stringify(mutation.selection)]
          );
          return true;
        }
        case "clear_last_availability": {
          await db.query(
            `update pulso_iris.conversations
             set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
               'sofiaState',
               coalesce(metadata->'sofiaState', '{}'::jsonb)
                 - 'lastAvailability'
                 - 'lastAvailabilityAt'
                 - 'lastAvailabilitySchemaVersion'
                 - 'lastAvailabilityJobId'
                 - 'lastAvailabilityQuery'
             ), updated_at = now()
             where tenant_id = $1 and id = $2`,
            [tenantId, conversationId]
          );
          return true;
        }
        case "clear_confirmed_grant": {
          await db.query(
            `update pulso_iris.conversations
             set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('sofiaState',
               coalesce(metadata->'sofiaState', '{}'::jsonb)
                 || jsonb_build_object('confirmationGrant', null, 'pendingAction', null)),
               updated_at = now()
             where tenant_id = $1 and id = $2
               and coalesce(metadata #>> '{sofiaState,confirmationGrant,actionId}',
                            metadata #>> '{sofiaState,confirmationGrant,jobId}') = $3
               and metadata #>> '{sofiaState,confirmationGrant,holdId}' = $4`,
            [tenantId, conversationId, mutation.actionId, mutation.holdId]
          );
          return true;
        }
        case "clear_confirmed_pending": {
          await db.query(
            `update pulso_iris.conversations
             set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('sofiaState',
               coalesce(metadata->'sofiaState', '{}'::jsonb)
                 || jsonb_build_object('pendingAction', null, 'confirmationGrant', null)),
               updated_at = now()
             where tenant_id = $1 and id = $2
               and metadata #>> '{sofiaState,pendingAction,jobId}' = $3`,
            [tenantId, conversationId, mutation.actionId]
          );
          return true;
        }
        case "move_execution_to_grant": {
          const result = await db.query(
            `update pulso_iris.conversations
             set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
               'sofiaState',
               coalesce(metadata->'sofiaState', '{}'::jsonb) || jsonb_build_object(
                 'pendingAction', null,
                 'confirmationExecution', null,
                 'confirmationGrant', $6::jsonb
               )
             ), updated_at = now()
             where tenant_id = $1 and id = $2
               and metadata #>> '{sofiaState,confirmationExecution,actionId}' = $3
               and metadata #>> '{sofiaState,confirmationExecution,confirmationMessageId}' = $4
               and metadata #>> '{sofiaState,confirmationExecution,tool}' = $5`,
            [
              tenantId,
              conversationId,
              mutation.executionActionId,
              mutation.confirmationMessageId,
              mutation.executionTool,
              JSON.stringify(mutation.grant)
            ]
          );
          return (result.rowCount ?? 0) > 0;
        }
        case "store_grant_receipt": {
          const result = await db.query(
            `update pulso_iris.conversations
             set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
               'sofiaState',
               (coalesce(metadata->'sofiaState', '{}'::jsonb)
                 - 'lastAvailability'
                 - 'lastAvailabilityAt'
                 - 'lastAvailabilitySchemaVersion'
                 - 'lastAvailabilityJobId'
                 - 'lastAvailabilityQuery')
                 || jsonb_build_object(
                      'pendingAction', null,
                      'confirmationExecution', null,
                      'confirmationGrant', null,
                      'confirmationReceipts',
                        coalesce(metadata #> '{sofiaState,confirmationReceipts}', '{}'::jsonb)
                          || jsonb_build_object($4::text, $6::jsonb)
                    )
             ), updated_at = now()
             where tenant_id = $1 and id = $2
               and coalesce(metadata #>> '{sofiaState,confirmationGrant,actionId}',
                            metadata #>> '{sofiaState,confirmationGrant,jobId}') = $3
               and ($7::text is null
                    or metadata #>> '{sofiaState,confirmationGrant,confirmationMessageId}' = $7)
               and metadata #>> '{sofiaState,confirmationGrant,holdId}' = $5`,
            [
              tenantId,
              conversationId,
              mutation.grantActionId,
              mutation.currentMessageId,
              mutation.holdId,
              JSON.stringify(mutation.receipt),
              mutation.confirmationMessageId ?? null
            ]
          );
          return (result.rowCount ?? 0) > 0;
        }
        default:
          return false;
      }
    }
  };
}
