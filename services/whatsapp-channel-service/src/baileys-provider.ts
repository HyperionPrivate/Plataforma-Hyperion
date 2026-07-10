import { createHmac } from "node:crypto";
import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  type AuthenticationState,
  type WASocket
} from "@whiskeysockets/baileys";
import pino from "pino";
import type { WhatsAppProviderConfig } from "./provider-config.js";
import {
  WHATSAPP_PROVIDER_MODE,
  WhatsAppProviderDisabledError,
  WhatsAppProviderNotReadyError,
  WhatsAppProviderRejectedError,
  type WhatsAppConnectionStatus,
  type WhatsAppDeliveryUpdate,
  type WhatsAppInboundText,
  type WhatsAppOutboundText,
  type WhatsAppProvider,
  type WhatsAppSendResult
} from "./types.js";

type ConnectionUpdate = {
  connection?: "open" | "close" | "connecting";
  qr?: string;
  lastDisconnect?: { error?: unknown };
};

type IncomingMessage = {
  key: {
    id?: string | null;
    remoteJid?: string | null;
    remoteJidAlt?: string | null;
    participant?: string | null;
    participantAlt?: string | null;
    fromMe?: boolean | null;
  };
  message?: {
    conversation?: string | null;
    extendedTextMessage?: { text?: string | null } | null;
    [key: string]: unknown;
  } | null;
  messageTimestamp?: number | bigint | null;
};

type MessageUpsert = { type?: string; messages: IncomingMessage[] };
type MessageUpdate = Array<{
  key: { id?: string | null };
  update: { status?: number | null };
}>;

interface SocketEvents {
  on(event: "connection.update", handler: (update: ConnectionUpdate) => void): void;
  on(event: "creds.update", handler: () => Promise<void>): void;
  on(event: "messages.upsert", handler: (event: MessageUpsert) => Promise<void>): void;
  on(event: "messages.update", handler: (event: MessageUpdate) => Promise<void>): void;
}

export interface WhatsAppSocket {
  ev: SocketEvents;
  user?: { id?: string | null };
  sendMessage(address: string, content: { text: string }): Promise<{ key: { id?: string | null } } | undefined>;
  logout(): Promise<void>;
  end(error?: Error): void;
}

export interface BaileysRuntime {
  loadAuthState(sessionDirectory: string): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }>;
  createSocket(auth: AuthenticationState): WhatsAppSocket;
  isLoggedOut(error: unknown): boolean;
}

interface TenantConnection {
  socket?: WhatsAppSocket;
  status: WhatsAppConnectionStatus;
  qr?: { value: string; expiresAt: number };
  generation: number;
  reconnectAttempts: number;
  reconnectTimer?: NodeJS.Timeout;
}

const silentBaileysLogger = pino({ level: "silent" });

export function createBaileysRuntime(): BaileysRuntime {
  return {
    loadAuthState: useMultiFileAuthState,
    createSocket: (auth) =>
      makeWASocket({
        auth,
        logger: silentBaileysLogger,
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        shouldIgnoreJid: isIgnoredAddress,
        generateHighQualityLinkPreview: false,
        getMessage: async () => undefined
      }) as unknown as WASocket as WhatsAppSocket,
    isLoggedOut: (error) => disconnectStatusCode(error) === DisconnectReason.loggedOut
  };
}

export class BaileysWhatsAppWebTestProvider implements WhatsAppProvider {
  readonly mode = WHATSAPP_PROVIDER_MODE;
  private readonly connections = new Map<string, TenantConnection>();
  private readonly rateWindows = new Map<string, number[]>();
  private readonly allowedPhoneHashes: ReadonlySet<string>;
  private inboundHandler: (message: WhatsAppInboundText) => Promise<void> = async () => undefined;
  private statusHandler: (tenantId: string, status: WhatsAppConnectionStatus) => Promise<void> = async () => undefined;
  private deliveryHandler: (update: WhatsAppDeliveryUpdate) => Promise<void> = async () => undefined;

