import { auditEventSchema, envelope } from "@hyperion/contracts";
import { isHttpDurableEventIngressEnabled } from "@hyperion/durable-events";
import {
  readInternalCaller,
  readInternalCredential,
  validateInternalAuthorization,
  type InternalCredentialMap,
  type RouteRegistrar
} from "@hyperion/service-runtime";
import { readAuditEventTransportConfiguration, startAuditEventJetStreamConsumers } from "./audit-jetstream.js";
import { parseInternalAuditEventEnvelope, receiveInternalAuditEvent } from "./event-inbox.js";

export const registerRoutes: RouteRegistrar = async (app, context) => {
  const durableEvents = readAuditEventTransportConfiguration(process.env);
  const directWriteCredentials = readDirectWriteCredentials(process.env);
  const durableEventCredentials = readDurableEventCredentials(process.env);
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
    const authError = validateInternalAuthorization(request.headers, directWriteCredentials);
    if (authError) {
      return reply.code(authError.statusCode).send(envelope({ error: authError.message }, request.id));
    }
    const caller = readInternalCaller(request.headers)!;

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
        JSON.stringify({ ...event.metadata, sourceService: caller })
      ]
    );

    return reply.code(201).send(envelope(result.rows[0], request.id));
  });

  if (isHttpDurableEventIngressEnabled(durableEvents.transport)) {
    app.post("/internal/v1/events", async (request, reply) => {
      const authError = validateInternalAuthorization(request.headers, durableEventCredentials);
      if (authError) {
        return reply.code(authError.statusCode).send(envelope({ error: authError.message }, request.id));
      }
      const caller = readInternalCaller(request.headers)!;
      const expectedSource = expectedAuditSourceForCaller(caller);
      if (!expectedSource) {
        return reply.code(403).send(envelope({ error: "Caller is not an authorized audit producer" }, request.id));
      }

      if (!context.db) {
        return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
      }

      const parsed = parseInternalAuditEventEnvelope(request.body, expectedSource);
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

function readDirectWriteCredentials(env: NodeJS.ProcessEnv): InternalCredentialMap {
  return {
    "agent-service": readInternalCredential(env, "SOFIA_TO_AUDIT_TOKEN")
  };
}

function readDurableEventCredentials(env: NodeJS.ProcessEnv): InternalCredentialMap {
  return {
    "agent-service": readInternalCredential(env, "SOFIA_TO_AUDIT_TOKEN"),
    "lumen-service": readInternalCredential(env, "LUMEN_TO_AUDIT_TOKEN"),
    "pulso-iris-service": readInternalCredential(env, "PULSO_TO_AUDIT_TOKEN"),
    "whatsapp-channel-service": readInternalCredential(env, "CHANNEL_TO_AUDIT_TOKEN")
  };
}

function expectedAuditSourceForCaller(
  caller: string
): "sofia-automation" | "lumen-service" | "pulso-iris-service" | "whatsapp-channel-service" | undefined {
  switch (caller) {
    case "agent-service":
      return "sofia-automation";
    case "lumen-service":
      return "lumen-service";
    case "pulso-iris-service":
      return "pulso-iris-service";
    case "whatsapp-channel-service":
      return "whatsapp-channel-service";
    default:
      return undefined;
  }
}
