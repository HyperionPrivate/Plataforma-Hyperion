import { createHmac } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthenticationState } from "@whiskeysockets/baileys";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BaileysWhatsAppWebTestProvider, type BaileysRuntime, type WhatsAppSocket } from "./baileys-provider.js";
import type { WhatsAppProviderConfig } from "./provider-config.js";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const ALLOWED = "573001234567";
const ADDRESS = `${ALLOWED}@s.whatsapp.net`;
const HASH_KEY = "test-only-phone-hash-key-at-least-32-characters";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("BaileysWhatsAppWebTestProvider", () => {
  it("keeps QR in memory and never enables itself without explicit configuration", async () => {
    const { runtime, socket, createSocket } = createFakeRuntime(false);
    const disabled = new BaileysWhatsAppWebTestProvider(await config({ enabled: false }), runtime);
    await expect(disabled.connect(TENANT_ID)).rejects.toMatchObject({
      name: "WhatsAppProviderDisabledError"
    });

    const provider = new BaileysWhatsAppWebTestProvider(await config(), runtime);
    await provider.connect(TENANT_ID);
    await socket.emit("connection.update", { qr: "sensitive-qr-payload" });

    expect(provider.status(TENANT_ID)).toMatchObject({ state: "qr_pending" });
    expect(provider.qr(TENANT_ID)).toMatchObject({ qr: "sensitive-qr-payload" });
    await provider.connect(TENANT_ID);
    expect(createSocket).toHaveBeenCalledTimes(1);
    await provider.close();
  });

  it("accepts only authorized individual plain-text notifications", async () => {
    const { runtime, socket } = createFakeRuntime(false);
    const provider = new BaileysWhatsAppWebTestProvider(await config(), runtime);
    const inbound = vi.fn(async (_message: import("./types.js").WhatsAppInboundText) => undefined);
    provider.setInboundHandler(inbound);
    await provider.connect(TENANT_ID);

    await socket.emit("messages.upsert", messageEvent(ADDRESS, "authorized", "hello"));
    await socket.emit("messages.upsert", messageEvent("573009999999@s.whatsapp.net", "unauthorized", "hello"));
    await socket.emit("messages.upsert", messageEvent("123@g.us", "group", "hello"));
    await socket.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "media", remoteJid: ADDRESS, fromMe: false },
          message: { imageMessage: { caption: "ignored" } }
        }
      ]
    });
    await socket.emit("messages.upsert", {
      ...messageEvent(ADDRESS, "history", "old"),
      type: "append"
    });
    await socket.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "mixed-content", remoteJid: ADDRESS, fromMe: false },
          message: { conversation: "ignored", imageMessage: { caption: "ignored" } }
        }
      ]
    });

    expect(inbound).toHaveBeenCalledTimes(1);
    expect(inbound.mock.calls[0]?.[0]).toMatchObject({
      tenantId: TENANT_ID,
      externalMessageId: "authorized",
      providerAddress: ADDRESS,
      phoneMasked: expect.stringMatching(/\*+4567/),
      body: "hello"
    });
    expect(inbound.mock.calls[0]?.[0].phoneHash).toMatch(/^[a-f0-9]{64}$/);
    await provider.close();
  });

  it("uses a persisted reverse LID mapping before querying the allowed phone mapping", async () => {
    const { runtime, socket } = createFakeRuntime(false);
    socket.signalRepository.lidMapping.getPNForLID.mockResolvedValue(ADDRESS);
    const provider = new BaileysWhatsAppWebTestProvider(await config(), runtime);
    const inbound = vi.fn(async (_message: import("./types.js").WhatsAppInboundText) => undefined);
    provider.setInboundHandler(inbound);
    await provider.connect(TENANT_ID);

    await socket.emit("messages.upsert", messageEvent("987654321@lid", "reverse-lid", "hello"));

    expect(inbound).toHaveBeenCalledTimes(1);
    expect(socket.signalRepository.lidMapping.getPNForLID).toHaveBeenCalledWith("987654321@lid");
    expect(socket.signalRepository.lidMapping.getLIDForPN).not.toHaveBeenCalled();
    await provider.close();
  });

  it("rejects a LID that maps to a sender outside the allowlist", async () => {
    const { runtime, socket } = createFakeRuntime(false);
    socket.signalRepository.lidMapping.getPNForLID.mockResolvedValue("573009999999@s.whatsapp.net");
    socket.signalRepository.lidMapping.getLIDForPN.mockResolvedValue("111111111@lid");
    const provider = new BaileysWhatsAppWebTestProvider(await config(), runtime);
    const inbound = vi.fn(async (_message: import("./types.js").WhatsAppInboundText) => undefined);
    provider.setInboundHandler(inbound);
    await provider.connect(TENANT_ID);

    await socket.emit("messages.upsert", messageEvent("987654321@lid", "foreign-lid", "ignored"));

    expect(inbound).not.toHaveBeenCalled();
    await provider.close();
  });

  it("authorizes LID conversations through the allowlisted phone mapping and tolerates metadata", async () => {
    const { runtime, socket } = createFakeRuntime(false);
    socket.signalRepository.lidMapping.getLIDForPN.mockResolvedValue("123456789@lid");
    const provider = new BaileysWhatsAppWebTestProvider(await config(), runtime);
    const inbound = vi.fn(async (_message: import("./types.js").WhatsAppInboundText) => undefined);
    provider.setInboundHandler(inbound);
    await provider.connect(TENANT_ID);

    await socket.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "lid-text", remoteJid: "123456789@lid", fromMe: false },
          message: {
            conversation: "hello",
            messageContextInfo: { deviceListMetadataVersion: 2 }
          }
        }
      ]
    });

    expect(inbound).toHaveBeenCalledTimes(1);
    expect(inbound.mock.calls[0]?.[0]).toMatchObject({
      externalMessageId: "lid-text",
      providerAddress: "123456789@lid",
      phoneHash: providerHash(ALLOWED),
      body: "hello"
    });
    expect(socket.signalRepository.lidMapping.getLIDForPN).toHaveBeenCalledWith(ADDRESS);
    await provider.close();
  });

  it("reports ignored input using bounded metadata without bodies or phone numbers", async () => {
    const { runtime, socket } = createFakeRuntime(false);
    const ignored = vi.fn();
    const provider = new BaileysWhatsAppWebTestProvider(await config(), runtime, ignored);
    await provider.connect(TENANT_ID);

    await socket.emit("messages.upsert", messageEvent("573009999999@s.whatsapp.net", "unauthorized", "private"));

    expect(ignored).toHaveBeenCalledWith("unauthorized_sender", {
      addressKind: "pn",
      hasPhoneAlternate: false,
      lidResolverAvailable: true
    });
    const serialized = JSON.stringify(ignored.mock.calls);
    expect(serialized).not.toContain("573009999999");
    expect(serialized).not.toContain("private");
    await provider.close();
  });

  it("applies a bounded rate limit per conversation", async () => {
    const { runtime, socket } = createFakeRuntime(false);
    const provider = new BaileysWhatsAppWebTestProvider(await config({ rateLimitMessages: 2 }), runtime);
    const inbound = vi.fn(async (_message: import("./types.js").WhatsAppInboundText) => undefined);
    provider.setInboundHandler(inbound);
    await provider.connect(TENANT_ID);

    await socket.emit("messages.upsert", messageEvent(ADDRESS, "one", "1"));
    await socket.emit("messages.upsert", messageEvent(ADDRESS, "two", "2"));
    await socket.emit("messages.upsert", messageEvent(ADDRESS, "three", "3"));

    expect(inbound).toHaveBeenCalledTimes(2);
    await provider.close();
  });

  it("retries inbound persistence with the same provider event and preserves a valid ready state", async () => {
    const { runtime, socket } = createFakeRuntime(true);
    const provider = new BaileysWhatsAppWebTestProvider(
      await config({ inboundPersistenceMaxAttempts: 3, inboundPersistenceRetryBaseDelayMs: 0 }),
      runtime
    );
    const inbound = vi
      .fn(async (_message: import("./types.js").WhatsAppInboundText) => undefined)
      .mockRejectedValueOnce(new Error("temporary persistence failure"));
    provider.setInboundHandler(inbound);
    await provider.connect(TENANT_ID);
    await socket.emit("connection.update", { connection: "open" });

    await socket.emit("messages.upsert", messageEvent(ADDRESS, "retry-same-event", "hello"));

    expect(inbound).toHaveBeenCalledTimes(2);
    expect(inbound.mock.calls[0]?.[0]).toBe(inbound.mock.calls[1]?.[0]);
    expect(inbound.mock.calls.map(([message]) => message.externalMessageId)).toEqual([
      "retry-same-event",
      "retry-same-event"
    ]);
    expect(provider.status(TENANT_ID)).toMatchObject({ state: "ready", lastError: undefined });
    expect(socket.end).not.toHaveBeenCalled();
    await provider.close();
  });

  it("degrades explicitly when the durable spool cannot retain an accepted inbound", async () => {
    const { runtime, socket } = createFakeRuntime(true);
    const provider = new BaileysWhatsAppWebTestProvider(
      await config({
        inboundPersistenceMaxAttempts: 1,
        inboundPersistenceRetryBaseDelayMs: 60_000,
        inboundSpoolMaxBytes: 64
      }),
      runtime
    );
    const inbound = vi.fn(async (_message: import("./types.js").WhatsAppInboundText) => undefined);
    provider.setInboundHandler(inbound);
    await provider.connect(TENANT_ID);
    await socket.emit("connection.update", { connection: "open" });

    await socket.emit("messages.upsert", messageEvent(ADDRESS, "spool-capacity-event", "private body"));

    expect(inbound).toHaveBeenCalledTimes(1);
    expect(socket.end).toHaveBeenCalledWith(expect.objectContaining({ message: "inbound_spool_unavailable" }));
    expect(provider.status(TENANT_ID)).toMatchObject({
      state: "degraded",
      lastError: "inbound_spool_unavailable"
    });
    await provider.close();
  });

  it("retains an exhausted inbound and reconnects only after PostgreSQL recovery", async () => {
    const { runtime, createSocket } = createFakeRuntime(true);
    const failedSocket = createFakeSocket();
    const replacementSocket = createFakeSocket();
    createSocket.mockReset();
    createSocket
      .mockReturnValueOnce(failedSocket as unknown as WhatsAppSocket)
      .mockReturnValueOnce(replacementSocket as unknown as WhatsAppSocket);
    const provider = new BaileysWhatsAppWebTestProvider(
      await config({
        inboundPersistenceMaxAttempts: 1,
        inboundPersistenceRetryBaseDelayMs: 25,
        reconnectBaseDelayMs: 25
      }),
      runtime
    );
    let storageAvailable = false;
    const inbound = vi.fn(async (_message: import("./types.js").WhatsAppInboundText) => {
      if (!storageAvailable) throw new Error("persistent storage failure");
    });
    provider.setInboundHandler(inbound);
    provider.setDeliveryHandler(async () => false);
    await provider.connect(TENANT_ID);
    await failedSocket.emit("connection.update", { connection: "open" });

    await failedSocket.emit("messages.update", [
      { key: { id: "unmatched-receipt-during-inbound-outage", fromMe: true }, update: { status: 3 } }
    ]);
    await failedSocket.emit("messages.upsert", messageEvent(ADDRESS, "exhausted-event", "hello"));

    expect(inbound).toHaveBeenCalledTimes(1);
    expect(inbound.mock.calls.every(([message]) => message.externalMessageId === "exhausted-event")).toBe(true);
    expect(failedSocket.end).toHaveBeenCalledWith(expect.objectContaining({ message: "inbound_persistence_failed" }));
    expect(provider.status(TENANT_ID)).toMatchObject({
      state: "degraded",
      lastError: "inbound_persistence_failed"
    });
    expect(createSocket).toHaveBeenCalledTimes(1);

    storageAvailable = true;
    await vi.waitFor(() => expect(createSocket).toHaveBeenCalledTimes(2));
    expect(inbound).toHaveBeenCalledTimes(2);
    expect(inbound.mock.calls.map(([message]) => message.externalMessageId)).toEqual([
      "exhausted-event",
      "exhausted-event"
    ]);
    expect(provider.status(TENANT_ID).state).toBe("connecting");
    await replacementSocket.emit("connection.update", { connection: "open" });
    expect(provider.status(TENANT_ID)).toMatchObject({ state: "ready", lastError: undefined });
    await provider.close();
  });

  it("recovers every retained batch message after a process restart without provider redelivery", async () => {
    const sharedConfig = await config({
      inboundPersistenceMaxAttempts: 1,
      inboundPersistenceRetryBaseDelayMs: 60_000
    });
    const firstRuntime = createFakeRuntime(true);
    const firstProvider = new BaileysWhatsAppWebTestProvider(sharedConfig, firstRuntime.runtime);
    firstProvider.setInboundHandler(async () => {
      throw new Error("database unavailable");
    });
    await firstProvider.connect(TENANT_ID);
    await firstRuntime.socket.emit("connection.update", { connection: "open" });

    const first = messageEvent(ADDRESS, "restart-event-1", "private first body").messages[0]!;
    const second = messageEvent(ADDRESS, "restart-event-2", "private second body").messages[0]!;
    await firstRuntime.socket.emit("messages.upsert", { type: "notify", messages: [first, second] });
    expect(firstProvider.status(TENANT_ID)).toMatchObject({
      state: "degraded",
      lastError: "inbound_persistence_failed"
    });
    await firstProvider.close();

    const persistedBytes = (await readFilesRecursively(join(sharedConfig.sessionRoot, ".channel-event-spool"))).join(
      "\n"
    );
    expect(persistedBytes).not.toContain("private first body");
    expect(persistedBytes).not.toContain("private second body");
    expect(persistedBytes).not.toContain("restart-event-1");
    expect(persistedBytes).not.toContain(ALLOWED);

    const secondRuntime = createFakeRuntime(true);
    const recovered: import("./types.js").WhatsAppInboundText[] = [];
    const secondProvider = new BaileysWhatsAppWebTestProvider(sharedConfig, secondRuntime.runtime);
    secondProvider.setInboundHandler(async (message) => {
      recovered.push(message);
    });
    await secondProvider.connect(TENANT_ID);

    expect(recovered.map((message) => message.externalMessageId).sort()).toEqual([
      "restart-event-1",
      "restart-event-2"
    ]);
    expect(secondRuntime.createSocket).toHaveBeenCalledTimes(1);
    expect(secondProvider.status(TENANT_ID).state).toBe("connecting");
    await secondProvider.close();
  });

  it("recovers a delivery receipt that PostgreSQL could not project before restart", async () => {
    const sharedConfig = await config({
      inboundPersistenceMaxAttempts: 1,
      inboundPersistenceRetryBaseDelayMs: 60_000
    });
    const firstRuntime = createFakeRuntime(true);
    const firstProvider = new BaileysWhatsAppWebTestProvider(sharedConfig, firstRuntime.runtime);
    const failingDelivery = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    firstProvider.setDeliveryHandler(failingDelivery);
    await firstProvider.connect(TENANT_ID);
    await firstRuntime.socket.emit("connection.update", { connection: "open" });

    await firstRuntime.socket.emit("messages.update", [
      { key: { id: "provider-receipt-after-restart", fromMe: true }, update: { status: 3 } }
    ]);
    expect(failingDelivery).toHaveBeenCalledTimes(1);
    await firstProvider.close();

    const secondRuntime = createFakeRuntime(true);
    const recoveredDelivery = vi.fn(async (_update: import("./types.js").WhatsAppDeliveryUpdate) => true);
    const secondProvider = new BaileysWhatsAppWebTestProvider(sharedConfig, secondRuntime.runtime);
    secondProvider.setDeliveryHandler(recoveredDelivery);
    await secondProvider.connect(TENANT_ID);

    expect(recoveredDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ providerMessageId: "provider-receipt-after-restart", status: "delivered" })
    );
    await secondProvider.close();
  });

  it("keeps an unmatched delivery receipt until its outbound correlation exists", async () => {
    const { runtime, socket } = createFakeRuntime(true);
    const provider = new BaileysWhatsAppWebTestProvider(
      await config({
        inboundPersistenceMaxAttempts: 1,
        inboundPersistenceRetryBaseDelayMs: 10,
        inboundPersistenceAttemptTimeoutMs: 100
      }),
      runtime
    );
    const delivery = vi.fn(async () => delivery.mock.calls.length > 1);
    provider.setDeliveryHandler(delivery);
    await provider.connect(TENANT_ID);
    await socket.emit("connection.update", { connection: "open" });

    await socket.emit("messages.update", [
      { key: { id: "provider-receipt-before-correlation", fromMe: true }, update: { status: 3 } }
    ]);

    await vi.waitFor(() => expect(delivery).toHaveBeenCalledTimes(2));
    expect(provider.status(TENANT_ID)).toMatchObject({ state: "ready", lastError: undefined });
    await provider.close();
  });

  it("does not let a persistently unmatched receipt block a later inbound", async () => {
    const { runtime, socket } = createFakeRuntime(true);
    const provider = new BaileysWhatsAppWebTestProvider(
      await config({
        inboundPersistenceMaxAttempts: 1,
        inboundPersistenceRetryBaseDelayMs: 60_000,
        inboundPersistenceAttemptTimeoutMs: 100
      }),
      runtime
    );
    const delivery = vi.fn(async () => false);
    const inbound = vi.fn(async (_message: import("./types.js").WhatsAppInboundText) => undefined);
    provider.setDeliveryHandler(delivery);
    provider.setInboundHandler(inbound);
    await provider.connect(TENANT_ID);
    await socket.emit("connection.update", { connection: "open" });

    await socket.emit("messages.update", [
      { key: { id: "provider-receipt-without-outbox", fromMe: true }, update: { status: 3 } }
    ]);
    await socket.emit("messages.upsert", messageEvent(ADDRESS, "inbound-after-unknown-receipt", "hello"));

    expect(delivery).toHaveBeenCalled();
    expect(inbound).toHaveBeenCalledTimes(1);
    expect(provider.status(TENANT_ID)).toMatchObject({ state: "ready", lastError: undefined });
    expect(socket.end).not.toHaveBeenCalled();
    await provider.close();
  });

  it("restores registered sessions and sends only when ready", async () => {
    const { runtime, socket, createSocket } = createFakeRuntime(true);
    const provider = new BaileysWhatsAppWebTestProvider(await config(), runtime);
    await provider.restore([TENANT_ID, TENANT_ID]);

    expect(createSocket).toHaveBeenCalledTimes(1);
    expect(provider.status(TENANT_ID).sessionRestorable).toBe(true);
    await expect(
      provider.sendText({
        tenantId: TENANT_ID,
        providerAddress: ADDRESS,
        phoneHash: providerHash(ALLOWED),
        body: "reply"
      })
    ).rejects.toMatchObject({ name: "WhatsAppProviderNotReadyError" });

    await socket.emit("connection.update", { connection: "open" });
    expect(socket.signalRepository.lidMapping.getLIDForPN).toHaveBeenCalledWith(ADDRESS);
    const sent = await provider.sendText({
      tenantId: TENANT_ID,
      providerAddress: ADDRESS,
      phoneHash: providerHash(ALLOWED),
      body: "reply"
    });
    expect(sent.providerMessageId).toBe("provider-message-1");
    expect(socket.sendMessage).toHaveBeenCalledWith(ADDRESS, { text: "reply" });
    await expect(
      provider.sendText({
        tenantId: TENANT_ID,
        providerAddress: "573009999999@s.whatsapp.net",
        phoneHash: providerHash("573009999999"),
        body: "must not send"
      })
    ).rejects.toThrow("Unauthorized WhatsApp destination");
    expect(socket.sendMessage).toHaveBeenCalledTimes(1);
    await provider.close();
  });

  it("recognizes a durable QR session and never downgrades it after open", async () => {
    const { runtime, socket } = createFakeRuntime(false, true);
    const provider = new BaileysWhatsAppWebTestProvider(await config(), runtime);
    const status = vi.fn(
      async (_tenantId: string, _status: import("./types.js").WhatsAppConnectionStatus) => undefined
    );
    provider.setStatusHandler(status);
    await provider.connect(TENANT_ID);
    expect(provider.status(TENANT_ID).sessionRestorable).toBe(true);

    await socket.emit("connection.update", { connection: "open" });
    expect(provider.status(TENANT_ID).sessionRestorable).toBe(true);

    await socket.emit("creds.update", {});
    expect(provider.status(TENANT_ID).sessionRestorable).toBe(true);
    expect(status.mock.calls.at(-1)?.[1]).toMatchObject({ state: "ready", sessionRestorable: true });
    await provider.close();
  });

  it("invalidates durable session state on operator disconnect", async () => {
    const { runtime, socket } = createFakeRuntime(true);
    const provider = new BaileysWhatsAppWebTestProvider(await config(), runtime);
    await provider.connect(TENANT_ID);
    await socket.emit("connection.update", { connection: "open" });

    await provider.disconnect(TENANT_ID);

    expect(socket.logout).toHaveBeenCalledTimes(1);
    expect(provider.status(TENANT_ID)).toMatchObject({
      state: "disconnected",
      sessionRestorable: false
    });
    await socket.emit("creds.update", {});
    expect(provider.status(TENANT_ID)).toMatchObject({
      state: "disconnected",
      sessionRestorable: false
    });
    await provider.close();
  });

  it("does not attach a socket whose auth load completed after disconnect", async () => {
    const { runtime, createSocket } = createFakeRuntime(true);
    const authState = await runtime.loadAuthState("unused");
    let releaseAuth!: () => void;
    const delayedAuth = new Promise<typeof authState>((resolveAuth) => {
      releaseAuth = () => resolveAuth(authState);
    });
    runtime.loadAuthState = vi.fn(async () => delayedAuth);
    const provider = new BaileysWhatsAppWebTestProvider(await config(), runtime);

    const connecting = provider.connect(TENANT_ID);
    await vi.waitFor(() => expect(runtime.loadAuthState).toHaveBeenCalledTimes(1));
    await provider.disconnect(TENANT_ID);
    releaseAuth();
    await connecting;

    expect(createSocket).not.toHaveBeenCalled();
    expect(provider.status(TENANT_ID)).toMatchObject({ state: "disconnected", sessionRestorable: false });
    await provider.close();
  });

  it("allows a fresh connect while an invalidated auth load is still settling", async () => {
    const { runtime, createSocket } = createFakeRuntime(true);
    const authState = await runtime.loadAuthState("unused");
    let releaseOldAuth!: () => void;
    const oldAuth = new Promise<typeof authState>((resolveAuth) => {
      releaseOldAuth = () => resolveAuth(authState);
    });
    runtime.loadAuthState = vi
      .fn()
      .mockImplementationOnce(async () => oldAuth)
      .mockResolvedValue(authState);
    const provider = new BaileysWhatsAppWebTestProvider(await config(), runtime);

    const staleConnect = provider.connect(TENANT_ID);
    await vi.waitFor(() => expect(runtime.loadAuthState).toHaveBeenCalledTimes(1));
    await provider.disconnect(TENANT_ID);
    const freshConnect = provider.connect(TENANT_ID);
    await vi.waitFor(() => expect(runtime.loadAuthState).toHaveBeenCalledTimes(2));
    await freshConnect;
    releaseOldAuth();
    await staleConnect;

    expect(createSocket).toHaveBeenCalledTimes(1);
    expect(provider.status(TENANT_ID).state).toBe("connecting");
    await provider.close();
  });

  it("serializes concurrent connect attempts into one socket", async () => {
    const { runtime, createSocket } = createFakeRuntime(true);
    const authState = await runtime.loadAuthState("unused");
    let releaseAuth!: () => void;
    runtime.loadAuthState = vi.fn(
      async () =>
        new Promise<typeof authState>((resolveAuth) => {
          releaseAuth = () => resolveAuth(authState);
        })
    );
    const provider = new BaileysWhatsAppWebTestProvider(await config(), runtime);

    const first = provider.connect(TENANT_ID);
    const second = provider.connect(TENANT_ID);
    expect(second).toBe(first);
    await vi.waitFor(() => expect(runtime.loadAuthState).toHaveBeenCalledTimes(1));
    releaseAuth();
    await Promise.all([first, second]);

    expect(createSocket).toHaveBeenCalledTimes(1);
    await provider.close();
  });

  it("degrades a retained inbound when a persistence attempt never settles", async () => {
    const { runtime, socket } = createFakeRuntime(true);
    const provider = new BaileysWhatsAppWebTestProvider(
      await config({
        inboundPersistenceMaxAttempts: 1,
        inboundPersistenceRetryBaseDelayMs: 60_000,
        inboundPersistenceAttemptTimeoutMs: 20
      }),
      runtime
    );
    provider.setInboundHandler(async () => new Promise<void>(() => undefined));
    await provider.connect(TENANT_ID);
    await socket.emit("connection.update", { connection: "open" });

    await socket.emit("messages.upsert", messageEvent(ADDRESS, "blocked-persistence-event", "hello"));

    expect(socket.end).toHaveBeenCalledWith(expect.objectContaining({ message: "inbound_persistence_failed" }));
    expect(provider.status(TENANT_ID)).toMatchObject({
      state: "degraded",
      lastError: "inbound_persistence_failed"
    });
    await provider.close();
  });

  it("serializes status projections so disconnect cannot be overwritten by stale ready", async () => {
    const { runtime, socket } = createFakeRuntime(true);
    const provider = new BaileysWhatsAppWebTestProvider(await config(), runtime);
    let releaseReady!: () => void;
    const projected: string[] = [];
    provider.setStatusHandler(async (_tenantId, status) => {
      if (status.state === "ready") {
        await new Promise<void>((resolveReady) => {
          releaseReady = resolveReady;
        });
      }
      projected.push(status.state);
    });
    await provider.connect(TENANT_ID);

    const opening = socket.emit("connection.update", { connection: "open" });
    await vi.waitFor(() => expect(releaseReady).toBeTypeOf("function"));
    const disconnecting = provider.disconnect(TENANT_ID);
    releaseReady();
    await Promise.all([opening, disconnecting]);

    expect(projected.at(-1)).toBe("disconnected");
    expect(provider.status(TENANT_ID).state).toBe("disconnected");
    await provider.close();
  });

  it("waits for an in-flight accepted callback to reach durable capture during controlled close", async () => {
    const { runtime, socket } = createFakeRuntime(true);
    let releaseMapping!: () => void;
    socket.signalRepository.lidMapping.getPNForLID.mockImplementation(
      async () =>
        new Promise<string>((resolveMapping) => {
          releaseMapping = () => resolveMapping(ADDRESS);
        })
    );
    const provider = new BaileysWhatsAppWebTestProvider(await config(), runtime);
    const inbound = vi.fn(async (_message: import("./types.js").WhatsAppInboundText) => undefined);
    provider.setInboundHandler(inbound);
    await provider.connect(TENANT_ID);

    const receiving = socket.emit("messages.upsert", messageEvent("987654321@lid", "close-capture-event", "hello"));
    await vi.waitFor(() => expect(socket.signalRepository.lidMapping.getPNForLID).toHaveBeenCalledTimes(1));
    let closeCompleted = false;
    const closing = provider.close().then(() => {
      closeCompleted = true;
    });
    await Promise.resolve();
    expect(closeCompleted).toBe(false);

    releaseMapping();
    await closing;
    await receiving;
    expect(inbound).toHaveBeenCalledTimes(1);
  });
});