  constructor(
    private readonly config: WhatsAppProviderConfig,
    private readonly runtime: BaileysRuntime = createBaileysRuntime()
  ) {
    this.allowedPhoneHashes = new Set([...config.allowedNumbers].map((number) => this.hashPhone(number)));
  }

  setInboundHandler(handler: (message: WhatsAppInboundText) => Promise<void>): void {
    this.inboundHandler = handler;
  }

  setStatusHandler(handler: (tenantId: string, status: WhatsAppConnectionStatus) => Promise<void>): void {
    this.statusHandler = handler;
  }

  setDeliveryHandler(handler: (update: WhatsAppDeliveryUpdate) => Promise<void>): void {
    this.deliveryHandler = handler;
  }

  async connect(tenantId: string): Promise<WhatsAppConnectionStatus> {
    this.assertEnabled();
    assertTenantId(tenantId);

    const existing = this.connections.get(tenantId);
    if (existing?.status.state === "ready" || existing?.status.state === "connecting") {
      return this.status(tenantId);
    }
    if (existing?.status.state === "qr_pending" && existing.qr && existing.qr.expiresAt > Date.now()) {
      return this.status(tenantId);
    }

    const connection = existing ?? {
      status: disconnectedStatus(false),
      generation: 0,
      reconnectAttempts: 0
    };
    this.connections.set(tenantId, connection);
    if (existing) this.prepareReplacementSocket(existing);
    try {
      await this.openSocket(tenantId, connection);
    } catch (error) {
      await this.updateStatus(tenantId, {
        ...connection.status,
        state: "degraded",
        lastError: "connect_failed"
      });
      throw error;
    }
    return this.status(tenantId);
  }

  async restore(tenantIds: string[]): Promise<void> {
    if (!this.config.enabled) return;
    for (const tenantId of new Set(tenantIds)) {
      try {
        await this.connect(tenantId);
      } catch {
        await this.updateStatus(tenantId, {
          ...disconnectedStatus(true),
          state: "degraded",
          lastError: "session_restore_failed"
        });
      }
    }
  }

  status(tenantId: string): WhatsAppConnectionStatus {
    const current = this.connections.get(tenantId)?.status ?? disconnectedStatus(false);
    const qr = this.connections.get(tenantId)?.qr;
    const qrExpiresAt = qr && qr.expiresAt > Date.now() ? new Date(qr.expiresAt).toISOString() : undefined;
    return { ...current, qrExpiresAt };
  }

  qr(tenantId: string): { qr: string; expiresAt: string } | undefined {
    const connection = this.connections.get(tenantId);
    if (!connection?.qr) return undefined;
    if (connection.qr.expiresAt <= Date.now()) {
      connection.qr = undefined;
      return undefined;
    }
    return { qr: connection.qr.value, expiresAt: new Date(connection.qr.expiresAt).toISOString() };
  }

  async disconnect(tenantId: string): Promise<void> {
    assertTenantId(tenantId);
    const connection = this.connections.get(tenantId);
    if (connection?.reconnectTimer) clearTimeout(connection.reconnectTimer);
    if (connection) connection.generation += 1;
    if (connection?.socket) {
      try {
        await connection.socket.logout();
      } catch {
        connection.socket.end(new Error("operator_disconnect"));
      }
    }
    if (connection?.reconnectTimer) clearTimeout(connection.reconnectTimer);
    await this.removeSession(tenantId);
    this.connections.set(tenantId, {
      status: disconnectedStatus(false),
      generation: (connection?.generation ?? 0) + 1,
      reconnectAttempts: 0
    });
    await this.emitStatus(tenantId);
  }

