import { envelope, tenantIdSchema } from "@hyperion/contracts";
import { validateInternalAuthorization, type RouteRegistrar, type ServiceContext } from "@hyperion/service-runtime";
import { z } from "zod";

const paramsSchema = z.object({
  tenantId: tenantIdSchema,
  eventId: z.string().uuid()
});

interface PulsoEventPositionRow {
  streamId: string;
  streamSequence: string | number;
  sourceStreamId: string;
  sourceStreamSequence: string | number;
}

export function registerPulsoEventPositionRoute(
  app: Parameters<RouteRegistrar>[0],
  context: ServiceContext,
  sofiaCredential: string | undefined
): void {
  app.get("/internal/v1/tenants/:tenantId/pulso-message/:eventId/stream-position", async (request, reply) => {
    const authError = validateInternalAuthorization(request.headers, {
      "agent-service": sofiaCredential
    });
    if (authError) {
      return reply.code(authError.statusCode).send(envelope({ error: authError.message }, request.id));
    }
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(envelope({ error: "Invalid event position request" }, request.id));
    }
    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    const result = await context.db.query<PulsoEventPositionRow>(
      `select position.stream_id as "streamId",
              position.stream_sequence as "streamSequence",
              position.source_stream_id as "sourceStreamId",
              position.source_stream_sequence as "sourceStreamSequence"
         from pulso_iris.outbox_event_positions position
        where position.tenant_id = $1::uuid
          and position.event_id = $2::uuid`,
      [params.data.tenantId, params.data.eventId]
    );
    const row = result.rows[0];
    if (!row) {
      return reply.code(404).send(envelope({ error: "Event stream position not found" }, request.id));
    }
    const streamSequence = toPositiveSafeInteger(row.streamSequence);
    const sourceStreamSequence = toPositiveSafeInteger(row.sourceStreamSequence);
    if (streamSequence === undefined || sourceStreamSequence === undefined) {
      context.logger.error("PULSO event position ledger contains an invalid sequence", {
        tenantId: params.data.tenantId,
        eventId: params.data.eventId
      });
      return reply.code(503).send(envelope({ error: "Event stream position is unavailable" }, request.id));
    }

    return envelope(
      {
        tenantId: params.data.tenantId,
        eventId: params.data.eventId,
        streamId: row.streamId,
        streamSequence,
        sourceStreamId: row.sourceStreamId,
        sourceStreamSequence
      },
      request.id
    );
  });
}

function toPositiveSafeInteger(value: string | number): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
