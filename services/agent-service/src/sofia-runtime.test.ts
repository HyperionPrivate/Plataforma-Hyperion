import type { DatabaseClient } from "@hyperion/database";
import { describe, expect, it, vi } from "vitest";
import type { LlmCompletionInput, LlmProvider } from "./llm-provider.js";
import {
  availabilityMatchesSearch,
  canonicalizeAvailabilitySearchArguments,
  deriveAgendaSelection,
  hasUnverifiedAvailabilityClock,
  isUrgencySignal,
  matchesAuthoritativeAvailabilitySlot,
  registerSofiaReadinessRoute,
  requiresFreshAvailability,
  sanitizeSofiaState,
  SofiaRuntime
} from "./sofia-runtime.js";

describe("SOFIA deterministic urgency guard", () => {
  it("stops scheduling for controlled urgency phrases", () => {
    expect(isUrgencySignal("Perdí la visión de forma repentina")).toBe(true);
    expect(isUrgencySignal("Tuve un golpe fuerte en el ojo")).toBe(true);
    expect(isUrgencySignal("Tengo picazón y el ojo rojo")).toBe(true);
  });

  it("does not classify ordinary scheduling requests as urgency", () => {
    expect(isUrgencySignal("Quiero una consulta de optometría en Sotomayor")).toBe(false);
  });

  it("does not downgrade a completed conversation when an inbound event is redelivered", async () => {
    const event = {
      id: "00000000-0000-4000-8000-000000000001",
      tenantId: "00000000-0000-4000-8000-000000000002",
      threadBindingId: "00000000-0000-4000-8000-000000000003",
      externalMessageId: "provider-message-1",
      phoneHash: "a".repeat(64),
      phoneMasked: "+57******1234",
      body: "Hola",
      occurredAt: new Date().toISOString(),
      attemptCount: 1
    };
    const queries: string[] = [];
    const db = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 0, command: "INSERT", oid: 0, fields: [] };
      }),
      transaction: vi.fn(),
      close: vi.fn()
    } as unknown as DatabaseClient;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/internal/v1/whatsapp/inbound/claim")) {
        return jsonResponse({ events: [event] });
      }
      if (target.includes("identify_patient_by_phone")) {
        return jsonResponse({
          patientId: "00000000-0000-4000-8000-000000000004",
          conversationId: "00000000-0000-4000-8000-000000000005",
          messageId: "00000000-0000-4000-8000-000000000006"
        });
      }
      return jsonResponse({ completed: true });
    });
    const llm = {
      name: "test",
      model: "test",
      isConfigured: () => true,
      complete: vi.fn()
    } as unknown as LlmProvider;
    const runtime = new SofiaRuntime({
      db,
      logger: { warn: vi.fn() },
      llm,
      internalServiceToken: "test-token",
      channelUrl: "http://channel.test",
      promptFlowUrl: "http://prompt.test",
      pulsoIrisUrl: "http://pulso.test",
      auditUrl: "http://audit.test",
      fetchImpl: fetchImpl as typeof fetch
    });

    await runtime.ingestOnce();

    expect(queries.some((sql) => sql.includes("'sofiaStatus', 'queued'"))).toBe(false);
  });

  it("reports ready only from the v2 confirmation prompt", async () => {
    const query = vi.fn(async (_sql: string) => ({
      rows: [{ count: 1 }],
      rowCount: 1,
      command: "SELECT",
      oid: 0,
      fields: []
    }));
    let routeHandler:
      | ((
          request: { headers: { authorization: string }; params: { tenantId: string }; id: string },
          reply: unknown
        ) => Promise<unknown>)
      | undefined;
    const app = {
      get: vi.fn((_path: string, handler: typeof routeHandler) => {
        routeHandler = handler;
      })
    };
    registerSofiaReadinessRoute(app as never, {
      db: { query, transaction: vi.fn(), close: vi.fn() } as unknown as DatabaseClient,
      llm: { model: "controlled", isConfigured: () => true } as unknown as LlmProvider,
      internalServiceToken: "internal-controlled-token",
      workerEnabled: true,
      runtime: { isRunning: () => true }
    });

    const response = (await routeHandler!(
      {
        headers: { authorization: "Bearer internal-controlled-token" },
        params: { tenantId: "00000000-0000-4000-8000-000000000001" },
        id: "controlled-readiness"
      },
      {}
    )) as { data: { ready: boolean; workerEnabled: boolean; workerRunning: boolean } };

    expect(response.data).toMatchObject({ ready: true, workerEnabled: true, workerRunning: true });
    expect(String(query.mock.calls[0]?.[0])).toContain("sofia_whatsapp_internal_v5");
    expect(String(query.mock.calls[0]?.[0])).toContain("016-sofia-search-constraints.sql");
    expect(String(query.mock.calls[0]?.[0])).toContain("order by f.version desc, f.updated_at desc");
  });
});