  async sendText(message: WhatsAppOutboundText): Promise<WhatsAppSendResult> {
    this.assertEnabled();
    if (!isIndividualAddress(message.providerAddress)) {
      throw new WhatsAppProviderRejectedError("Unsupported WhatsApp destination");
    }
    if (!this.allowedPhoneHashes.has(message.phoneHash)) {
      throw new WhatsAppProviderRejectedError("Unauthorized WhatsApp destination");
    }
    const body = message.body.trim();
    if (!body || body.length > this.config.maxMessageLength) {
      throw new WhatsAppProviderRejectedError("Invalid WhatsApp message length");
    }
    const connection = this.connections.get(message.tenantId);
    if (!connection?.socket || connection.status.state !== "ready") {
      throw new WhatsAppProviderNotReadyError();
    }
    const result = await connection.socket.sendMessage(message.providerAddress, { text: body });
    const providerMessageId = result?.key.id;
    if (!providerMessageId) throw new Error("Provider did not return a message id");
    const sentAt = new Date();
    connection.status = {
      ...connection.status,
      lastActivityAt: sentAt.toISOString(),
      lastError: undefined
    };
    await this.emitStatus(message.tenantId);
    return { providerMessageId, sentAt };
  }

  async close(): Promise<void> {
    for (const connection of this.connections.values()) {
      if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
      connection.socket?.end();
    }
    this.connections.clear();
    this.rateWindows.clear();
  }

  private async openSocket(tenantId: string, connection: TenantConnection): Promise<void> {
    const generation = connection.generation + 1;
    connection.generation = generation;
    connection.qr = undefined;
    await this.updateStatus(tenantId, {
      ...connection.status,
      state: "connecting",
      lastError: undefined
    });

    const sessionDirectory = this.sessionDirectory(tenantId);
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    await chmod(sessionDirectory, 0o700).catch(() => undefined);
    const { state, saveCreds } = await this.runtime.loadAuthState(sessionDirectory);
    const socket = this.runtime.createSocket(state);
    connection.socket = socket;
    connection.status.sessionRestorable = hasRestorableSession(state);
    await this.emitStatus(tenantId);

    socket.ev.on("creds.update", async () => {
      if (connection.generation !== generation) return;
      await saveCreds();
      await protectSessionDirectory(sessionDirectory);
      connection.status.sessionRestorable =
        connection.status.sessionRestorable || connection.status.state === "ready" || hasRestorableSession(state);
      await this.emitStatus(tenantId);
    });
    socket.ev.on("connection.update", (update) => {
      void this.handleConnectionUpdate(tenantId, connection, generation, update);
    });
    socket.ev.on("messages.upsert", async (event) => {
      if (connection.generation !== generation) return;
      await this.handleMessages(tenantId, connection, event);
    });
    socket.ev.on("messages.update", async (event) => {
      if (connection.generation !== generation) return;
      await this.handleDeliveryUpdates(tenantId, event);
    });
  }

  private async handleConnectionUpdate(
    tenantId: string,
    connection: TenantConnection,
    generation: number,
    update: ConnectionUpdate
  ): Promise<void> {
    if (connection.generation !== generation) return;
    if (update.qr) {
      connection.qr = { value: update.qr, expiresAt: Date.now() + this.config.qrTtlMs };
      await this.updateStatus(tenantId, { ...connection.status, state: "qr_pending" });
    }
    if (update.connection === "connecting") {
      await this.updateStatus(tenantId, { ...connection.status, state: "connecting" });
      return;
    }
    if (update.connection === "open") {
      connection.qr = undefined;
      connection.reconnectAttempts = 0;
      await this.updateStatus(tenantId, {
        ...connection.status,
        state: "ready",
        phoneMasked: maskProviderId(connection.socket?.user?.id),
        lastActivityAt: new Date().toISOString(),
        lastError: undefined,
        sessionRestorable: true
      });
      return;
    }
    if (update.connection !== "close") return;

    connection.socket = undefined;
    connection.qr = undefined;
    if (this.runtime.isLoggedOut(update.lastDisconnect?.error)) {
      await this.removeSession(tenantId);
      connection.reconnectAttempts = 0;
      await this.updateStatus(tenantId, {
        ...disconnectedStatus(false),
        lastError: "session_logged_out"
      });
      return;
    }
    await this.updateStatus(tenantId, {
      ...connection.status,
      state: "degraded",
      lastError: "connection_closed"
    });
    this.scheduleReconnect(tenantId, connection);
  }

