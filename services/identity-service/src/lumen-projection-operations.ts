import { createDatabase, type DatabaseClient } from "@hyperion/database";
import { assertAccessRuntimeDatabaseBoundary } from "@hyperion/access-migrations/runtime-boundary";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  backfillAccessLumenProjections,
  replayCurrentAccessLumenProjection,
  redriveAccessLumenProjectionDeadLetter,
  type AccessLumenDeadLetterSelection,
  type AccessLumenProjectionKind
} from "./lumen-projections.js";

export const LUMEN_PROJECTION_REDRIVE_CONFIRMATION = "REDRIVE ACCESS LUMEN PROJECTION";
export const LUMEN_PROJECTION_REPLAY_CONFIRMATION = "REPLAY ACCESS LUMEN PROJECTION";

export type LumenProjectionOperation =
  | { readonly command: "reconcile"; readonly limit: number }
  | ({ readonly command: "redrive" | "replay"; readonly confirmation: string } & AccessLumenDeadLetterSelection);

export interface LumenProjectionOperationDependencies {
  readonly createDatabase: (databaseUrl: string) => DatabaseClient;
  readonly assertRuntimeBoundary: (db: DatabaseClient) => Promise<void>;
}

const DEFAULT_DEPENDENCIES: LumenProjectionOperationDependencies = {
  createDatabase,
  assertRuntimeBoundary: (db) => assertAccessRuntimeDatabaseBoundary(db as never, "hyperion_identity")
};
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseLumenProjectionOperation(argv: readonly string[]): LumenProjectionOperation {
  const command = argv[0];
  if (command !== "reconcile" && command !== "redrive" && command !== "replay") {
    throw new Error(
      "Usage: lumen:projections -- reconcile --limit <1..1000> | redrive <exact selector> | replay <exact selector>"
    );
  }
  const flags = parseFlags(argv.slice(1));
  if (command === "reconcile") {
    assertOnlyFlags(flags, ["--limit"]);
    const rawLimit = flags.get("--limit") ?? "100";
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 1_000) {
      throw new Error("--limit must be an integer between 1 and 1000");
    }
    return { command, limit: Number(rawLimit) };
  }

  assertOnlyFlags(flags, ["--event-id", "--tenant-id", "--projection", "--confirm"]);
  const eventId = requiredFlag(flags, "--event-id");
  const tenantId = requiredFlag(flags, "--tenant-id");
  const projectionKind = requiredFlag(flags, "--projection") as AccessLumenProjectionKind;
  const confirmation = requiredFlag(flags, "--confirm");
  if (!UUID_PATTERN.test(eventId)) throw new Error("--event-id must be a UUID");
  if (!UUID_PATTERN.test(tenantId)) throw new Error("--tenant-id must be a UUID");
  if (projectionKind !== "tenant_snapshot" && projectionKind !== "operator_grant") {
    throw new Error("--projection must be tenant_snapshot or operator_grant");
  }
  const expectedConfirmation =
    command === "redrive" ? LUMEN_PROJECTION_REDRIVE_CONFIRMATION : LUMEN_PROJECTION_REPLAY_CONFIRMATION;
  if (confirmation !== expectedConfirmation) {
    throw new Error(`--confirm must equal ${expectedConfirmation}`);
  }
  return { command, eventId: eventId.toLowerCase(), tenantId: tenantId.toLowerCase(), projectionKind, confirmation };
}

export async function runLumenProjectionOperation(
  operation: LumenProjectionOperation,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: LumenProjectionOperationDependencies = DEFAULT_DEPENDENCIES
): Promise<Record<string, unknown>> {
  const databaseUrl = environment.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required and must authenticate as the Access Identity runtime");
  const db = dependencies.createDatabase(databaseUrl);
  try {
    await dependencies.assertRuntimeBoundary(db);
    if (operation.command === "reconcile") {
      const result = await backfillAccessLumenProjections(db, operation.limit);
      return { command: operation.command, ...result };
    }
    if (operation.command === "replay") {
      const replayed = await replayCurrentAccessLumenProjection(db, operation);
      if (!replayed) {
        throw new Error(
          "Exact current published LUMEN projection was not found or is inside the broker dedupe safety window"
        );
      }
      return { command: operation.command, status: "queued", ...replayed };
    }
    const redriven = await redriveAccessLumenProjectionDeadLetter(db, operation);
    if (!redriven) {
      throw new Error("Exact LUMEN projection dead letter was not found; no row was changed");
    }
    return { command: operation.command, status: "queued", ...redriven };
  } finally {
    await db.close();
  }
}

function parseFlags(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid argument near ${flag ?? "end of command"}`);
    }
    if (flags.has(flag)) throw new Error(`Duplicate argument ${flag}`);
    flags.set(flag, value);
  }
  return flags;
}

function assertOnlyFlags(flags: ReadonlyMap<string, string>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = [...flags.keys()].filter((flag) => !allowedSet.has(flag));
  if (unknown.length > 0) throw new Error(`Unknown argument ${unknown.sort().join(", ")}`);
}

function requiredFlag(flags: ReadonlyMap<string, string>, flag: string): string {
  const value = flags.get(flag)?.trim();
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

async function main(): Promise<void> {
  try {
    const result = await runLumenProjectionOperation(parseLumenProjectionOperation(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "LUMEN projection operation failed"}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
