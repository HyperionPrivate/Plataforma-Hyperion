import { describe, expect, it, vi } from "vitest";
import { normalizeLiwaPayload } from "./liwa-webhook-normalize.js";
import { persistNormalizedWebhook, resolveWebhookTenant } from "./routes.js";

const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_ID = "trusted-account-1656233";

describe("LIWA webhook tenant binding", () => {
  it("ignores a forged tenant_id and resolves only the configured account binding", async () => {
    const query = vi.fn(async () => ({ rows: [{ tenantId: TENANT_ID }], rowCount: 1 }));

    await expect(
      resolveWebhookTenant(
        { query } as never,
        { account_id: ACCOUNT_ID, tenant_id: "33333333-3333-4333-8333-333333333333" },
        ACCOUNT_ID
      )
    ).resolves.toBe(TENANT_ID);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("liwa.tenant_bindings"), [ACCOUNT_ID]);
  });

  it("fails closed for a missing configured account or a conflicting payload account", async () => {
    const query = vi.fn(async () => ({ rows: [{ tenantId: TENANT_ID }], rowCount: 1 }));

    await expect(resolveWebhookTenant({ query } as never, { account_id: ACCOUNT_ID }, undefined)).resolves.toBeNull();
    await expect(
      resolveWebhookTenant({ query } as never, { account_id: "attacker-account" }, ACCOUNT_ID)
    ).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});

describe("LIWA webhook persistence", () => {
  it("deduplicates before emitting effects and keeps the receipt inside one transaction", async () => {
    vi.stubEnv("LIWA_ACCOUNT_ID", ACCOUNT_ID);
    const txQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ tenantId: TENANT_ID }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const transaction = vi.fn(async (work) => work({ query: txQuery }));
    const parsed = normalizeLiwaPayload({
      account_id: ACCOUNT_ID,
      tenant_id: "33333333-3333-4333-8333-333333333333",
      event: "message",
      external_id: "provider-event-1",
      phone: "+573001112233",
      text: "hola"
    });

    await expect(
      persistNormalizedWebhook(
        { transaction } as never,
        { account_id: ACCOUNT_ID, tenant_id: "33333333-3333-4333-8333-333333333333" },
        parsed,
        "message",
        "http://nova-core-service:8091/internal/events",
        parsed.externalId,
        false
      )
    ).resolves.toEqual({ deduped: true, tenantId: TENANT_ID });

    expect(transaction).toHaveBeenCalledOnce();
    expect(txQuery).toHaveBeenCalledTimes(2);
    expect(String(txQuery.mock.calls[1]?.[0])).toMatch(
      /on conflict \(external_id\) do nothing[\s\S]*returning receipt_id/i
    );
    expect(txQuery.mock.calls.some(([sql]) => String(sql).includes("liwa.outbox_events"))).toBe(false);
    vi.unstubAllEnvs();
  });
});