  private scheduleReconnect(tenantId: string, connection: TenantConnection): void {
    if (connection.reconnectAttempts >= this.config.maxReconnectAttempts || connection.reconnectTimer) return;
    const delay = Math.min(this.config.reconnectBaseDelayMs * 2 ** connection.reconnectAttempts, 60_000);
    connection.reconnectAttempts += 1;
    connection.reconnectTimer = setTimeout(() => {
      connection.reconnectTimer = undefined;
      void this.openSocket(tenantId, connection).catch(async () => {
        await this.updateStatus(tenantId, {
          ...connection.status,
          state: "degraded",
          lastError: "reconnect_failed"
        });
        this.scheduleReconnect(tenantId, connection);
      });
    }, delay);
    connection.reconnectTimer.unref();
  }

  private prepareReplacementSocket(connection: TenantConnection): void {
    if (connection.reconnectTimer) {
      clearTimeout(connection.reconnectTimer);
      connection.reconnectTimer = undefined;
    }
    connection.generation += 1;
    connection.socket?.end(new Error("connection_replaced"));
    connection.socket = undefined;
    connection.qr = undefined;
    connection.reconnectAttempts = 0;
  }

  private async handleMessages(tenantId: string, connection: TenantConnection, event: MessageUpsert): Promise<void> {
    if (event.type !== "notify") return;
    for (const message of event.messages) {
      const accepted = this.parseIncoming(tenantId, message);
      if (!accepted) continue;
      if (!this.takeRateLimit(tenantId, accepted.providerAddress)) continue;
      try {
        await this.inboundHandler(accepted);
        connection.status = {
          ...connection.status,
          lastActivityAt: accepted.receivedAt.toISOString(),
          lastError: undefined
        };
        await this.emitStatus(tenantId);
      } catch {
        await this.updateStatus(tenantId, {
          ...connection.status,
          state: "degraded",
          lastError: "inbound_persistence_failed"
        });
      }
    }
  }

  private parseIncoming(tenantId: string, message: IncomingMessage): WhatsAppInboundText | undefined {
    if (message.key.fromMe) return undefined;
    const providerAddress = message.key.remoteJid ?? undefined;
    if (!providerAddress || !isIndividualAddress(providerAddress)) return undefined;
    const allowedNumber = authorizedNumber(message.key, this.config.allowedNumbers);
    if (!allowedNumber) return undefined;
    const body = extractPlainText(message.message)?.trim();
    if (!body || body.length > this.config.maxMessageLength) return undefined;
    const externalMessageId = message.key.id?.trim();
    if (!externalMessageId) return undefined;
    return {
      tenantId,
      provider: WHATSAPP_PROVIDER_MODE,
      externalMessageId,
      providerAddress,
      phoneHash: this.hashPhone(allowedNumber),
      phoneMasked: maskNumber(allowedNumber),
      body,
      receivedAt: messageTimestamp(message.messageTimestamp)
    };
  }

  private takeRateLimit(tenantId: string, providerAddress: string): boolean {
    const key = `${tenantId}:${providerAddress}`;
    const threshold = Date.now() - this.config.rateLimitWindowMs;
    const current = (this.rateWindows.get(key) ?? []).filter((timestamp) => timestamp > threshold);
    if (current.length >= this.config.rateLimitMessages) {
      this.rateWindows.set(key, current);
      return false;
    }
    current.push(Date.now());
    this.rateWindows.set(key, current);
    return true;
  }

  private async handleDeliveryUpdates(tenantId: string, event: MessageUpdate): Promise<void> {
    for (const item of event) {
      const providerMessageId = item.key.id?.trim();
      const status = deliveryStatus(item.update.status);
      if (!providerMessageId || !status) continue;
      try {
        await this.deliveryHandler({
          tenantId,
          provider: WHATSAPP_PROVIDER_MODE,
          providerMessageId,
          status,
          occurredAt: new Date()
        });
      } catch {
        // Delivery receipts are eventually reconciled from durable outbound state.
      }
    }
  }

  private async updateStatus(tenantId: string, status: WhatsAppConnectionStatus): Promise<void> {
    const connection = this.connections.get(tenantId) ?? {
      status,
      generation: 0,
      reconnectAttempts: 0
    };
    connection.status = status;
    this.connections.set(tenantId, connection);
    await this.emitStatus(tenantId);
  }