async function config(override: Partial<WhatsAppProviderConfig> = {}): Promise<WhatsAppProviderConfig> {
  const sessionRoot = await mkdtemp(join(tmpdir(), "hyperion-whatsapp-test-"));
  temporaryDirectories.push(sessionRoot);
  return {
    enabled: true,
    allowedNumbers: new Set([ALLOWED]),
    phoneHashKey: HASH_KEY,
    sessionRoot,
    maxMessageLength: 2_000,
    rateLimitMessages: 12,
    rateLimitWindowMs: 60_000,
    qrTtlMs: 60_000,
    inboundPersistenceMaxAttempts: 3,
    inboundPersistenceRetryBaseDelayMs: 1,
    inboundPersistenceAttemptTimeoutMs: 10_000,
    inboundSpoolMaxRecords: 2_000,
    inboundSpoolMaxBytes: 16_777_216,
    maxReconnectAttempts: 2,
    reconnectBaseDelayMs: 10,
    ...override
  };
}

function providerHash(number: string): string {
  return createHmac("sha256", HASH_KEY).update(number).digest("hex");
}

function messageEvent(address: string, id: string, text: string) {
  return {
    type: "notify",
    messages: [
      {
        key: { id, remoteJid: address, fromMe: false },
        message: { conversation: text },
        messageTimestamp: 1_750_000_000
      }
    ]
  };
}

