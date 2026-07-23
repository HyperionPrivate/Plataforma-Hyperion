import type { LumenClinicalRecordContent } from "@hyperion/lumen-contracts";
import type { DatabaseClient, DatabaseTransaction } from "@hyperion/database";
import type { ServiceContext } from "@hyperion/service-runtime";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { ClinicalStructurer } from "./clinical-ai.js";
import { registerLumenRoutes } from "./routes.js";
import type { SpeechToTextProvider } from "./speech-to-text.js";

const TENANT_ID = "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c";
const OPERATOR_ID = "11111111-1111-4111-8111-111111111111";
const ENCOUNTER_ID = "22222222-2222-4222-8222-222222222222";
const ATTEMPT_ID = "33333333-3333-4333-8333-333333333333";
const IDEMPOTENCY_KEY = "44444444-4444-4444-8444-444444444444";
const RACE_TRANSCRIPT =
  "Control de presión intraocular. Paciente refiere visión estable. Agudeza visual OD 20/20 y OI 20/40. " +
  "PIO 14 mmHg OD y 16 mmHg OI. Impresión: glaucoma en estudio. Control en cuatro semanas.";

const RACE_CONTENT: LumenClinicalRecordContent = {
  reasonForVisit: "Control de presión intraocular",
  history: "Paciente refiere visión estable.",
  visualAcuity: { right: "20/20", left: "20/40" },
  intraocularPressure: { right: "14 mmHg", left: "16 mmHg" },
  biomicroscopy: { right: null, left: null },
  fundus: { right: null, left: null },
  gonioscopy: { right: null, left: null },
  assessment: [{ description: "Glaucoma en estudio", code: null, confidence: 0.9 }],
  plan: ["Control en cuatro semanas"],
  uncertainties: [],
  fieldEvidence: [
    { field: "reasonForVisit", confidence: 0.98, origin: "voice", sourceText: "Control de presión intraocular" },
    { field: "history", confidence: 0.96, origin: "voice", sourceText: "Paciente refiere visión estable" },
    { field: "visualAcuity.right", confidence: 0.98, origin: "voice", sourceText: "OD 20/20" },
    { field: "visualAcuity.left", confidence: 0.98, origin: "voice", sourceText: "OI 20/40" },
    { field: "intraocularPressure.right", confidence: 0.98, origin: "voice", sourceText: "PIO 14 mmHg OD" },
    { field: "intraocularPressure.left", confidence: 0.98, origin: "voice", sourceText: "16 mmHg OI" },
    { field: "assessment", confidence: 0.9, origin: "voice", sourceText: "Impresión: glaucoma en estudio" },
    { field: "plan", confidence: 0.93, origin: "voice", sourceText: "Control en cuatro semanas" }
  ]
};

type MutationKind = "start" | "transcription" | "structure" | "patch" | "approve";

interface RecordedQuery {
  sql: string;
  params: unknown[] | undefined;
}

interface GrantState {
  isActive: boolean;
  canReview: boolean;
}

