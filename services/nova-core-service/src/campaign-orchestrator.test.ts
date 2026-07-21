import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./voice-authorization.js", () => ({ authorizeVoiceCall: vi.fn() }));

import { authorizeVoiceCall } from "./voice-authorization.js";
import { dispatchCampaignBatch } from "./campaign-orchestrator.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN_ID = "22222222-2222-4222-8222-222222222222";
const CONTACT_ID = "33333333-3333-4333-8333-333333333333";

describe("dispatchCampaignBatch", () => {
  beforeEach(() => vi.mocked(authorizeVoiceCall).mockReset());

  it("does no work after a campaign has been paused", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const db = { query, transaction: (work: (tx: { query: typeof query }) => unknown) => work({ query }) } as never;

    await expect(
      dispatchCampaignBatch(db, TENANT_ID, CAMPAIGN_ID, { voice: "http://voice/events", audit: "http://audit/events" })
    ).resolves.toEqual({ campaignId: CAMPAIGN_ID, status: "not_running", queued: 0, blocked: 0 });
    expect(authorizeVoiceCall).not.toHaveBeenCalled();
  });

  it("authorizes a locked due enrollment through the shared gate", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from nova.campaigns")) {
        return { rows: [{ channel: "voice", productFlow: "renovacion" }], rowCount: 1 };
      }
      if (sql.includes("from nova.campaign_enrollments")) {
        return { rows: [{ contactId: CONTACT_ID }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const db = { query, transaction: (work: (tx: { query: typeof query }) => unknown) => work({ query }) } as never;
    vi.mocked(authorizeVoiceCall).mockResolvedValue({
      status: "authorized",
      callId: "44444444-4444-4444-8444-444444444444",
      correlationId: "55555555-5555-4555-8555-555555555555",
      snapshot: {} as never
    });

    const result = await dispatchCampaignBatch(
      db,
      TENANT_ID,
      CAMPAIGN_ID,
      { voice: "http://voice/events", audit: "http://audit/events" },
      10
    );

    expect(result).toMatchObject({ status: "running", queued: 1, blocked: 0 });
    expect(authorizeVoiceCall).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: TENANT_ID, campaignId: CAMPAIGN_ID, contactId: CONTACT_ID })
    );
    expect(query.mock.calls.some(([sql]) => String(sql).includes("skip locked"))).toBe(true);
  });
});