function createFakeRuntime(
  registered: boolean,
  qrLinked = registered
): {
  runtime: BaileysRuntime;
  socket: ReturnType<typeof createFakeSocket>;
  createSocket: ReturnType<typeof vi.fn>;
} {
  const socket = createFakeSocket();
  const createSocket = vi.fn(() => socket as unknown as WhatsAppSocket);
  const runtime: BaileysRuntime = {
    loadAuthState: vi.fn(async () => ({
      state: {
        creds: {
          registered,
          ...(qrLinked ? { me: { id: `${ALLOWED}:1@s.whatsapp.net` }, account: {} } : {})
        },
        keys: { get: async () => ({}), set: async () => undefined }
      } as unknown as AuthenticationState,
      saveCreds: async () => undefined
    })),
    createSocket,
    isLoggedOut: () => false
  };
  return { runtime, socket, createSocket };
}

function createFakeSocket() {
  const handlers = new Map<string, Array<(payload: never) => unknown>>();
  return {
    user: { id: `${ALLOWED}:1@s.whatsapp.net` },
    signalRepository: {
      lidMapping: {
        getLIDForPN: vi.fn(async (_phoneJid: string) => null as string | null),
        getPNForLID: vi.fn(async (_lid: string) => null as string | null)
      }
    },
    ev: {
      on: (event: string, handler: (payload: never) => unknown) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      removeAllListeners: () => handlers.clear()
    },
    sendMessage: vi.fn(async () => ({ key: { id: "provider-message-1" } })),
    logout: vi.fn(async () => undefined),
    end: vi.fn(),
    emit: async (event: string, payload: unknown) => {
      for (const handler of handlers.get(event) ?? []) await handler(payload as never);
    }
  };
}

async function readFilesRecursively(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const contents: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) contents.push(...(await readFilesRecursively(path)));
    if (entry.isFile()) contents.push(await readFile(path, "utf8"));
  }
  return contents;
}
