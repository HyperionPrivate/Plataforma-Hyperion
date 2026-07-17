import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "@hyperion/database";
import type { DialerAdapter } from "./dialer-adapter.js";
import {
  fetchElevenLabsConversation,
  isTerminalElevenLabsStatus,
  pollElevenLabsStuckCalls,
  startOutcomePoller,
  type OutcomePollerOptions
} from "./outcome-poller.js";

function mockDb(stuckRows: Array<Record<string, unknown>> = []): DatabaseClient {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes("status = 'dispatched'")) {
        return { rows: stuckRows, rowCount: stuckRows.length };
      }
      if (sql.trimStart().toLowerCase().startsWith("update")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    transaction: vi.fn(async (fn: (tx: DatabaseClient) => Promise<unknown>) =>
      fn(db as unknown as DatabaseClient)
    ),
    close: vi.fn(async () => undefined)
  };
  return db as unknown as DatabaseClient;
}

function mockDialer(): DialerAdapter {
  return {
    createCampaign: vi.fn(),
    loadContacts: vi.fn(),
    start: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
    placeCall: vi.fn(),
    getCampaign: vi.fn(),
    listCalls: vi.fn(async () => []),
    listReconciliation: vi.fn(async () => []),
    reconcileCall: vi.fn()
  } as unknown as DialerAdapter;
}

describe("isTerminalElevenLabsStatus", () => {
  it("treats done/failed/completed as terminal", () => {
    expect(isTerminalElevenLabsStatus("done")).toBe(true);
    expect(isTerminalElevenLabsStatus("failed")).toBe(true);
    expect(isTerminalElevenLabsStatus("completed")).toBe(true);
    expect(isTerminalElevenLabsStatus("in-progress")).toBe(false);
    expect(isTerminalElevenLabsStatus("processing")).toBe(false);
  });
});

describe("fetchElevenLabsConversation", () => {
  it("returns status, intent and transcript", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: "done",
          analysis: {
            call_successful: "success",
            data_collection_results: { intencion: { value: "pedir_whatsapp" } }
          },
          transcript: [{ message: "Sí mándeme por WhatsApp" }]
        }),
        { status: 200 }
      )
    ) as unknown as typeof fetch;

    const snap = await fetchElevenLabsConversation(fetchImpl, "key", "conv_1");
    expect(snap.status).toBe("done");
    expect(snap.intent).toBe("pedir_whatsapp");
    expect(snap.transcriptExcerpt).toContain("WhatsApp");
  });
});

describe("pollElevenLabsStuckCalls", () => {
  const stuckCall = {
    tenantId: "787bc386-6d37-4c08-b929-5c8b9dc5ef40",
    callId: "11111111-1111-4111-8111-111111111111",
    contactId: "22222222-2222-4222-8222-222222222222",
    campaignId: null,
    enrollmentId: null,
    status: "dispatched",
    providerConversationId: "conv_stuck_1",
    createdAt: new Date()
  };

  it("emits completed when ElevenLabs status is done", async () => {
    const db = mockDb([stuckCall]);
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: "done",
          analysis: { data_collection_results: { intencion: "interesado" } },
          transcript: [{ message: "Quiero renovar" }]
        }),
        { status: 200 }
      )
    ) as unknown as typeof fetch;

    const options: OutcomePollerOptions = {
      db,
      dialer: mockDialer(),
      novaDestination: "http://nova/internal/events",
      elevenLabsApiKey: "el-key",
      fetchImpl
    };

    const emitted = await pollElevenLabsStuckCalls(options, fetchImpl, 6 * 60 * 60 * 1000);
    expect(emitted).toBe(1);
    expect(db.transaction).toHaveBeenCalled();
  });

  it("does not emit when conversation is still in-progress", async () => {
    const db = mockDb([stuckCall]);
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ status: "in-progress", transcript: [] }), { status: 200 })
    ) as unknown as typeof fetch;

    const options: OutcomePollerOptions = {
      db,
      dialer: mockDialer(),
      novaDestination: "http://nova/internal/events",
      elevenLabsApiKey: "el-key",
      fetchImpl
    };

    const emitted = await pollElevenLabsStuckCalls(options, fetchImpl, 6 * 60 * 60 * 1000);
    expect(emitted).toBe(0);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("marks failed with poll_timeout after timeout window", async () => {
    const oldCall = {
      ...stuckCall,
      createdAt: new Date(Date.now() - 7 * 60 * 60 * 1000)
    };
    const db = mockDb([oldCall]);
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const options: OutcomePollerOptions = {
      db,
      dialer: mockDialer(),
      novaDestination: "http://nova/internal/events",
      elevenLabsApiKey: "el-key",
      fetchImpl
    };

    const emitted = await pollElevenLabsStuckCalls(options, fetchImpl, 6 * 60 * 60 * 1000);
    expect(emitted).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(db.transaction).toHaveBeenCalled();
  });
});

describe("startOutcomePoller", () => {
  it("exposes tick that returns 0 when nothing to complete", async () => {
    const options: OutcomePollerOptions = {
      db: mockDb([]),
      dialer: mockDialer(),
      novaDestination: "http://nova/internal/events",
      elevenLabsApiKey: "el-key",
      intervalMs: 60_000,
      fetchImpl: vi.fn() as unknown as typeof fetch
    };
    const poller = startOutcomePoller(options);
    try {
      await expect(poller.tick()).resolves.toBe(0);
      await expect(poller.checkReadiness()).resolves.toEqual({
        status: "ok",
        detail: "outcome poller running"
      });
    } finally {
      await poller.stop();
    }
  });
});
