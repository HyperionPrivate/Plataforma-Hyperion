import { envelope, tenantIdSchema } from "@hyperion/contracts";
import type { ServiceContext } from "@hyperion/service-runtime";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";

type Database = NonNullable<ServiceContext["db"]>;

export interface TenantReference {
  id: string | undefined;
  table: string;
  label: string;
}

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

export async function ensureTenantReferences(
  db: Database,
  tenantId: string,
  refs: TenantReference[]
): Promise<{ label: string } | undefined> {
  for (const ref of refs) {
    if (!ref.id) {
      continue;
    }

    const result = await db.query<{ exists: boolean }>(
      `select exists(select 1 from ${ref.table} where tenant_id = $1 and id = $2) as "exists"`,
      [tenantId, ref.id]
    );

    if (!result.rows[0]?.exists) {
      return { label: ref.label };
    }
  }

  return undefined;
}

export function sendReferenceError(reply: FastifyReply, request: FastifyRequest, label: string): undefined {
  void reply.code(422).send(envelope({ error: `${label} does not belong to this tenant` }, request.id));
  return undefined;
}

export function mapDatabaseError(error: unknown): { statusCode: number; message: string } | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = String((error as { code?: unknown }).code);
  if (code === "23503") {
    return { statusCode: 422, message: "Referenced entity does not belong to this tenant" };
  }
  if (code === "23505") {
    return { statusCode: 409, message: "Resource already exists or slot is already reserved" };
  }

  return undefined;
}
