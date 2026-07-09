import { envelope, tenantIdSchema } from "@hyperion/contracts";
import type { ServiceContext } from "@hyperion/service-runtime";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";

export function readTenantId(params: unknown): string | undefined {
  const raw =
    typeof params === "object" && params !== null && "tenantId" in params
      ? (params as { tenantId?: unknown }).tenantId
      : undefined;

  const parsed = tenantIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function readUuidParam(params: unknown, key: string): string | undefined {
  const raw =
    typeof params === "object" && params !== null && key in params
      ? (params as Record<string, unknown>)[key]
      : undefined;

  const parsed = tenantIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Valida tenant + base de datos y responde 400/503 si falta algo.
 * Devuelve undefined cuando ya se envio una respuesta de error.
 */
export function requireTenantDb(
  context: ServiceContext,
  request: FastifyRequest,
  reply: FastifyReply
): { tenantId: string; db: NonNullable<ServiceContext["db"]> } | undefined {
  const tenantId = readTenantId(request.params);
  if (!tenantId) {
    void reply.code(400).send(envelope({ error: "tenantId must be a UUID" }, request.id));
    return undefined;
  }

  if (!context.db) {
    void reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    return undefined;
  }

  return { tenantId, db: context.db };
}

export function parseBody<T extends z.ZodTypeAny>(
  schema: T,
  request: FastifyRequest,
  reply: FastifyReply
): z.infer<T> | undefined {
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    void reply.code(400).send(
      envelope(
        {
          error: "Invalid payload",
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
          }))
        },
        request.id
      )
    );
    return undefined;
  }

  return parsed.data;
}
