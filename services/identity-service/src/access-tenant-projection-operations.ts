import { assertAccessRuntimeDatabaseBoundary } from "@hyperion/access-migrations/runtime-boundary";
import { createDatabase, type DatabaseClient } from "@hyperion/database";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  reconcileAccessTenantSnapshots,
  replayCurrentAccessTenantProjection,
  redriveAccessTenantProjectionDeadLetter,
  type AccessTenantDeadLetterSelection
} from "./access-tenant-projections.js";

export const ACCESS_TENANT_PROJECTION_REDRIVE_CONFIRMATION = "REDRIVE ACCESS TENANT SNAPSHOT";
export const ACCESS_TENANT_PROJECTION_REPLAY_CONFIRMATION = "REPLAY ACCESS TENANT SNAPSHOT";

export type AccessTenantProjectionOperation =
  | { readonly command: "reconcile"; readonly limit: number }
  | ({ readonly command: "redrive"; readonly confirmation: string } & AccessTenantDeadLetterSelection)
  | { readonly command: "replay"; readonly tenantId: string; readonly confirmation: string };

export interface AccessTenantProjectionOperationDependencies {
  readonly createDatabase: (databaseUrl: string) => DatabaseClient;
  readonly assertRuntimeBoundary: (db: DatabaseClient) => Promise<void>;
}

const DEFAULT_DEPENDENCIES: AccessTenantProjectionOperationDependencies = {
  createDatabase,
  assertRuntimeBoundary: (db) => assertAccessRuntimeDatabaseBoundary(db as never, "hyperion_identity")
};
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseAccessTenantProjectionOperation(argv: readonly string[]): AccessTenantProjectionOperation {
  const command = argv[0];
  if (command !== "reconcile" && command !== "redrive" && command !== "replay") {
    throw new Error(
      "Usage: tenant:projections -- reconcile --limit <1..1000> | redrive <exact selector> | replay <exact tenant>"
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

  assertOnlyFlags(
    flags,
    command === "redrive" ? ["--event-id", "--tenant-id", "--confirm"] : ["--tenant-id", "--confirm"]
  );
  const tenantId = requiredFlag(flags, "--tenant-id");
  const confirmation = requiredFlag(flags, "--confirm");
  if (!UUID_PATTERN.test(tenantId)) throw new Error("--tenant-id must be a UUID");
  if (command === "replay") {
    if (confirmation !== ACCESS_TENANT_PROJECTION_REPLAY_CONFIRMATION) {
      throw new Error(`--confirm must equal ${ACCESS_TENANT_PROJECTION_REPLAY_CONFIRMATION}`);
    }
    return { command, tenantId: tenantId.toLowerCase(), confirmation };
  }
  const eventId = requiredFlag(flags, "--event-id");
  if (!UUID_PATTERN.test(eventId)) throw new Error("--event-id must be a UUID");
  if (confirmation !== ACCESS_TENANT_PROJECTION_REDRIVE_CONFIRMATION) {
    throw new Error(`--confirm must equal ${ACCESS_TENANT_PROJECTION_REDRIVE_CONFIRMATION}`);
  }
  return {
    command,
    eventId: eventId.toLowerCase(),
    tenantId: tenantId.toLowerCase(),
    confirmation
  };
}

export async function runAccessTenantProjectionOperation(
  operation: AccessTenantProjectionOperation,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: AccessTenantProjectionOperationDependencies = DEFAULT_DEPENDENCIES
): Promise<Record<string, unknown>> {
  const databaseUrl = environment.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required and must authenticate as the Access Identity runtime");
  const db = dependencies.createDatabase(databaseUrl);
  try {
    await dependencies.assertRuntimeBoundary(db);
    if (operation.command === "reconcile") {
      return { command: operation.command, ...(await reconcileAccessTenantSnapshots(db, operation.limit)) };
    }
    if (operation.command === "replay") {
      const replayed = await replayCurrentAccessTenantProjection(db, operation);
      if (!replayed) {
        throw new Error(
          "Current published Access tenant snapshot was not found or is inside the broker dedupe safety window"
        );
      }
      return { command: operation.command, status: "queued", ...replayed };
    }
    const redriven = await redriveAccessTenantProjectionDeadLetter(db, operation);
    if (!redriven) throw new Error("Exact Access tenant projection dead letter was not found; no row was changed");
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
    const result = await runAccessTenantProjectionOperation(
      parseAccessTenantProjectionOperation(process.argv.slice(2))
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Access tenant projection operation failed"}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
