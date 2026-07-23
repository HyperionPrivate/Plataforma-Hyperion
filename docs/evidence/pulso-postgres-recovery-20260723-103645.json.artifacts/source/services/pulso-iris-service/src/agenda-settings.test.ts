import { describe, expect, it, vi } from "vitest";
import { ensureAgendaSettingsExist } from "./agenda-settings.js";

const TENANT_ID = "20000000-0000-4000-8000-000000000001";

describe("PULSO agenda settings lazy initialization", () => {
  it("uses only the PULSO-owned table and remains idempotent under retries", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 1 }));
    const db = { query } as never;

    await ensureAgendaSettingsExist(db, TENANT_ID);
    await ensureAgendaSettingsExist(db, TENANT_ID);

    expect(query).toHaveBeenCalledTimes(2);
    for (const [sql, params] of query.mock.calls) {
      expect(sql).toContain("insert into pulso_iris.agenda_settings");
      expect(sql).toContain("on conflict (tenant_id) do nothing");
      expect(sql).not.toContain("platform.");
      expect(params).toEqual([TENANT_ID]);
    }
  });
});
