import { randomUUID } from "node:crypto";
import {
  envelope,
  tenantIdSchema,
  documentReceivedPayloadSchema,
  documentValidatedPayloadSchema
} from "@hyperion/nova-contracts";
import { readServiceUrls } from "@hyperion/nova-config";
import type { DatabaseClient } from "@hyperion/database";
import type { ServiceContext } from "@hyperion/nova-service-runtime";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { createObjectStore, detectContentType, newDocumentId, type ObjectStore } from "./object-store.js";
import { insertDocumentsOutboxEvent } from "./outbox.js";

const MAX_DOCUMENT_BYTES = 20_971_520;

const documentsCatalog = {
  product: "NOVA",
  context: "documents",
  maxBytes: MAX_DOCUMENT_BYTES,
  allowedContentTypes: ["application/pdf", "image/png", "image/jpeg"] as const
};

const uploadSchema = z.object({
  content_base64: z.string().min(8),
  content_type: z.enum(["application/pdf", "image/png", "image/jpeg"]),
  contact_ref: z.string().max(160).optional()
});

export interface DocumentsRouteDependencies {
  objectStore: ObjectStore;
}

export async function registerDocumentsRoutes(
  app: FastifyInstance,
  context: ServiceContext,
  dependencies: DocumentsRouteDependencies
): Promise<void> {
  const serviceUrls = readServiceUrls();
  const novaDestination = `${serviceUrls.novaCore.replace(/\/$/, "")}/internal/events`;

  app.get("/v1/documents/catalog", async (request) => envelope(documentsCatalog, request.id));

  app.post("/v1/tenants/:tenantId/documents/upload", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;

    const parsed = uploadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(envelope({ error: "Invalid upload payload" }, request.id));
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.from(parsed.data.content_base64, "base64");
    } catch {
      return reply.code(400).send(envelope({ error: "content_base64 is invalid" }, request.id));
    }

    if (bytes.byteLength === 0 || bytes.byteLength > MAX_DOCUMENT_BYTES) {
      return reply.code(400).send(envelope({ error: "Document size must be between 1 byte and 20MB" }, request.id));
    }

    const detected = detectContentType(bytes);
    if (!detected || detected !== parsed.data.content_type) {
      return reply.code(400).send(envelope({ error: "Magic bytes do not match declared content_type" }, request.id));
    }

    const documentId = newDocumentId();
    const correlationId = randomUUID();
    const stored = await dependencies.objectStore.put({
      tenantId: scope.tenantId,
      documentId,
      contentType: parsed.data.content_type,
      bytes
    });

    await scope.db.transaction(async (tx) => {
      await tx.query(
        `insert into documents.objects (
           tenant_id, document_id, storage_key, content_type, byte_size, checksum_sha256, status, contact_ref
         ) values ($1, $2, $3, $4, $5, $6, 'received', $7)`,
        [
          scope.tenantId,
          documentId,
          stored.storageKey,
          parsed.data.content_type,
          stored.byteSize,
          stored.checksumSha256,
          parsed.data.contact_ref ?? null
        ]
      );

      const receivedPayload = documentReceivedPayloadSchema.parse({
        document_id: documentId,
        contact_ref: parsed.data.contact_ref,
        storage_key: stored.storageKey,
        content_type: parsed.data.content_type,
        byte_size: stored.byteSize
      });
      await insertDocumentsOutboxEvent(tx, {
        eventId: randomUUID(),
        eventType: "document.received",
        tenantId: scope.tenantId,
        correlationId,
        businessIdempotencyKey: `document-received:${documentId}`,
        dataClassification: "confidential",
        payload: receivedPayload,
        destination: novaDestination
      });

      const validatedPayload = documentValidatedPayloadSchema.parse({
        document_id: documentId,
        status: "validated"
      });
      await insertDocumentsOutboxEvent(tx, {
        eventId: randomUUID(),
        eventType: "document.validated",
        tenantId: scope.tenantId,
        correlationId,
        businessIdempotencyKey: `document-validated:${documentId}`,
        dataClassification: "confidential",
        payload: validatedPayload,
        destination: novaDestination
      });

      await tx.query(
        `update documents.objects set status = 'validated', updated_at = now() where tenant_id = $1 and document_id = $2`,
        [scope.tenantId, documentId]
      );
    });

    return reply.code(201).send(
      envelope(
        {
          document_id: documentId,
          storage_key: stored.storageKey,
          status: "validated",
          byte_size: stored.byteSize
        },
        request.id
      )
    );
  });

  app.get("/v1/tenants/:tenantId/documents/:id", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;

    const documentId = readUuid(request.params, "id");
    if (!documentId) return reply.code(400).send(envelope({ error: "id must be a UUID" }, request.id));

    const row = await scope.db.query<{
      storageKey: string;
      contentType: string;
      byteSize: number;
      status: string;
      contactRef: string | null;
    }>(
      `select storage_key as "storageKey", content_type as "contentType", byte_size as "byteSize",
              status, contact_ref as "contactRef"
       from documents.objects where tenant_id = $1 and document_id = $2`,
      [scope.tenantId, documentId]
    );
    if (row.rowCount === 0) {
      return reply.code(404).send(envelope({ error: "Document not found" }, request.id));
    }

    const meta = row.rows[0]!;
    return envelope(
      {
        document_id: documentId,
        storage_key: meta.storageKey,
        content_type: meta.contentType,
        byte_size: meta.byteSize,
        status: meta.status,
        contact_ref: meta.contactRef
      },
      request.id
    );
  });
}

function requireTenantDb(
  context: ServiceContext,
  request: FastifyRequest,
  reply: FastifyReply
): { tenantId: string; db: DatabaseClient } | undefined {
  const raw =
    typeof request.params === "object" && request.params && "tenantId" in request.params
      ? (request.params as { tenantId?: unknown }).tenantId
      : undefined;
  const parsed = tenantIdSchema.safeParse(raw);
  if (!parsed.success) {
    void reply.code(400).send(envelope({ error: "tenantId must be a UUID" }, request.id));
    return undefined;
  }
  if (!context.db) {
    void reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    return undefined;
  }
  return { tenantId: parsed.data, db: context.db };
}

function readUuid(params: unknown, key: string): string | undefined {
  const value =
    typeof params === "object" && params && key in params ? (params as Record<string, unknown>)[key] : undefined;
  const parsed = tenantIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function createDefaultDocumentsDependencies(env: NodeJS.ProcessEnv = process.env): DocumentsRouteDependencies {
  return { objectStore: createObjectStore(env) };
}
