import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  acquireLumenMigrationLock,
  assertLumenProviderSqlPreservesTimeouts,
  configureLumenMigrationSessionTimeouts,
  configureLumenMigrationTimeouts,
  LUMEN_MIGRATION_TIMEOUTS,
  type LumenSqlPolicyClient
} from "./sql-policy.js";

describe("LUMEN provider-owned SQL timeout policy", () => {
  it("accepts every checked-in provider-owned migration", async () => {
    const sqlDirectory = fileURLToPath(new URL("../sql/", import.meta.url));
    const files = (await readdir(sqlDirectory)).filter((file) => file.endsWith(".sql")).sort();

    for (const file of files) {
      const sql = await readFile(new URL(`../sql/${file}`, import.meta.url), "utf8");
      expect(() => assertLumenProviderSqlPreservesTimeouts(file, sql)).not.toThrow();
    }
  });

  it.each([
    "SET statement_timeout = 0;",
    "SET/* token trivia */statement_timeout = 0;",
    "set local lock_timeout to '0';",
    'SET SESSION "idle_in_transaction_session_timeout" = DEFAULT;',
    "RESET statement_timeout;",
    "RESET ALL;",
    "select pg_catalog.set_config('lock_timeout', '0', true);",
    "alter role hyperion_lumen_migrator set statement_timeout = 0;",
    "DISCARD ALL;"
  ])("rejects a provider migration that can override the runner budget: %s", (sql) => {
    expect(() => assertLumenProviderSqlPreservesTimeouts("999-unsafe.sql", sql)).toThrow(
      "999-unsafe.sql must not SET, RESET, or disable runner-managed database timeouts"
    );
  });

  it("sets bounded transaction-local lock, statement, and idle limits", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const client: LumenSqlPolicyClient = { query };

    await configureLumenMigrationTimeouts(client);

    expect(LUMEN_MIGRATION_TIMEOUTS).toEqual({
      lockTimeout: "10s",
      statementTimeout: "300s",
      idleInTransactionSessionTimeout: "60s"
    });
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(
        /set_config\('lock_timeout', \$1, true\)[\s\S]*set_config\('statement_timeout', \$2, true\)[\s\S]*set_config\('idle_in_transaction_session_timeout', \$3, true\)/
      ),
      ["10s", "300s", "60s"]
    );
  });

  it("sets the same bounded limits at session scope before catalog preflight", async () => {
    const query = vi.fn(async () => ({ rows: [] }));

    await configureLumenMigrationSessionTimeouts({ query });

    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(
        /set_config\('lock_timeout', \$1, false\)[\s\S]*set_config\('statement_timeout', \$2, false\)[\s\S]*set_config\('idle_in_transaction_session_timeout', \$3, false\)/
      ),
      ["10s", "300s", "60s"]
    );
  });

  it("bounds advisory-lock acquisition to 10 seconds and restores the 300-second statement budget", async () => {
    const query = vi.fn(async () => ({ rows: [] }));

    await acquireLumenMigrationLock({ query }, "lumen:test-lock");

    expect(query.mock.calls).toEqual([
      ["select set_config('statement_timeout', $1, false)", ["10s"]],
      ["select pg_advisory_lock(hashtext($1))", ["lumen:test-lock"]],
      ["select set_config('statement_timeout', $1, false)", ["300s"]]
    ]);
  });

  it("restores the 300-second statement budget when advisory-lock acquisition fails", async () => {
    const acquisitionError = new Error("canceling statement due to statement timeout");
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(acquisitionError)
      .mockResolvedValueOnce({ rows: [] });

    await expect(acquireLumenMigrationLock({ query }, "lumen:test-lock")).rejects.toBe(acquisitionError);
    expect(query).toHaveBeenLastCalledWith("select set_config('statement_timeout', $1, false)", ["300s"]);
  });
});
