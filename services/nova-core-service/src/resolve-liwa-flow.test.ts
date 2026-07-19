import { describe, expect, it, vi } from "vitest";
import { resolveLiwaFlowId, resolveProductFlowForContact } from "./resolve-liwa-flow.js";

function mockDb(rows: unknown[]) {
  return {
    query: vi.fn(async () => ({ rows, rowCount: rows.length }))
  };
}

describe("resolveLiwaFlowId", () => {
  it("prefers explicit flow id", async () => {
    const db = mockDb([{ liwa_flow_id: "from-config" }]);
    const id = await resolveLiwaFlowId(db as never, "t1", "flow-a", {
      explicitFlowId: "explicit-9",
      env: { LIWA_DEFAULT_FLOW_ID: "env-default" } as NodeJS.ProcessEnv
    });
    expect(id).toBe("explicit-9");
    expect(db.query).not.toHaveBeenCalled();
  });

  it("uses agent_configs before env", async () => {
    const db = mockDb([{ liwa_flow_id: "cfg-b" }]);
    const id = await resolveLiwaFlowId(db as never, "t1", "flow-b", {
      env: { LIWA_DEFAULT_FLOW_ID: "env-a" } as NodeJS.ProcessEnv
    });
    expect(id).toBe("cfg-b");
  });

  it("falls back to LIWA_DEFAULT_FLOW_ID", async () => {
    const db = mockDb([]);
    const id = await resolveLiwaFlowId(db as never, "t1", "flow-a", {
      env: { LIWA_DEFAULT_FLOW_ID: "flow-a" } as NodeJS.ProcessEnv
    });
    expect(id).toBe("flow-a");
  });
});

describe("resolveProductFlowForContact", () => {
  it("reads product_flow from latest campaign enrollment", async () => {
    const db = mockDb([{ product_flow: "flow-b" }]);
    await expect(resolveProductFlowForContact(db as never, "t1", "c1")).resolves.toBe("flow-b");
  });
});
