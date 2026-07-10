import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