describe("SOFIA fresh availability guard", () => {
  it("classifies dated requests and contextual slot selections without intercepting confirmations", () => {
    expect(requiresFreshAvailability("Quiero la cita del lunes 13 de julio a las 9:00 a. m.")).toBe(true);
    expect(requiresFreshAvailability("¿Qué horarios tienen disponibles?")).toBe(true);
    expect(requiresFreshAvailability("¿Hay espacio el 13?")).toBe(true);
    expect(requiresFreshAvailability("¿Pueden atenderme temprano?")).toBe(true);
    expect(requiresFreshAvailability("¿Me ayudas con el 13?")).toBe(false);
    expect(requiresFreshAvailability("El primero me sirve", true)).toBe(true);
    expect(requiresFreshAvailability("El de las 9:20 a. m.", true)).toBe(true);
    expect(requiresFreshAvailability("CONFIRMO", true)).toBe(false);
    expect(requiresFreshAvailability("¿Qué citas tengo?", true)).toBe(false);
    expect(requiresFreshAvailability("Quiero cancelar mi cita", true)).toBe(false);
  });

  it("keeps only schema v3 availability inside its TTL", () => {
    const now = Date.parse("2026-07-10T02:00:00.000Z");
    const legacy = sanitizeSofiaState(
      {
        pendingAction: { tool: "create_appointment_hold" },
        lastAvailability: { slots: [{ localTime: "14:00" }] },
        lastAvailabilityAt: "2026-07-10T01:59:00.000Z"
      },
      now
    );
    expect(legacy.availabilityStatus).toBe("invalid");
    expect(legacy.state).toEqual({ pendingAction: { tool: "create_appointment_hold" } });

    const expired = sanitizeSofiaState(
      {
        lastAvailabilitySchemaVersion: 3,
        lastAvailability: { slots: [{ localTime: "09:00" }] },
        lastAvailabilityAt: "2026-07-10T01:49:59.000Z"
      },
      now
    );
    expect(expired).toEqual({ state: {}, availabilityStatus: "invalid" });

    const current = sanitizeSofiaState(
      {
        lastAvailabilitySchemaVersion: 3,
        lastAvailability: {
          slots: [
            {
              siteId: "00000000-0000-4000-8000-000000000021",
              siteName: "Sede Principal Sotomayor",
              professionalId: "00000000-0000-4000-8000-000000000022",
              professionalName: "Agenda piloto PULSO IRIS",
              payerId: "00000000-0000-4000-8000-000000000024",
              payerName: "Particular",
              appointmentTypeId: "00000000-0000-4000-8000-000000000023",
              appointmentTypeName: "Consulta optometria",
              startsAt: "2026-07-13T14:00:00.000Z",
              scheduledAt: "2026-07-13T14:00:00.000Z",
              localDate: "2026-07-13",
              localTime: "09:00",
              timeZone: "America/Bogota"
            }
          ]
        },
        lastAvailabilityQuery: {
          siteId: "00000000-0000-4000-8000-000000000021",
          professionalId: "00000000-0000-4000-8000-000000000022",
          payerId: "00000000-0000-4000-8000-000000000024",
          appointmentTypeId: "00000000-0000-4000-8000-000000000023",
          localDate: "2026-07-13",
          localTime: "09:00",
          days: 1
        },
        lastAvailabilityAt: "2026-07-10T01:59:00.000Z"
      },
      now
    );
    expect(current.availabilityStatus).toBe("valid");
    expect(current.state).toMatchObject({ lastAvailabilitySchemaVersion: 3 });
  });

  it("rejects clock times that are not present in the authoritative local slots", () => {
    const slots = [
      {
        siteId: "00000000-0000-4000-8000-000000000021",
        siteName: "Sede Principal Sotomayor",
        professionalId: "00000000-0000-4000-8000-000000000022",
        professionalName: "Agenda piloto PULSO IRIS",
        payerId: "00000000-0000-4000-8000-000000000024",
        payerName: "Particular",
        appointmentTypeId: "00000000-0000-4000-8000-000000000023",
        appointmentTypeName: "Consulta optometria",
        startsAt: "2026-07-13T14:00:00.000Z",
        scheduledAt: "2026-07-13T14:00:00.000Z",
        localDate: "2026-07-13",
        localTime: "09:00",
        timeZone: "America/Bogota"
      }
    ];

    expect(hasUnverifiedAvailabilityClock("Hay disponibilidad a las 9:00 a. m.", slots)).toBe(false);
    expect(hasUnverifiedAvailabilityClock("Solo hay disponibilidad a las 2:00 p. m.", slots)).toBe(true);
    expect(hasUnverifiedAvailabilityClock("El slot dura 20 minutos.", slots)).toBe(false);
    expect(
      matchesAuthoritativeAvailabilitySlot(
        JSON.stringify({
          siteId: slots[0]!.siteId,
          professionalId: slots[0]!.professionalId,
          payerId: slots[0]!.payerId,
          appointmentTypeId: slots[0]!.appointmentTypeId,
          scheduledAt: slots[0]!.scheduledAt
        }),
        slots
      )
    ).toBe(true);
    expect(
      matchesAuthoritativeAvailabilitySlot(
        JSON.stringify({
          siteId: slots[0]!.siteId,
          professionalId: slots[0]!.professionalId,
          payerId: slots[0]!.payerId,
          appointmentTypeId: slots[0]!.appointmentTypeId,
          scheduledAt: "2026-07-13T19:00:00.000Z"
        }),
        slots
      )
    ).toBe(false);
    expect(
      matchesAuthoritativeAvailabilitySlot(
        JSON.stringify({
          siteId: slots[0]!.siteId,
          professionalId: slots[0]!.professionalId,
          payerId: "00000000-0000-4000-8000-000000000099",
          appointmentTypeId: slots[0]!.appointmentTypeId,
          scheduledAt: slots[0]!.scheduledAt
        }),
        slots
      )
    ).toBe(false);
  });

  it("overrides omitted or conflicting model filters with deterministic local constraints", () => {
    const catalog = {
      sites: [{ id: "00000000-0000-4000-8000-000000000021", name: "Sotomayor" }],
      professionals: [{ id: "00000000-0000-4000-8000-000000000022", name: "Agenda piloto" }],
      payers: [{ id: "00000000-0000-4000-8000-000000000024", name: "Particular" }],
      appointmentTypes: [{ id: "00000000-0000-4000-8000-000000000023", name: "Optometria" }]
    };
    const selection = {
      siteId: catalog.sites[0]!.id,
      professionalId: catalog.professionals[0]!.id,
      payerId: catalog.payers[0]!.id,
      appointmentTypeId: catalog.appointmentTypes[0]!.id
    };
    const constraints = {
      localDate: "2026-07-13",
      localTime: "09:00",
      bookingIntent: true,
      rescheduleIntent: false,
      requestsChange: false
    };
    const canonical = canonicalizeAvailabilitySearchArguments(
      JSON.stringify({ from: "2026-07-10T03:27:20.000Z", days: 3 }),
      constraints,
      selection,
      catalog
    );
    expect(canonical).toEqual({
      ok: true,
      arguments: { ...selection, localDate: "2026-07-13", localTime: "09:00", days: 1 }
    });
  });

  it("rejects a provider result outside the canonical date or payer", () => {
    const slot = {
      siteId: "00000000-0000-4000-8000-000000000021",
      siteName: "Sede Principal Sotomayor",
      professionalId: "00000000-0000-4000-8000-000000000022",
      professionalName: "Agenda piloto PULSO IRIS",
      payerId: "00000000-0000-4000-8000-000000000024",
      payerName: "Particular",
      appointmentTypeId: "00000000-0000-4000-8000-000000000023",
      appointmentTypeName: "Consulta optometria",
      startsAt: "2026-07-13T14:00:00.000Z",
      scheduledAt: "2026-07-13T14:00:00.000Z",
      localDate: "2026-07-13",
      localTime: "09:00",
      timeZone: "America/Bogota"
    };
    const search = {
      localDate: slot.localDate,
      payerId: slot.payerId,
      siteId: slot.siteId,
      professionalId: slot.professionalId,
      appointmentTypeId: slot.appointmentTypeId
    };
    expect(availabilityMatchesSearch([slot], search)).toBe(true);
    expect(availabilityMatchesSearch([{ ...slot, localDate: "2026-07-10" }], search)).toBe(false);
    expect(
      availabilityMatchesSearch(
        [{ ...slot, payerId: "00000000-0000-4000-8000-000000000099", payerName: "Otro" }],
        search
      )
    ).toBe(false);
  });

  it("inherits a structured date for a clock-only selection and rejects model-selected catalog ids", () => {
    const catalog = {
      sites: [{ id: "00000000-0000-4000-8000-000000000021", name: "Sotomayor" }],
      professionals: [{ id: "00000000-0000-4000-8000-000000000022", name: "Agenda piloto" }],
      payers: [{ id: "00000000-0000-4000-8000-000000000024", name: "Particular" }],
      appointmentTypes: [{ id: "00000000-0000-4000-8000-000000000023", name: "Optometria" }]
    };
    const selection = {
      siteId: catalog.sites[0]!.id,
      professionalId: catalog.professionals[0]!.id,
      payerId: catalog.payers[0]!.id,
      appointmentTypeId: catalog.appointmentTypes[0]!.id
    };
    const result = canonicalizeAvailabilitySearchArguments(
      JSON.stringify({ localDate: "2026-07-10", localTime: "14:00", ...selection }),
      {
        localTime: "09:20",
        bookingIntent: true,
        rescheduleIntent: false,
        requestsChange: false
      },
      selection,
      catalog,
      { ...selection, localDate: "2026-07-13", days: 1 }
    );
    expect(result).toEqual({
      ok: true,
      arguments: { ...selection, localDate: "2026-07-13", localTime: "09:20", days: 1 }
    });

    const untrusted = canonicalizeAvailabilitySearchArguments(
      JSON.stringify({ siteId: catalog.sites[0]!.id }),
      { bookingIntent: false, rescheduleIntent: false, requestsChange: false },
      {},
      catalog
    );
    expect(untrusted).toMatchObject({ ok: false, code: "untrusted_catalog_reference" });

    const pastContextualClock = canonicalizeAvailabilitySearchArguments(
      "{}",
      { localTime: "09:00", bookingIntent: true, rescheduleIntent: false, requestsChange: false },
      selection,
      catalog,
      { ...selection, localDate: "2026-07-09", days: 1 },
      { now: new Date("2026-07-10T03:00:00.000Z"), timeZone: "America/Bogota" }
    );
    expect(pastContextualClock).toMatchObject({ ok: false, code: "past_patient_date_constraint" });

    const untrustedProfessional = canonicalizeAvailabilitySearchArguments(
      JSON.stringify({ professionalId: catalog.professionals[0]!.id }),
      { localDate: "2026-07-13", bookingIntent: false, rescheduleIntent: false, requestsChange: false },
      {
        siteId: selection.siteId,
        payerId: selection.payerId,
        appointmentTypeId: selection.appointmentTypeId
      },
      catalog
    );
    expect(untrustedProfessional).toEqual({
      ok: true,
      arguments: {
        siteId: selection.siteId,
        payerId: selection.payerId,
        appointmentTypeId: selection.appointmentTypeId,
        localDate: "2026-07-13",
        days: 1
      }
    });
  });

  it("preserves unchanged structured dimensions and requires an explicit changed value", () => {
    const catalog = {
      sites: [{ id: "00000000-0000-4000-8000-000000000021", name: "Sede Sotomayor" }],
      professionals: [{ id: "00000000-0000-4000-8000-000000000022", name: "Agenda piloto" }],
      payers: [
        { id: "00000000-0000-4000-8000-000000000024", name: "Particular" },
        { id: "00000000-0000-4000-8000-000000000025", name: "Convenio Salud" }
      ],
      appointmentTypes: [{ id: "00000000-0000-4000-8000-000000000023", name: "Consulta optometria" }]
    };
    const previous = {
      siteId: catalog.sites[0]!.id,
      professionalId: catalog.professionals[0]!.id,
      payerId: catalog.payers[0]!.id,
      appointmentTypeId: catalog.appointmentTypes[0]!.id,
      localDate: "2026-07-13",
      days: 1
    };
    const unresolved = deriveAgendaSelection(
      "Quiero otro convenio",
      { bookingIntent: true, rescheduleIntent: false, requestsChange: true },
      { timeZone: "America/Bogota", state: { lastAvailabilityQuery: previous }, catalog },
      catalog
    );
    expect(unresolved.selection).toEqual({
      siteId: previous.siteId,
      professionalId: previous.professionalId,
      appointmentTypeId: previous.appointmentTypeId
    });
    expect(unresolved.unresolvedChangedDimensions).toEqual(["payerId"]);

    const resolved = deriveAgendaSelection(
      "Quiero otro convenio, Convenio Salud",
      { bookingIntent: true, rescheduleIntent: false, requestsChange: true },
      { timeZone: "America/Bogota", state: { lastAvailabilityQuery: previous }, catalog },
      catalog
    );
    expect(resolved.selection).toMatchObject({
      siteId: previous.siteId,
      professionalId: previous.professionalId,
      payerId: catalog.payers[1]!.id,
      appointmentTypeId: previous.appointmentTypeId
    });
    expect(resolved.unresolvedChangedDimensions).toEqual([]);
  });

  it("validates the requested local clock as a lower bound for returned alternatives", () => {
    const base = {
      siteId: "00000000-0000-4000-8000-000000000021",
      siteName: "Sede Sotomayor",
      professionalId: "00000000-0000-4000-8000-000000000022",
      professionalName: "Agenda piloto",
      payerId: "00000000-0000-4000-8000-000000000024",
      payerName: "Particular",
      appointmentTypeId: "00000000-0000-4000-8000-000000000023",
      appointmentTypeName: "Consulta optometria",
      startsAt: "2026-07-13T14:20:00.000Z",
      scheduledAt: "2026-07-13T14:20:00.000Z",
      localDate: "2026-07-13",
      localTime: "09:20",
      timeZone: "America/Bogota"
    };
    const search = { localDate: "2026-07-13", localTime: "09:20" };
    expect(availabilityMatchesSearch([base], search)).toBe(true);
    expect(
      availabilityMatchesSearch(
        [
          { ...base, localTime: "09:00", startsAt: "2026-07-13T14:00:00.000Z", scheduledAt: "2026-07-13T14:00:00.000Z" }
        ],
        search
      )
    ).toBe(false);
  });

  it("fails closed when the provider ignores the forced search tool", async () => {
    const tenantId = "00000000-0000-4000-8000-000000000011";
    const conversationId = "00000000-0000-4000-8000-000000000012";
    const jobId = "00000000-0000-4000-8000-000000000013";
    const messageId = "00000000-0000-4000-8000-000000000014";
    const currentBody = "Quiero la cita del lunes 13 de julio a las 9:00 a. m.";
    const selection = {
      siteId: "00000000-0000-4000-8000-000000000021",
      professionalId: "00000000-0000-4000-8000-000000000022",
      payerId: "00000000-0000-4000-8000-000000000024",
      appointmentTypeId: "00000000-0000-4000-8000-000000000023"
    };
    let persistedResponse = "";
    const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
      if (sql.includes("claim_next_job")) {
        return dbResult([
          {
            id: jobId,
            tenantId,
            conversationId,
            inboundEventId: "00000000-0000-4000-8000-000000000015",
            attemptCount: 1,
            maxAttempts: 4,
            input: {
              patientId: "00000000-0000-4000-8000-000000000016",
              messageId,
              threadBindingId: "00000000-0000-4000-8000-000000000017",
              occurredAt: new Date().toISOString()
            }
          }
        ]);
      }
      if (sql.includes("select m.body")) {
        return dbResult([{ body: currentBody, conversationStatus: "active" }]);
      }
      if (sql.includes("select sender, body from")) {
        return dbResult([
          { sender: "sofia", body: "Los horarios antiguos eran 2:00 p. m. y 2:20 p. m." },
          { sender: "patient", body: currentBody }
        ]);
      }
      if (sql.includes("coalesce(metadata->'sofiaState'")) {
        return dbResult([
          {
            sofiaState: {
              lastAvailability: { slots: [{ localTime: "14:00" }] },
              lastAvailabilityAt: "2026-07-09T20:00:00.000Z",
              agendaSelection: selection
            }
          }
        ]);
      }
      if (sql.includes("select full_name")) return dbResult([{ fullName: "Paciente controlado" }]);
      if (sql.includes("insert into agent_runtime.executions")) {
        return dbResult([{ id: "00000000-0000-4000-8000-000000000018" }]);
      }
      if (sql.includes("insert into pulso_iris.messages")) {
        persistedResponse = String(parameters?.[2] ?? "");
        return dbResult([{ id: "00000000-0000-4000-8000-000000000019" }]);
      }
      return dbResult([]);
    });
    const db = {
      query,
      transaction: vi.fn(async (callback: (tx: { query: typeof query }) => Promise<unknown>) => callback({ query })),
      close: vi.fn()
    } as unknown as DatabaseClient;
    const complete = vi.fn(async (_input: LlmCompletionInput) => ({
      content: "Los únicos horarios son 2:00 p. m. y 2:20 p. m.",
      toolCalls: [],
      model: "controlled",
      latencyMs: 1
    }));
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("prompt-flows/SOFIA/active")) {
        return jsonResponse({
          id: "00000000-0000-4000-8000-000000000020",
          version: 3,
          systemPrompt: "Prompt administrativo controlado para las pruebas de SOFIA."
        });
      }
      if (target.includes("/sofia/tools/get_catalog")) {
        return jsonResponse({
          sites: [{ id: selection.siteId, name: "Sede controlada" }],
          professionals: [{ id: selection.professionalId, name: "Profesional controlado" }],
          payers: [{ id: selection.payerId, name: "Convenio controlado" }],
          appointmentTypes: [{ id: selection.appointmentTypeId, name: "Tipo controlado" }]
        });
      }
      return jsonResponse({ accepted: true });
    });
    const runtime = new SofiaRuntime({
      db,
      logger: { warn: vi.fn() },
      llm: {
        name: "controlled",
        model: "controlled",
        isConfigured: () => true,
        complete
      },
      internalServiceToken: "controlled-token",
      channelUrl: "http://channel.test",
      promptFlowUrl: "http://prompt.test",
      pulsoIrisUrl: "http://pulso.test",
      auditUrl: "http://audit.test",
      fetchImpl: fetchImpl as typeof fetch
    });

    await expect(runtime.processOne()).resolves.toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
    const completionInput = complete.mock.calls[0]![0];
    expect(completionInput.toolChoice).toEqual({ name: "search_availability" });
    expect(completionInput.messages.some((message) => message.content?.includes("horarios antiguos"))).toBe(true);
    expect(persistedResponse).toContain("no pude consultar la disponibilidad actual");
    expect(persistedResponse).not.toContain("2:00");
  });

  it("renders the fresh authoritative slot without accepting a later free-form answer", async () => {
    const tenantId = "00000000-0000-4000-8000-000000000011";
    const conversationId = "00000000-0000-4000-8000-000000000012";
    const jobId = "00000000-0000-4000-8000-000000000013";
    const messageId = "00000000-0000-4000-8000-000000000014";
    const patientId = "00000000-0000-4000-8000-000000000016";
    const slot = {
      siteId: "00000000-0000-4000-8000-000000000021",
      siteName: "Sede Principal Sotomayor",
      professionalId: "00000000-0000-4000-8000-000000000022",
      professionalName: "Agenda piloto PULSO IRIS",
      payerId: "00000000-0000-4000-8000-000000000024",
      payerName: "Particular",
      appointmentTypeId: "00000000-0000-4000-8000-000000000023",
      appointmentTypeName: "Consulta optometria",
      startsAt: "2026-07-13T14:00:00.000Z",
      scheduledAt: "2026-07-13T14:00:00.000Z",
      localDate: "2026-07-13",
      localTime: "09:00",
      timeZone: "America/Bogota"
    };
    let persistedResponse = "";
    const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
      if (sql.includes("claim_next_job")) {
        return dbResult([
          {
            id: jobId,
            tenantId,
            conversationId,
            inboundEventId: "00000000-0000-4000-8000-000000000015",
            attemptCount: 1,
            maxAttempts: 4,
            input: {
              patientId,
              messageId,
              threadBindingId: "00000000-0000-4000-8000-000000000017",
              occurredAt: new Date().toISOString()
            }
          }
        ]);
      }
      if (sql.includes("select m.body")) {
        return dbResult([
          { body: "Consulta disponibilidad del lunes 13 de julio a las 9:00 a. m.", conversationStatus: "active" }
        ]);
      }
      if (sql.includes("select sender, body from")) {
        return dbResult([
          { sender: "sofia", body: "Antes se mostraron horarios de la tarde." },
          { sender: "patient", body: "Consulta disponibilidad del lunes 13 de julio a las 9:00 a. m." }
        ]);
      }
      if (sql.includes("coalesce(metadata->'sofiaState'")) {
        return dbResult([
          {
            sofiaState: {
              agendaSelection: {
                siteId: slot.siteId,
                professionalId: slot.professionalId,
                payerId: slot.payerId,
                appointmentTypeId: slot.appointmentTypeId
              }
            }
          }
        ]);
      }
      if (sql.includes("select full_name")) return dbResult([{ fullName: "Paciente controlado" }]);
      if (sql.includes("insert into agent_runtime.executions")) {
        return dbResult([{ id: "00000000-0000-4000-8000-000000000018" }]);
      }
      if (sql.includes("insert into pulso_iris.messages")) {
        persistedResponse = String(parameters?.[2] ?? "");
        return dbResult([{ id: "00000000-0000-4000-8000-000000000019" }]);
      }
      return dbResult([]);
    });
    const db = {
      query,
      transaction: vi.fn(async (callback: (tx: { query: typeof query }) => Promise<unknown>) => callback({ query })),
      close: vi.fn()
    } as unknown as DatabaseClient;
    const complete = vi
      .fn()
      .mockResolvedValueOnce({
        content: null,
        toolCalls: [
          {
            id: "fresh-search",
            name: "search_availability",
            arguments: JSON.stringify({
              siteId: slot.siteId,
              professionalId: slot.professionalId,
              payerId: slot.payerId,
              appointmentTypeId: slot.appointmentTypeId,
              from: "2026-07-13T05:00:00.000Z",
              days: 1
            })
          }
        ],
        model: "controlled",
        latencyMs: 1
      })
      .mockResolvedValueOnce({
        content: "Las 9:00 a. m. no están disponibles; solo hay horarios a las 2:00 p. m.",
        toolCalls: [],
        model: "controlled",
        latencyMs: 1
      });
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("prompt-flows/SOFIA/active")) {
        return jsonResponse({
          id: "00000000-0000-4000-8000-000000000020",
          version: 4,
          systemPrompt: "Prompt administrativo controlado para las pruebas de SOFIA."
        });
      }
      if (target.includes("/sofia/tools/get_catalog")) {
        return jsonResponse({
          sites: [{ id: slot.siteId, name: slot.siteName }],
          professionals: [{ id: slot.professionalId, name: slot.professionalName }],
          payers: [{ id: slot.payerId, name: slot.payerName }],
          appointmentTypes: [{ id: slot.appointmentTypeId, name: slot.appointmentTypeName }]
        });
      }
      if (target.includes("/sofia/tools/search_availability")) return jsonResponse({ slots: [slot] });
      return jsonResponse({ accepted: true });
    });
    const runtime = new SofiaRuntime({
      db,
      logger: { warn: vi.fn() },
      llm: { name: "controlled", model: "controlled", isConfigured: () => true, complete },
      internalServiceToken: "controlled-token",
      channelUrl: "http://channel.test",
      promptFlowUrl: "http://prompt.test",
      pulsoIrisUrl: "http://pulso.test",
      auditUrl: "http://audit.test",
      fetchImpl: fetchImpl as typeof fetch
    });

    await expect(runtime.processOne()).resolves.toBe(true);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(persistedResponse).toContain("9:00 a. m.");
    expect(persistedResponse).not.toContain("no están disponibles");
    expect(persistedResponse).not.toContain("2:00");
  });

  it("stages an exact fresh slot without a second model round and renders one deterministic confirmation", async () => {
    const tenantId = "00000000-0000-4000-8000-000000000011";
    const conversationId = "00000000-0000-4000-8000-000000000012";
    const jobId = "00000000-0000-4000-8000-000000000013";
    const messageId = "00000000-0000-4000-8000-000000000014";
    const patientId = "00000000-0000-4000-8000-000000000016";
    const slot = {
      siteId: "00000000-0000-4000-8000-000000000021",
      siteName: "Sede Principal Sotomayor",
      professionalId: "00000000-0000-4000-8000-000000000022",
      professionalName: "Agenda piloto PULSO IRIS",
      payerId: "00000000-0000-4000-8000-000000000024",
      payerName: "Particular",
      appointmentTypeId: "00000000-0000-4000-8000-000000000023",
      appointmentTypeName: "Consulta optometria",
      startsAt: "2026-07-13T14:00:00.000Z",
      scheduledAt: "2026-07-13T14:00:00.000Z",
      localDate: "2026-07-13",
      localTime: "09:00",
      timeZone: "America/Bogota"
    };
    let persistedResponse = "";
    let pendingActionUpdates = 0;
    const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
      if (sql.includes("claim_next_job")) {
        return dbResult([
          {
            id: jobId,
            tenantId,
            conversationId,
            inboundEventId: "00000000-0000-4000-8000-000000000015",
            attemptCount: 1,
            maxAttempts: 4,
            input: {
              patientId,
              messageId,
              threadBindingId: "00000000-0000-4000-8000-000000000017",
              occurredAt: new Date().toISOString()
            }
          }
        ]);
      }
      if (sql.includes("select m.body")) {
        return dbResult([
          { body: "Quiero la cita del lunes 13 de julio a las 9:00 a. m.", conversationStatus: "active" }
        ]);
      }
      if (sql.includes("select sender, body from")) {
        return dbResult([{ sender: "patient", body: "Quiero la cita del lunes 13 de julio a las 9:00 a. m." }]);
      }
      if (sql.includes("and (($3::text is null")) {
        pendingActionUpdates += 1;
        return dbResult([{}]);
      }
      if (sql.includes("coalesce(metadata->'sofiaState'")) {
        return dbResult([
          {
            sofiaState: {
              agendaSelection: {
                siteId: slot.siteId,
                professionalId: slot.professionalId,
                payerId: slot.payerId,
                appointmentTypeId: slot.appointmentTypeId
              }
            },
            state: {}
          }
        ]);
      }
      if (sql.includes("select full_name")) return dbResult([{ fullName: "Paciente controlado" }]);
      if (sql.includes("insert into agent_runtime.executions")) {
        return dbResult([{ id: "00000000-0000-4000-8000-000000000018" }]);
      }
      if (sql.includes("insert into pulso_iris.messages")) {
        persistedResponse = String(parameters?.[2] ?? "");
        return dbResult([{ id: "00000000-0000-4000-8000-000000000019" }]);
      }
      return dbResult([]);
    });
    const db = {
      query,
      transaction: vi.fn(async (callback: (tx: { query: typeof query }) => Promise<unknown>) => callback({ query })),
      close: vi.fn()
    } as unknown as DatabaseClient;
    const complete = vi
      .fn()
      .mockResolvedValueOnce({
        content: null,
        toolCalls: [
          {
            id: "fresh-search",
            name: "search_availability",
            arguments: "{}"
          }
        ],
        model: "controlled",
        latencyMs: 1
      })
      .mockResolvedValueOnce({
        content: null,
        toolCalls: [
          {
            id: "stage-hold",
            name: "create_appointment_hold",
            arguments: JSON.stringify({
              siteId: slot.siteId,
              professionalId: slot.professionalId,
              payerId: slot.payerId,
              appointmentTypeId: slot.appointmentTypeId,
              scheduledAt: slot.scheduledAt
            })
          }
        ],
        model: "controlled",
        latencyMs: 1
      });
    let searchPayload: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("prompt-flows/SOFIA/active")) {
        return jsonResponse({
          id: "00000000-0000-4000-8000-000000000020",
          version: 4,
          systemPrompt: "Prompt administrativo controlado para las pruebas de SOFIA."
        });
      }
      if (target.includes("/sofia/tools/get_catalog")) {
        return jsonResponse({
          sites: [{ id: slot.siteId, name: slot.siteName }],
          professionals: [{ id: slot.professionalId, name: slot.professionalName }],
          payers: [{ id: slot.payerId, name: slot.payerName }],
          appointmentTypes: [{ id: slot.appointmentTypeId, name: slot.appointmentTypeName }],
          agendaSettings: { timezone: slot.timeZone }
        });
      }
      if (target.includes("/sofia/tools/search_availability")) {
        searchPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ slots: [slot] });
      }
      return jsonResponse({ accepted: true });
    });
    const runtime = new SofiaRuntime({
      db,
      logger: { warn: vi.fn() },
      llm: { name: "controlled", model: "controlled", isConfigured: () => true, complete },
      internalServiceToken: "controlled-token",
      channelUrl: "http://channel.test",
      promptFlowUrl: "http://prompt.test",
      pulsoIrisUrl: "http://pulso.test",
      auditUrl: "http://audit.test",
      fetchImpl: fetchImpl as typeof fetch
    });

    await expect(runtime.processOne()).resolves.toBe(true);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(pendingActionUpdates).toBe(1);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/sofia/tools/create_appointment_hold"))).toBe(
      false
    );
    expect(searchPayload).toEqual({
      siteId: slot.siteId,
      professionalId: slot.professionalId,
      payerId: slot.payerId,
      appointmentTypeId: slot.appointmentTypeId,
      localDate: "2026-07-13",
      localTime: "09:00",
      days: 1
    });
    expect(persistedResponse).toContain("Consulta optometria");
    expect(persistedResponse).toContain("Sede Principal Sotomayor");
    expect(persistedResponse).toContain("Particular");
    expect(persistedResponse).toContain("9:00 a. m.");
    expect(persistedResponse).toContain("CONFIRMO");
  });

  it("stages a reschedule only for the exact requested local clock after a fresh search", async () => {
    const tenantId = "00000000-0000-4000-8000-000000000011";
    const conversationId = "00000000-0000-4000-8000-000000000012";
    const jobId = "00000000-0000-4000-8000-000000000013";
    const messageId = "00000000-0000-4000-8000-000000000014";
    const patientId = "00000000-0000-4000-8000-000000000016";
    const appointmentId = "00000000-0000-4000-8000-000000000026";
    const exactSlot = {
      siteId: "00000000-0000-4000-8000-000000000021",
      siteName: "Sede Principal Sotomayor",
      professionalId: "00000000-0000-4000-8000-000000000022",
      professionalName: "Agenda piloto PULSO IRIS",
      payerId: "00000000-0000-4000-8000-000000000024",
      payerName: "Particular",
      appointmentTypeId: "00000000-0000-4000-8000-000000000023",
      appointmentTypeName: "Consulta optometria",
      startsAt: "2026-07-13T14:00:00.000Z",
      scheduledAt: "2026-07-13T14:00:00.000Z",
      localDate: "2026-07-13",
      localTime: "09:00",
      timeZone: "America/Bogota"
    };
    const laterSlot = {
      ...exactSlot,
      startsAt: "2026-07-13T14:20:00.000Z",
      scheduledAt: "2026-07-13T14:20:00.000Z",
      localTime: "09:20"
    };
    let persistedResponse = "";
    let pendingActionUpdates = 0;
    const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
      if (sql.includes("claim_next_job")) {
        return dbResult([
          {
            id: jobId,
            tenantId,
            conversationId,
            inboundEventId: "00000000-0000-4000-8000-000000000015",
            attemptCount: 1,
            maxAttempts: 4,
            input: {
              patientId,
              messageId,
              threadBindingId: "00000000-0000-4000-8000-000000000017",
              occurredAt: "2026-07-10T03:27:00.000Z"
            }
          }
        ]);
      }
      if (sql.includes("select m.body")) {
        return dbResult([
          {
            body: "Quiero reagendar mi cita al lunes 13 de julio de 2026 a las 9:00 a. m.",
            conversationStatus: "active"
          }
        ]);
      }
      if (sql.includes("select sender, body from")) return dbResult([]);
      if (sql.includes('as "sofiaState"')) {
        return dbResult([
          {
            sofiaState: {
              agendaSelection: {
                siteId: exactSlot.siteId,
                professionalId: exactSlot.professionalId,
                payerId: exactSlot.payerId,
                appointmentTypeId: exactSlot.appointmentTypeId
              }
            }
          }
        ]);
      }
      if (sql.includes(" as state,")) {
        return dbResult([{ state: {}, pendingExpired: false, grantExpired: false }]);
      }
      if (sql.includes("select full_name")) return dbResult([{ fullName: "Paciente controlado" }]);
      if (sql.includes("insert into agent_runtime.executions")) {
        return dbResult([{ id: "00000000-0000-4000-8000-000000000018" }]);
      }
      if (sql.includes("and (($3::text is null")) {
        pendingActionUpdates += 1;
        return dbResult([{}]);
      }
      if (sql.includes("insert into pulso_iris.messages")) {
        persistedResponse = String(parameters?.[2] ?? "");
        return dbResult([{ id: "00000000-0000-4000-8000-000000000019" }]);
      }
      return dbResult([]);
    });
    const db = {
      query,
      transaction: vi.fn(async (callback: (tx: { query: typeof query }) => Promise<unknown>) => callback({ query })),
      close: vi.fn()
    } as unknown as DatabaseClient;
    const complete = vi.fn().mockResolvedValueOnce({
      content: null,
      toolCalls: [{ id: "fresh-search", name: "search_availability", arguments: "{}" }],
      model: "controlled",
      latencyMs: 1
    });
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("prompt-flows/SOFIA/active")) {
        return jsonResponse({
          id: "00000000-0000-4000-8000-000000000020",
          version: 5,
          systemPrompt: "Prompt administrativo controlado para las pruebas de SOFIA."
        });
      }
      if (target.includes("/sofia/tools/get_catalog")) {
        return jsonResponse({
          sites: [{ id: exactSlot.siteId, name: exactSlot.siteName }],
          professionals: [{ id: exactSlot.professionalId, name: exactSlot.professionalName }],
          payers: [{ id: exactSlot.payerId, name: exactSlot.payerName }],
          appointmentTypes: [{ id: exactSlot.appointmentTypeId, name: exactSlot.appointmentTypeName }],
          agendaSettings: { timezone: exactSlot.timeZone }
        });
      }
      if (target.includes("/sofia/tools/search_availability")) {
        return jsonResponse({ slots: [exactSlot, laterSlot] });
      }
      if (target.includes("/sofia/tools/list_patient_appointments")) {
        return jsonResponse({
          appointments: [
            {
              id: appointmentId,
              status: "verified",
              scheduledAt: "2026-07-13T13:40:00.000Z"
            }
          ]
        });
      }
      return jsonResponse({ accepted: true });
    });
    const runtime = new SofiaRuntime({
      db,
      logger: { warn: vi.fn() },
      llm: { name: "controlled", model: "controlled", isConfigured: () => true, complete },
      internalServiceToken: "controlled-token",
      channelUrl: "http://channel.test",
      promptFlowUrl: "http://prompt.test",
      pulsoIrisUrl: "http://pulso.test",
      auditUrl: "http://audit.test",
      fetchImpl: fetchImpl as typeof fetch
    });

    await expect(runtime.processOne()).resolves.toBe(true);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(pendingActionUpdates).toBe(1);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/sofia/tools/list_patient_appointments"))).toBe(
      true
    );
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/sofia/tools/reschedule_appointment"))).toBe(
      false
    );
    expect(persistedResponse).toContain("reagendar tu cita");
    expect(persistedResponse).toContain("9:00 a. m.");
    expect(persistedResponse).not.toContain("9:20");
    expect(persistedResponse).toContain("CONFIRMO");
  });

  it("does not stage a reschedule for an appointment whose scheduled time already passed", async () => {
    const tenantId = "00000000-0000-4000-8000-000000000011";
    const conversationId = "00000000-0000-4000-8000-000000000012";
    const jobId = "00000000-0000-4000-8000-000000000013";
    const messageId = "00000000-0000-4000-8000-000000000014";
    const patientId = "00000000-0000-4000-8000-000000000016";
    const searchArguments = {
      siteId: "00000000-0000-4000-8000-000000000021",
      professionalId: "00000000-0000-4000-8000-000000000022",
      payerId: "00000000-0000-4000-8000-000000000024",
      appointmentTypeId: "00000000-0000-4000-8000-000000000023",
      from: "2026-07-13T05:00:00.000Z",
      days: 1
    };
    const slot = {
      ...searchArguments,
      siteName: "Sede Principal Sotomayor",
      professionalName: "Agenda piloto PULSO IRIS",
      payerName: "Particular",
      appointmentTypeName: "Consulta optometria",
      startsAt: "2026-07-13T14:00:00.000Z",
      scheduledAt: "2026-07-13T14:00:00.000Z",
      localDate: "2026-07-13",
      localTime: "09:00",
      timeZone: "America/Bogota"
    };
    let persistedResponse = "";
    const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
      if (sql.includes("claim_next_job")) {
        return dbResult([
          {
            id: jobId,
            tenantId,
            conversationId,
            inboundEventId: "00000000-0000-4000-8000-000000000015",
            attemptCount: 1,
            maxAttempts: 4,
            input: {
              patientId,
              messageId,
              threadBindingId: "00000000-0000-4000-8000-000000000017",
              occurredAt: new Date().toISOString()
            }
          }
        ]);
      }
      if (sql.includes("select m.body")) {
        return dbResult([
          { body: "Quiero reagendar mi cita al 13 de julio de 2026 a las 9:00 a. m.", conversationStatus: "active" }
        ]);
      }
      if (sql.includes("select sender, body from")) {
        return dbResult([
          { sender: "patient", body: "Quiero reagendar mi cita al 13 de julio de 2026 a las 9:00 a. m." }
        ]);
      }
      if (sql.includes("coalesce(metadata->'sofiaState'")) {
        return dbResult([
          {
            sofiaState: {
              agendaSelection: {
                siteId: searchArguments.siteId,
                professionalId: searchArguments.professionalId,
                payerId: searchArguments.payerId,
                appointmentTypeId: searchArguments.appointmentTypeId
              }
            }
          }
        ]);
      }
      if (sql.includes("select full_name")) return dbResult([{ fullName: "Paciente controlado" }]);
      if (sql.includes("insert into agent_runtime.executions")) {
        return dbResult([{ id: "00000000-0000-4000-8000-000000000018" }]);
      }
      if (sql.includes("insert into pulso_iris.messages")) {
        persistedResponse = String(parameters?.[2] ?? "");
        return dbResult([{ id: "00000000-0000-4000-8000-000000000019" }]);
      }
      return dbResult([]);
    });
    const db = {
      query,
      transaction: vi.fn(async (callback: (tx: { query: typeof query }) => Promise<unknown>) => callback({ query })),
      close: vi.fn()
    } as unknown as DatabaseClient;
    const searchToolCall = (id: string) => ({
      content: null,
      toolCalls: [{ id, name: "search_availability", arguments: JSON.stringify(searchArguments) }],
      model: "controlled",
      latencyMs: 1
    });
    const complete = vi
      .fn()
      .mockResolvedValueOnce(searchToolCall("initial-search"))
      .mockResolvedValueOnce(searchToolCall("refined-search"))
      .mockResolvedValueOnce({ content: "Usa el primer resultado.", toolCalls: [], model: "controlled", latencyMs: 1 });
    let searchCalls = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("prompt-flows/SOFIA/active")) {
        return jsonResponse({
          id: "00000000-0000-4000-8000-000000000020",
          version: 4,
          systemPrompt: "Prompt administrativo controlado para las pruebas de SOFIA."
        });
      }
      if (target.includes("/sofia/tools/get_catalog")) {
        return jsonResponse({
          sites: [{ id: searchArguments.siteId, name: slot.siteName }],
          professionals: [{ id: searchArguments.professionalId, name: slot.professionalName }],
          payers: [{ id: searchArguments.payerId, name: slot.payerName }],
          appointmentTypes: [{ id: searchArguments.appointmentTypeId, name: slot.appointmentTypeName }]
        });
      }
      if (target.includes("/sofia/tools/search_availability")) {
        searchCalls += 1;
        if (searchCalls === 1) return jsonResponse({ slots: [slot] });
        return new Response(JSON.stringify({ data: { code: "availability_unavailable" } }), {
          status: 503,
          headers: { "content-type": "application/json" }
        });
      }
      if (target.includes("/sofia/tools/list_patient_appointments")) {
        return jsonResponse({
          appointments: [
            {
              id: "00000000-0000-4000-8000-000000000026",
              status: "verified",
              scheduledAt: "2000-01-01T14:00:00.000Z"
            }
          ]
        });
      }
      return jsonResponse({ accepted: true });
    });
    const runtime = new SofiaRuntime({
      db,
      logger: { warn: vi.fn() },
      llm: { name: "controlled", model: "controlled", isConfigured: () => true, complete },
      internalServiceToken: "controlled-token",
      channelUrl: "http://channel.test",
      promptFlowUrl: "http://prompt.test",
      pulsoIrisUrl: "http://pulso.test",
      auditUrl: "http://audit.test",
      fetchImpl: fetchImpl as typeof fetch
    });

    await expect(runtime.processOne()).resolves.toBe(true);

    expect(searchCalls).toBe(1);
    expect(persistedResponse).toContain("No encontré una cita activa");
    expect(persistedResponse).not.toContain("9:00");
  });
});

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
}

function dbResult<T>(rows: T[]) {
  return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
}
