import { timingSafeEqual } from "node:crypto";
import { auditEventSchema, envelope } from "@hyperion/contracts";
import { isHttpDurableEventIngressEnabled } from "@hyperion/durable-events";
import type { RouteRegistrar, ServiceContext } from "@hyperion/service-runtime";
import { readAuditEventTransportConfiguration, startAuditEventJetStreamConsumers } from "./audit-jetstream.js";
import { parseInternalAuditEventEnvelope, receiveInternalAuditEvent } from "./event-inbox.js";

export const registerRoutes: RouteRegistrar = async (app, context) => {
  const durableEvents = readAuditEventTransportConfiguration(process.env);
  if (context.db && durableEvents.transport === "jetstream") {
    const consumers = await startAuditEventJetStreamConsumers(
      (hook) => app.addHook("onClose", hook),
      context.db,
      durableEvents
    );
    for (const { sourceService, consumer } of consumers) {
      context.registerReadinessCheck?.({
        name: `jetstream_audit_${sourceService.replace(/[^a-z0-9]+/g, "_")}_consumer`,
        check: () => consumer.checkReadiness()
      });
    }
  }

  app.get("/v1/audit/events", async (request) => {
    if (!context.db) {
      return envelope([], request.id);
    }

    const result = await context.db.query(`
      select id, tenant_id, actor_id, event_type, entity_type, entity_id, metadata, created_at
      from platform.audit_events
      order by created_at desc
      limit 200
    `);

    return envelope(result.rows, request.id);
  });

  app.post("/v1/audit/events", async (request, reply) => {
    const authError = validateInternalToken(context, request.headers.authorization);
    if (authError) {
      return reply.code(authError.statusCode).send(envelope({ error: authError.message }, request.id));
    }

    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    const parsed = auditEventSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(envelope({ error: "Invalid audit payload", issues: parsed.error.issues }, request.id));
    }

    const event = parsed.data;
    const result = await context.db.query(
      `
      insert into platform.audit_events (
        tenant_id, actor_id, event_type, entity_type, entity_id, metadata
      )
      values ($1, $2, $3, $4, $5, $6::jsonb)
      returning id, tenant_id, actor_id, event_type, entity_type, entity_id, metadata, created_at
    `,
      [
        event.tenantId ?? null,
        event.actorId ?? null,
        event.eventType,
        event.entityType,
        event.entityId ?? null,
        JSON.stringify(event.metadata)
      ]
    );

    return reply.code(201).send(envelope(result.rows[0], request.id));
  });

  if (isHttpDurableEventIngressEnabled(durableEvents.transport)) {
    app.post("/internal/v1/events", async (request, reply) => {
      // This shared bearer token proves only that the caller is an internal
      // service; it cannot attest SOFIA versus LUMEN. The HTTP fallback therefore
      // validates and derives a declared source from the source-scoped event type.
      const authError = validateInternalToken(context, request.headers.authorization);
      if (authError) {
        return reply.code(authError.statusCode).send(envelope({ error: authError.message }, request.id));
      }

      if (!context.db) {
        return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
      }

      const parsed = parseInternalAuditEventEnvelope(request.body);
      if (!parsed.success) {
        return reply.code(400).send(envelope({ error: "Invalid event envelope", issues: parsed.issues }, request.id));
      }

      try {
        const result = await receiveInternalAuditEvent(context.db, parsed.data);

        if (result.status === "conflict") {
          return reply.code(409).send(
            envelope(
              {
                error: "Event id already exists with a different contract or payload",
                eventId: result.eventId
              },
              request.id
            )
          );
        }

        if (result.status === "duplicate") {
          return reply.code(200).send(envelope(result, request.id));
        }

        return reply.code(201).send(envelope(result, request.id));
      } catch {
        context.logger.error("internal audit event persistence failed", {
          requestId: request.id
        });
        return reply.code(500).send(envelope({ error: "Failed to persist audit event" }, request.id));
      }
    });
  }
};

function validateInternalToken(
  context: ServiceContext,
  authorization: string | undefined
): { statusCode: number; message: string } | undefined {
  if (!context.config.internalServiceToken) {
    return { statusCode: 503, message: "INTERNAL_SERVICE_TOKEN is required" };
  }

  const expected = `Bearer ${context.config.internalServiceToken}`;
  if (!authorization || !constantTimeEquals(authorization, expected)) {
    return { statusCode: 401, message: "Unauthorized" };
  }

  return undefined;
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);

  if (bufferA.length !== bufferB.length) {
    return false;
  }

  return timingSafeEqual(bufferA, bufferB);
}
