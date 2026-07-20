import { envelope, tenantIdSchema } from "@hyperion/platform-contracts";
import type { DatabaseClient } from "@hyperion/database";
import { validateInternalAuthorization, type RouteRegistrar, type ServiceContext } from "@hyperion/service-runtime";
import { z } from "zod";
import { requireChannelTenantAccess } from "./access-tenant-projections.js";

const paramsSchema = z.object({
  tenantId: tenantIdSchema,
  eventId: z.string().uuid()
});

interface ChannelEventPositionRow {
  streamId: string;
  streamSequence: string | number;
}

export function registerChannelEventPositionRoute(
  app: Parameters<RouteRegistrar>[0],
  context: ServiceContext,
  pulsoCredential: string | undefined
): void {
  app.get("/internal/v1/tenants/:tenantId/channel-inbound/:eventId/stream-position", async (request, reply) => {
    const authError = validateInternalAuthorization(request.headers, {
      "pulso-iris-service": pulsoCredential
    });
    if (authError) {
      return reply.code(authError.statusCode).send(envelope({ error: authError.message }, request.id));
    }

    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(envelope({ error: "Invalid event position request" }, request.id));
    }
    const db = context.db;
    const snapshot = await requireChannelTenantAccess(db, params.data.tenantId, reply, request.id, "exists");
    if (!snapshot || !db) return;

    let position: { streamId: string; streamSequence: number } | undefined;
    try {
      position = await findChannelEventPosition(db, params.data.tenantId, params.data.eventId);
    } catch {
      context.logger.error("channel event position ledger contains an invalid sequence", {
        tenantId: params.data.tenantId,
        eventId: params.data.eventId
      });
      return reply.code(503).send(envelope({ error: "Event stream position is unavailable" }, request.id));
    }
    if (!position) {
      return reply.code(404).send(envelope({ error: "Event stream position not found" }, request.id));
    }

    return envelope(
      {
        tenantId: params.data.tenantId,
        eventId: params.data.eventId,
        streamId: position.streamId,
        streamSequence: position.streamSequence
      },
      request.id
    );
  });
}

export async function findChannelEventPosition(
  db: DatabaseClient,
  tenantId: string,
  eventId: string
): Promise<{ streamId: string; streamSequence: number } | undefined> {
  const result = await db.query<ChannelEventPositionRow>(
    `select position.stream_id as "streamId",
            position.stream_sequence as "streamSequence"
       from channel_runtime.outbox_event_positions position
      where position.tenant_id = $1::uuid
        and position.event_id = $2::uuid`,
    [tenantId, eventId]
  );
  const row = result.rows[0];
  if (!row) return undefined;
  const streamSequence = toPositiveSafeInteger(row.streamSequence);
  if (streamSequence === undefined) throw new Error("Channel event position sequence is invalid");
  return { streamId: row.streamId, streamSequence };
}

function toPositiveSafeInteger(value: string | number): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
