import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runPulsoMigrationsWithClient, type PulsoMigrationClient } from "./runner.js";

const hooks = vi.hoisted(() => ({
  timeline: [] as string[],
  inspectionError: new Error("stop after the initial schema inspection")
}));

vi.mock("./schema-manifest.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./schema-manifest.js")>();
  return {
    ...actual,
    assertPulsoMigratorDatabaseSecurity: vi.fn(async () => {
      hooks.timeline.push("migrator-security-preflight");
      return {};
    }),
    inspectPulsoSchema: vi.fn(async () => {
      hooks.timeline.push("schema-inspection");
      throw hooks.inspectionError;
    })
  };
});

const sqlDirectory = fileURLToPath(new URL("../sql/", import.meta.url));

describe("PULSO migration runner timeout wiring", () => {
  it("configures bounded session timeouts before role preflight and bounded advisory-lock acquisition", async () => {
    hooks.timeline.length = 0;
    const client = new TimelineClient();

    await expect(runPulsoMigrationsWithClient(client, sqlDirectory)).rejects.toBe(hooks.inspectionError);

    expect(hooks.timeline).toEqual([
      "session-timeouts:10s/300s/60s",
      "migrator-security-preflight",
      "advisory-budget:10s",
      "advisory-lock",
      "statement-budget:300s",
      "schema-inspection",
      "advisory-unlock"
    ]);
  });

  it("restores the 300-second budget and never inspects or unlocks when advisory-lock acquisition fails", async () => {
    hooks.timeline.length = 0;
    const lockError = new Error("canceling statement due to statement timeout");
    const client = new TimelineClient(lockError);

    await expect(runPulsoMigrationsWithClient(client, sqlDirectory)).rejects.toBe(lockError);

    expect(hooks.timeline).toEqual([
      "session-timeouts:10s/300s/60s",
      "migrator-security-preflight",
      "advisory-budget:10s",
      "advisory-lock",
      "statement-budget:300s"
    ]);
  });
});

class TimelineClient implements PulsoMigrationClient {
  constructor(private readonly lockError?: Error) {}

  async query<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (
      normalized.includes("set_config('lock_timeout', $1, false)") &&
      normalized.includes("set_config('statement_timeout', $2, false)") &&
      normalized.includes("set_config('idle_in_transaction_session_timeout', $3, false)")
    ) {
      hooks.timeline.push(`session-timeouts:${values.join("/")}`);
    } else if (normalized === "select set_config('statement_timeout', $1, false)") {
      hooks.timeline.push(values[0] === "10s" ? "advisory-budget:10s" : `statement-budget:${String(values[0])}`);
    } else if (normalized.includes("pg_advisory_unlock")) {
      hooks.timeline.push("advisory-unlock");
    } else if (normalized.includes("pg_advisory_lock")) {
      hooks.timeline.push("advisory-lock");
      if (this.lockError !== undefined) throw this.lockError;
    } else {
      throw new Error(`Unexpected runner query: ${normalized.slice(0, 120)}`);
    }

    return { rows: [] };
  }
}