  private async emitStatus(tenantId: string): Promise<void> {
    try {
      await this.statusHandler(tenantId, this.status(tenantId));
    } catch {
      // A status projection failure must not expose connection material or stop Baileys.
    }
  }

  private assertEnabled(): void {
    if (!this.config.enabled) throw new WhatsAppProviderDisabledError();
    if (this.config.allowedNumbers.size === 0) throw new WhatsAppProviderDisabledError();
    if (!this.config.phoneHashKey || this.config.phoneHashKey.length < 32) {
      throw new WhatsAppProviderDisabledError();
    }
  }

  private hashPhone(number: string): string {
    return createHmac("sha256", this.config.phoneHashKey ?? "")
      .update(number)
      .digest("hex");
  }

  private sessionDirectory(tenantId: string): string {
    const directory = resolve(this.config.sessionRoot, tenantId);
    const pathFromRoot = relative(resolve(this.config.sessionRoot), directory);
    if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
      throw new Error("Invalid tenant session directory");
    }
    return directory;
  }

  private async removeSession(tenantId: string): Promise<void> {
    await rm(this.sessionDirectory(tenantId), { recursive: true, force: true });
  }
}

function disconnectedStatus(sessionRestorable: boolean): WhatsAppConnectionStatus {
  return {
    providerMode: WHATSAPP_PROVIDER_MODE,
    state: "disconnected",
    sessionRestorable
  };
}

function hasRestorableSession(state: AuthenticationState): boolean {
  return state.creds.registered || Boolean(state.creds.me?.id && state.creds.account);
}

function assertTenantId(tenantId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId)) {
    throw new Error("Invalid tenant id");
  }
}

function disconnectStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const output = (error as { output?: unknown }).output;
  if (!output || typeof output !== "object") return undefined;
  const statusCode = (output as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

function isIgnoredAddress(address: string): boolean {
  return !isIndividualAddress(address);
}

function isIndividualAddress(address: string): boolean {
  return address.endsWith("@s.whatsapp.net") || address.endsWith("@lid");
}

function extractPlainText(message: IncomingMessage["message"]): string | undefined {
  if (!message) return undefined;
  const keys = Object.keys(message).filter((key) => message[key] != null);
  if (keys.length !== 1) return undefined;
  if (keys[0] === "conversation") return message.conversation ?? undefined;
  if (keys[0] === "extendedTextMessage") return message.extendedTextMessage?.text ?? undefined;
  return undefined;
}

function authorizedNumber(key: IncomingMessage["key"], allowedNumbers: ReadonlySet<string>): string | undefined {
  const candidates = [key.remoteJidAlt, key.participantAlt, key.remoteJid, key.participant];
  for (const candidate of candidates) {
    if (!candidate || !candidate.endsWith("@s.whatsapp.net")) continue;
    const number = candidate.slice(0, candidate.indexOf("@")).split(":")[0];
    if (number && allowedNumbers.has(number)) return number;
  }
  return undefined;
}

function maskProviderId(id: string | null | undefined): string | undefined {
  if (!id) return undefined;
  const number = id.slice(0, id.indexOf("@")).split(":")[0];
  return number ? maskNumber(number) : undefined;
}

function maskNumber(number: string): string {
  const visible = number.slice(-4);
  return `${"*".repeat(Math.max(4, Math.min(8, number.length - visible.length)))}${visible}`;
}

function messageTimestamp(value: number | bigint | null | undefined): Date {
  if (typeof value === "bigint") return new Date(Number(value) * 1_000);
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value * 1_000);
  return new Date();
}

function deliveryStatus(value: number | null | undefined): WhatsAppDeliveryUpdate["status"] | undefined {
  if (value === 0) return "failed";
  if (value === 3) return "delivered";
  if (typeof value === "number" && value >= 4) return "read";
  return undefined;
}

async function protectSessionDirectory(directory: string): Promise<void> {
  await chmod(directory, 0o700).catch(() => undefined);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return protectSessionDirectory(path);
      if (entry.isFile()) await chmod(path, 0o600).catch(() => undefined);
    })
  );
}
