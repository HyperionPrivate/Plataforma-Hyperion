import type { DatabaseExecutor } from "@hyperion/database";
import { createHash } from "node:crypto";

export type LumenProcessingOperation = "transcription" | "structuring";
export type LumenProcessingStatus = "processing" | "completed" | "failed" | "cancelled";

interface ProcessingAttemptRow {
  id: string;
  status: LumenProcessingStatus;
  inputSha256: string;
  mimeType: string | null;
  source: string | null;
  durationSeconds: number | null;
  resultEntityId: string | null;
  resultSnapshot: unknown | null;
  resultSha256: string | null;
  resultVersion: Date | string | null;
}

export type ProcessingAttemptReservation =
  | { state: "reserved"; attemptId: string }
  | {
      state: "replay";
      attemptId: string;
      resultEntityId: string;
      resultSnapshot: unknown | null;
      resultSha256: string | null;
      resultVersion: Date | string | null;
    }
  | { state: "processing" | "failed" | "cancelled" | "input_mismatch"; attemptId: string };

export async function reserveProcessingAttempt(
  db: DatabaseExecutor,
  input: {
    tenantId: string;
    encounterId: string;
    operation: LumenProcessingOperation;
    idempotencyKey: string;
    inputSha256: string;
    provider: string;
    model: string;
    mimeType?: string;
    source?: string;
    durationSeconds?: number;
  }
): Promise<ProcessingAttemptReservation> {
  const inserted = await db.query<{ id: string }>(
    `insert into lumen.processing_attempts
       (tenant_id, encounter_id, operation, idempotency_key, input_sha256,
        provider, model, mime_type, source, duration_seconds)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (tenant_id, encounter_id, operation, idempotency_key) do nothing
     returning id`,
    [
      input.tenantId,
      input.encounterId,
      input.operation,
      input.idempotencyKey,
      input.inputSha256,
      input.provider,
      input.model,
      input.mimeType ?? null,
      input.source ?? null,
      input.durationSeconds ?? null
    ]
  );
  if (inserted.rowCount === 1) return { state: "reserved", attemptId: inserted.rows[0]!.id };

  const existing = await db.query<ProcessingAttemptRow>(
    `select id, status, input_sha256 as "inputSha256", mime_type as "mimeType",
            source, duration_seconds as "durationSeconds", result_entity_id as "resultEntityId",
            result_snapshot as "resultSnapshot", result_sha256 as "resultSha256",
            result_version as "resultVersion"
     from lumen.processing_attempts
     where tenant_id = $1 and encounter_id = $2 and operation = $3 and idempotency_key = $4`,
    [input.tenantId, input.encounterId, input.operation, input.idempotencyKey]
  );
  const row = existing.rows[0];
  if (!row) throw new Error("Idempotency reservation disappeared");

  const metadataMatches =
    row.inputSha256 === input.inputSha256 &&
    row.mimeType === (input.mimeType ?? null) &&
    row.source === (input.source ?? null) &&
    row.durationSeconds === (input.durationSeconds ?? null);
  if (!metadataMatches) return { state: "input_mismatch", attemptId: row.id };
  if (row.status === "completed") {
    if (!row.resultEntityId) throw new Error("Completed processing attempt has no result");
    return {
      state: "replay",
      attemptId: row.id,
      resultEntityId: row.resultEntityId,
      resultSnapshot: row.resultSnapshot,
      resultSha256: row.resultSha256,
      resultVersion: row.resultVersion
    };
  }
  return { state: row.status, attemptId: row.id };
}

export async function completeProcessingAttempt(
  db: DatabaseExecutor,
  input: {
    attemptId: string;
    tenantId: string;
    encounterId: string;
    operation: LumenProcessingOperation;
    resultEntityId: string;
    provider: string;
    model: string;
    requestIdHash?: string | null;
    traceIdHash?: string | null;
    temporaryAudioDeleted?: boolean;
    resultSnapshot?: unknown;
    resultSha256?: string;
    resultVersion?: string;
  }
): Promise<void> {
  const result = await db.query(
    `update lumen.processing_attempts
     set status = 'completed', result_entity_id = $2, provider = $3, model = $4,
          request_id_hash = $5, trace_id_hash = $6,
          temp_audio_deleted_at = case when $7::boolean then now() else temp_audio_deleted_at end,
          result_snapshot = $8::jsonb, result_sha256 = $9, result_version = $10::timestamptz,
          completed_at = now(), updated_at = now()
     where id = $1 and tenant_id = $11 and encounter_id = $12 and operation = $13
       and status = 'processing'`,
    [
      input.attemptId,
      input.resultEntityId,
      input.provider,
      input.model,
      input.requestIdHash ?? null,
      input.traceIdHash ?? null,
      input.temporaryAudioDeleted === true,
      input.resultSnapshot === undefined ? null : JSON.stringify(input.resultSnapshot),
      input.resultSha256 ?? null,
      input.resultVersion ?? null,
      input.tenantId,
      input.encounterId,
      input.operation
    ]
  );
  if (result.rowCount !== 1) throw new Error("Processing attempt is no longer mutable");
}

export function processingResultSnapshotSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Processing result snapshot contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  throw new TypeError("Processing result snapshot is not JSON serializable");
}

export async function failProcessingAttempt(
  db: DatabaseExecutor,
  input: {
    attemptId: string;
    errorCode: string;
    cancelled: boolean;
    temporaryAudioDeleted?: boolean;
  }
): Promise<void> {
  const errorCode = sanitizeProcessingErrorCode(input.errorCode);
  await db.query(
    `update lumen.processing_attempts
     set status = case when $2::boolean then 'cancelled' else 'failed' end,
         error_code = case when $2::boolean then null else $3 end,
         cancelled_at = case when $2::boolean then now() else null end,
         failed_at = case when $2::boolean then null else now() end,
         temp_audio_deleted_at = case when $4::boolean then now() else temp_audio_deleted_at end,
         updated_at = now()
     where id = $1 and status = 'processing'`,
    [input.attemptId, input.cancelled, errorCode, input.temporaryAudioDeleted === true]
  );
}

function sanitizeProcessingErrorCode(value: string): string {
  const sanitized = value
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return sanitized || "processing_error";
}