describe("LUMEN clinical write authorization", () => {
  it.each([
    ["a missing local grant", undefined],
    ["an inactive local grant", { isActive: false, canReview: false }],
    ["an active grant without review capability", { isActive: true, canReview: false }]
  ] as const)("blocks every clinical mutation for %s before any side effect", async (_label, grant) => {
    const harness = await createHarness(grant);
    try {
      const requests = [
        harness.app.inject({
          method: "POST",
          url: `/v1/tenants/${TENANT_ID}/lumen/encounters/not-a-uuid/start`,
          headers: operatorHeaders("admin")
        }),
        harness.app.inject({
          method: "POST",
          url: `/v1/tenants/${TENANT_ID}/lumen/encounters/not-a-uuid/transcriptions`,
          headers: operatorHeaders("coordinator"),
          payload: {}
        }),
        harness.app.inject({
          method: "POST",
          url: `/v1/tenants/${TENANT_ID}/lumen/encounters/not-a-uuid/structure`,
          headers: operatorHeaders("advisor"),
          payload: {}
        }),
        harness.app.inject({
          method: "PATCH",
          url: `/v1/tenants/${TENANT_ID}/lumen/encounters/not-a-uuid/record`,
          headers: operatorHeaders("admin"),
          payload: {}
        }),
        harness.app.inject({
          method: "POST",
          url: `/v1/tenants/${TENANT_ID}/lumen/encounters/not-a-uuid/approve`,
          headers: operatorHeaders("coordinator")
        })
      ];

      const responses = await Promise.all(requests);
      expect(responses.map((response) => response.statusCode)).toEqual([403, 403, 403, 403, 403]);
      for (const response of responses) {
        expect(response.json().data).toEqual({ error: "Active LUMEN review grant required" });
      }

      expect(harness.query).toHaveBeenCalledTimes(5);
      for (const [sql, params] of harness.query.mock.calls) {
        expect(sql).toContain("from lumen.operator_grants");
        expect(sql).toContain("is_active and can_review");
        expect(params).toEqual([TENANT_ID, OPERATOR_ID]);
      }
      expect(harness.transaction).not.toHaveBeenCalled();
      expect(harness.transcriberConfigured).not.toHaveBeenCalled();
      expect(harness.transcribe).not.toHaveBeenCalled();
      expect(harness.structurerConfigured).not.toHaveBeenCalled();
      expect(harness.structure).not.toHaveBeenCalled();
    } finally {
      await harness.app.close();
    }
  });

  it("uses the local capability instead of the generic role header", async () => {
    const harness = await createHarness({ isActive: true, canReview: true });
    try {
      const response = await harness.app.inject({
        method: "POST",
        url: `/v1/tenants/${TENANT_ID}/lumen/encounters/not-a-uuid/start`,
        headers: operatorHeaders("auditor")
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().data).toEqual({ error: "encounterId must be a UUID" });
      expect(harness.query).toHaveBeenCalledTimes(1);
      expect(harness.transaction).not.toHaveBeenCalled();
    } finally {
      await harness.app.close();
    }
  });

  it.each(["start", "transcription", "structure", "patch", "approve"] as const)(
    "revalidates and locks the grant before the first transactional write for %s",
    async (kind) => {
      const harness = await createRaceHarness(2);
      try {
        const response = await injectMutation(harness.app, kind);

        expect(response.statusCode).toBe(403);
        expect(response.json().data).toEqual({ error: "Active LUMEN review grant required" });
        expect(harness.grantChecks()).toBe(2);
        expect(harness.transactionQueries).toHaveLength(1);
        expect(harness.transactionQueries[0]).toHaveLength(1);
        expectGrantHold(harness.transactionQueries[0]);
        expect(harness.mutations).toEqual([]);
        expect(harness.transcribe).not.toHaveBeenCalled();
        expect(harness.structure).not.toHaveBeenCalled();
      } finally {
        await harness.app.close();
      }
    }
  );

  it.each(["transcription", "structure"] as const)(
    "keeps %s provider I/O outside transactions and suppresses clinical persistence after revocation",
    async (kind) => {
      const harness = await createRaceHarness(3);
      try {
        const response = await injectMutation(harness.app, kind);

        expect(response.statusCode).toBe(403);
        expect(response.json().data).toEqual({ error: "Active LUMEN review grant required" });
        expect(harness.grantChecks()).toBe(3);
        expect(harness.providerRanInTransaction()).toBe(false);
        expect(kind === "transcription" ? harness.transcribe : harness.structure).toHaveBeenCalledOnce();
        expect(kind === "transcription" ? harness.structure : harness.transcribe).not.toHaveBeenCalled();

        expect(harness.transactionQueries).toHaveLength(3);
        expectGrantHold(harness.transactionQueries[0]);
        expectGrantHold(harness.transactionQueries[1]);

        const [reservation, technicalClosure] = harness.mutations;
        expect(reservation?.sql).toContain("insert into lumen.processing_attempts");
        expect(technicalClosure?.sql).toContain("update lumen.processing_attempts");
        expect(technicalClosure?.params).toEqual([
          ATTEMPT_ID,
          false,
          "operator_grant_revoked",
          kind === "transcription"
        ]);
        expect(harness.transactionQueries[2]).toEqual([technicalClosure]);

        // Revocation compensation is system-owned and terminalizes only the
        // technical reservation; it must never persist clinical/provider data
        // or emit an actor-attributed audit event.
        const mutationSql = harness.mutations.map(({ sql }) => sql).join("\n");
        expect(mutationSql).not.toMatch(/lumen\.(dictations|clinical_records|outbox_events)/i);
        expect(mutationSql).not.toMatch(/update\s+lumen\.encounters/i);
        expect(JSON.stringify(harness.mutations.map(({ params }) => params))).not.toContain(RACE_TRANSCRIPT);
        expect(JSON.stringify(harness.mutations.map(({ params }) => params))).not.toContain(
          JSON.stringify(RACE_CONTENT)
        );
      } finally {
        await harness.app.close();
      }
    }
  );
});

describe("LUMEN clinical read authorization", () => {
  it.each([
    ["a missing local grant", undefined],
    ["an inactive local grant", { isActive: false, canReview: false }],
    ["an active grant without review capability", { isActive: true, canReview: false }]
  ] as const)("blocks GET worklist and GET encounter for %s before any PHI query", async (_label, grant) => {
    const harness = await createHarness(grant);
    try {
      const headers = operatorHeaders("advisor");
      const worklist = await harness.app.inject({
        method: "GET",
        url: `/v1/tenants/${TENANT_ID}/lumen/worklist`,
        headers
      });
      const encounter = await harness.app.inject({
        method: "GET",
        url: `/v1/tenants/${TENANT_ID}/lumen/encounters/${ENCOUNTER_ID}`,
        headers
      });

      expect(worklist.statusCode).toBe(403);
      expect(encounter.statusCode).toBe(403);
      expect(worklist.json().data).toEqual({ error: "Active LUMEN review grant required" });
      expect(encounter.json().data).toEqual({ error: "Active LUMEN review grant required" });
      expect(harness.query).toHaveBeenCalledTimes(2);
      for (const [sql, params] of harness.query.mock.calls) {
        expect(sql).toContain("from lumen.operator_grants");
        expect(sql).toContain("is_active and can_review");
        expect(params).toEqual([TENANT_ID, OPERATOR_ID]);
      }
      expect(harness.query.mock.calls.some(([sql]) => String(sql).includes("from lumen.encounters e"))).toBe(false);
      expect(harness.transaction).not.toHaveBeenCalled();
    } finally {
      await harness.app.close();
    }
  });
});

async function createHarness(grant: GrantState | undefined) {
  const query = vi.fn(async (_sql: string, params?: unknown[]) => {
    const authorized =
      grant?.isActive === true && grant.canReview === true && params?.[0] === TENANT_ID && params?.[1] === OPERATOR_ID;
    return { rows: authorized ? [{ authorized: true }] : [], rowCount: authorized ? 1 : 0 };
  });
  const transaction = vi.fn(async () => {
    throw new Error("clinical transaction must not start before authorization");
  });
  const db = { query, transaction, close: vi.fn() } as unknown as DatabaseClient;

  const transcriberConfigured = vi.fn(() => true);
  const transcribe = vi.fn(async () => {
    throw new Error("transcription provider must not be called before authorization");
  });
  const transcriber: SpeechToTextProvider = {
    name: "authorization-test-stt",
    model: "authorization-test-stt-v1",
    language: "spa",
    isConfigured: transcriberConfigured,
    transcribe
  };

  const structurerConfigured = vi.fn(() => true);
  const structure = vi.fn(async () => {
    throw new Error("structuring provider must not be called before authorization");
  });
  const structurer: ClinicalStructurer = {
    name: "authorization-test-llm",
    model: "authorization-test-llm-v1",
    isConfigured: structurerConfigured,
    structure
  };

  const app = Fastify();
  await registerLumenRoutes(
    app,
    {
      db,
      config: {},
      logger: { error: vi.fn() }
    } as unknown as ServiceContext,
    { transcriber, structurer, audioCleanupOwner: "authorization-test" }
  );

  return {
    app,
    query,
    transaction,
    transcriberConfigured,
    transcribe,
    structurerConfigured,
    structure
  };
}

async function createRaceHarness(revokeAtGrantCheck: number) {
  let grantChecks = 0;
  let transactionActive = false;
  let providerRanInTransaction = false;
  const transactionQueries: RecordedQuery[][] = [];
  const mutations: RecordedQuery[] = [];

  const dispatchQuery = async (sql: string, params?: unknown[], transactionLog?: RecordedQuery[]) => {
    const query = { sql, params };
    transactionLog?.push(query);
    const normalized = sql.toLowerCase();

    if (normalized.includes("from lumen.operator_grants")) {
      grantChecks += 1;
      const authorized = grantChecks < revokeAtGrantCheck;
      return { rows: authorized ? [{ authorized: true }] : [], rowCount: authorized ? 1 : 0 };
    }
    if (normalized.includes("select status from lumen.encounters")) {
      return { rows: [{ status: "preconsultation" }], rowCount: 1 };
    }
    if (normalized.includes('select updated_at::text as "updatedat" from lumen.clinical_records')) {
      return { rows: [], rowCount: 0 };
    }
    if (/^\s*(insert|update|delete)\b/i.test(sql)) {
      mutations.push(query);
      if (normalized.includes("insert into lumen.processing_attempts")) {
        return { rows: [{ id: ATTEMPT_ID }], rowCount: 1 };
      }
      if (normalized.includes("update lumen.processing_attempts")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected clinical mutation after grant revocation: ${normalized.trim()}`);
    }
    throw new Error(`Unexpected authorization-race query: ${normalized.trim()}`);
  };

  const query = vi.fn((sql: string, params?: unknown[]) => dispatchQuery(sql, params));
  const transactionImplementation = async <T>(callback: (client: DatabaseTransaction) => Promise<T>): Promise<T> => {
    const transactionLog: RecordedQuery[] = [];
    transactionQueries.push(transactionLog);
    transactionActive = true;
    try {
      const client = {
        query: (sql: string, params?: unknown[]) => dispatchQuery(sql, params, transactionLog)
      } as unknown as DatabaseTransaction;
      return await callback(client);
    } finally {
      transactionActive = false;
    }
  };
  const transaction = vi.fn(transactionImplementation);
  const db = { query, transaction, close: vi.fn() } as unknown as DatabaseClient;

  const transcribe = vi.fn(async () => {
    providerRanInTransaction ||= transactionActive;
    return {
      transcript: RACE_TRANSCRIPT,
      provider: "authorization-race-stt",
      model: "authorization-race-stt-v1",
      language: "spa",
      durationSeconds: 8,
      audioSha256: "a".repeat(64),
      requestIdHash: "1".repeat(64),
      traceIdHash: "2".repeat(64),
      temporaryAudioDeleted: true as const
    };
  });
  const transcriber: SpeechToTextProvider = {
    name: "authorization-race-stt",
    model: "authorization-race-stt-v1",
    language: "spa",
    isConfigured: () => true,
    transcribe
  };

  const structure = vi.fn(async () => {
    providerRanInTransaction ||= transactionActive;
    return {
      content: RACE_CONTENT,
      provider: "authorization-race-llm",
      model: "authorization-race-llm-v1"
    };
  });
  const structurer: ClinicalStructurer = {
    name: "authorization-race-llm",
    model: "authorization-race-llm-v1",
    isConfigured: () => true,
    structure
  };

  const app = Fastify();
  await registerLumenRoutes(
    app,
    {
      db,
      config: {},
      logger: { error: vi.fn() }
    } as unknown as ServiceContext,
    { transcriber, structurer, audioCleanupOwner: "authorization-race" }
  );

  return {
    app,
    grantChecks: () => grantChecks,
    providerRanInTransaction: () => providerRanInTransaction,
    transactionQueries,
    mutations,
    transcribe,
    structure
  };
}

async function injectMutation(app: FastifyInstance, kind: MutationKind) {
  switch (kind) {
    case "start":
      return app.inject({
        method: "POST",
        url: `/v1/tenants/${TENANT_ID}/lumen/encounters/${ENCOUNTER_ID}/start`,
        headers: operatorHeaders("advisor")
      });
    case "transcription":
      return app.inject({
        method: "POST",
        url: `/v1/tenants/${TENANT_ID}/lumen/encounters/${ENCOUNTER_ID}/transcriptions`,
        headers: operatorHeaders("advisor"),
        payload: {
          audioBase64: validWebmAudioBase64(),
          mimeType: "audio/webm",
          source: "browser_microphone",
          durationSeconds: 8,
          idempotencyKey: IDEMPOTENCY_KEY
        }
      });
    case "structure":
      return app.inject({
        method: "POST",
        url: `/v1/tenants/${TENANT_ID}/lumen/encounters/${ENCOUNTER_ID}/structure`,
        headers: operatorHeaders("advisor"),
        payload: { transcript: RACE_TRANSCRIPT, idempotencyKey: IDEMPOTENCY_KEY }
      });
    case "patch":
      return app.inject({
        method: "PATCH",
        url: `/v1/tenants/${TENANT_ID}/lumen/encounters/${ENCOUNTER_ID}/record`,
        headers: operatorHeaders("advisor"),
        payload: { content: RACE_CONTENT }
      });
    case "approve":
      return app.inject({
        method: "POST",
        url: `/v1/tenants/${TENANT_ID}/lumen/encounters/${ENCOUNTER_ID}/approve`,
        headers: operatorHeaders("advisor")
      });
  }
}

function expectGrantHold(queries: RecordedQuery[] | undefined): void {
  expect(queries?.[0]?.sql).toContain("from lumen.operator_grants");
  expect(queries?.[0]?.sql).toContain("is_active and can_review");
  expect(queries?.[0]?.sql).toContain("for share");
  expect(queries?.[0]?.params).toEqual([TENANT_ID, OPERATOR_ID]);
}

function validWebmAudioBase64(): string {
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(28)]).toString("base64");
}

function operatorHeaders(role: string) {
  return { "x-operator-id": OPERATOR_ID, "x-operator-role": role };
}
