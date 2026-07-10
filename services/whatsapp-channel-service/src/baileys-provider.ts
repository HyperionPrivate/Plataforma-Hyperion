import { createHmac } from "node:crypto";
import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import makeWASocket, {
  areJidsSameUser,
  DisconnectReason,
  useMultiFileAuthState,
  type AuthenticationState,
  type WASocket
} from "@whiskeysockets/baileys";
import pino from "pino";
import { EncryptedChannelEventSpool, type DurableChannelEvent } from "./durable-event-spool.js";
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
  key: { id?: string | null; fromMe?: boolean | null };
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
  signalRepository?: {
    lidMapping: {
      getLIDForPN(phoneJid: string): Promise<string | null>;
      getPNForLID(lid: string): Promise<string | null>;
    };
  };
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

interface SpoolDrainResult {
  inboundReady: boolean;
  deferredDeliveries: boolean;
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
  private readonly reportedDiagnostics = new Set<string>();
  private readonly spoolDrains = new Map<string, Promise<SpoolDrainResult>>();
  private readonly spoolRetryTimers = new Map<string, NodeJS.Timeout>();
  private readonly spoolRetryAttempts = new Map<string, number>();
  private readonly reconnectAfterSpool = new Set<string>();
  private readonly connectAttempts = new Map<string, Promise<WhatsAppConnectionStatus>>();
  private readonly statusProjectionTails = new Map<string, Promise<void>>();
  private readonly captureBarriers = new Set<Promise<void>>();
  private readonly allowedPhoneHashes: ReadonlySet<string>;
  private eventSpool?: EncryptedChannelEventSpool;
  private inboundHandler: (message: WhatsAppInboundText) => Promise<void> = async () => undefined;
  private statusHandler: (tenantId: string, status: WhatsAppConnectionStatus) => Promise<void> = async () => undefined;
  private deliveryHandler: (update: WhatsAppDeliveryUpdate) => Promise<boolean> = async () => true;

  constructor(
    private readonly config: WhatsAppProviderConfig,
    private readonly runtime: BaileysRuntime = createBaileysRuntime(),
    private readonly reportIgnored: (reason: string, metadata: Record<string, unknown>) => void = () => undefined
  ) {
    this.allowedPhoneHashes = new Set([...config.allowedNumbers].map((number) => this.hashPhone(number)));
  }

  setInboundHandler(handler: (message: WhatsAppInboundText) => Promise<void>): void {
    this.inboundHandler = handler;
  }

  setStatusHandler(handler: (tenantId: string, status: WhatsAppConnectionStatus) => Promise<void>): void {
    this.statusHandler = handler;
  }

  setDeliveryHandler(handler: (update: WhatsAppDeliveryUpdate) => Promise<boolean>): void {
    this.deliveryHandler = handler;
  }

  connect(tenantId: string): Promise<WhatsAppConnectionStatus> {
    try {
      this.assertEnabled();
      assertTenantId(tenantId);
    } catch (error) {
      return Promise.reject(error);
    }
    const pending = this.connectAttempts.get(tenantId);
    if (pending) return pending;

    const attempt = this.connectOnce(tenantId);
    this.connectAttempts.set(tenantId, attempt);
    const clearAttempt = () => {
      if (this.connectAttempts.get(tenantId) === attempt) this.connectAttempts.delete(tenantId);
    };
    void attempt.then(clearAttempt, clearAttempt);
    return attempt;
  }

  private async connectOnce(tenantId: string): Promise<WhatsAppConnectionStatus> {
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
    if (existing) this.prepareReplacementSocket(tenantId, existing);
    try {
      const drain = await this.queueSpoolDrain(tenantId);
      if (this.connections.get(tenantId) !== connection) return this.status(tenantId);
      if (!drain.inboundReady) {
        this.reconnectAfterSpool.add(tenantId);
        await this.updateStatus(tenantId, {
          ...connection.status,
          state: "degraded",
          lastError: "inbound_persistence_failed"
        });
        this.scheduleSpoolRetry(tenantId, connection);
        return this.status(tenantId);
      }
      if (drain.deferredDeliveries) this.scheduleSpoolRetry(tenantId, connection);
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
    this.connectAttempts.delete(tenantId);
    const connection = this.connections.get(tenantId);
    if (connection?.reconnectTimer) clearTimeout(connection.reconnectTimer);
    this.clearSpoolRetry(tenantId);
    this.reconnectAfterSpool.delete(tenantId);
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
    this.connectAttempts.clear();
    for (const [tenantId, connection] of this.connections) {
      if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
      this.clearSpoolRetry(tenantId);
      connection.generation += 1;
      connection.socket?.end();
    }
    this.connections.clear();
    this.rateWindows.clear();
    this.reconnectAfterSpool.clear();
    await withTimeout(Promise.allSettled([...this.captureBarriers]), 5_000).catch(() => undefined);
    await Promise.allSettled(this.statusProjectionTails.values());
  }

  private async openSocket(tenantId: string, connection: TenantConnection): Promise<void> {
    if (this.connections.get(tenantId) !== connection) return;
    this.resetDiagnostics(tenantId);
    const generation = connection.generation + 1;
    connection.generation = generation;
    connection.qr = undefined;
    await this.updateStatus(tenantId, {
      ...connection.status,
      state: "connecting",
      lastError: undefined
    });
    if (!this.isCurrentConnection(tenantId, connection, generation)) return;

    const sessionDirectory = this.sessionDirectory(tenantId);
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    if (!this.isCurrentConnection(tenantId, connection, generation)) return;
    await chmod(sessionDirectory, 0o700).catch(() => undefined);
    if (!this.isCurrentConnection(tenantId, connection, generation)) return;
    const { state, saveCreds } = await this.runtime.loadAuthState(sessionDirectory);
    if (!this.isCurrentConnection(tenantId, connection, generation)) return;
    const socket = this.runtime.createSocket(state);
    if (!this.isCurrentConnection(tenantId, connection, generation)) {
      socket.end(new Error("connection_replaced"));
      return;
    }
    const previousSocket = connection.socket;
    connection.socket = socket;
    if (previousSocket && previousSocket !== socket) previousSocket.end(new Error("connection_replaced"));
    connection.status.sessionRestorable = hasRestorableSession(state);

    socket.ev.on("creds.update", async () => {
      if (!this.isCurrentConnection(tenantId, connection, generation)) return;
      await saveCreds();
      if (!this.isCurrentConnection(tenantId, connection, generation)) return;
      await protectSessionDirectory(sessionDirectory);
      if (!this.isCurrentConnection(tenantId, connection, generation)) return;
      connection.status.sessionRestorable =
        connection.status.sessionRestorable || connection.status.state === "ready" || hasRestorableSession(state);
      await this.emitStatus(tenantId);
    });
    socket.ev.on("connection.update", (update) => {
      void this.handleConnectionUpdate(tenantId, connection, generation, update);
    });
    socket.ev.on("messages.upsert", (event) => {
      if (!this.isCurrentConnection(tenantId, connection, generation)) return Promise.resolve();
      return this.trackDurableCapture((captureComplete) =>
        this.handleMessages(tenantId, connection, generation, event, captureComplete)
      );
    });
    socket.ev.on("messages.update", (event) => {
      if (!this.isCurrentConnection(tenantId, connection, generation)) return Promise.resolve();
      return this.trackDurableCapture((captureComplete) =>
        this.handleDeliveryUpdates(tenantId, event, captureComplete)
      );
    });
    await this.emitStatus(tenantId);
  }

  private async handleConnectionUpdate(
    tenantId: string,
    connection: TenantConnection,
    generation: number,
    update: ConnectionUpdate
  ): Promise<void> {
    if (!this.isCurrentConnection(tenantId, connection, generation)) return;
    if (update.qr) {
      connection.qr = { value: update.qr, expiresAt: Date.now() + this.config.qrTtlMs };
      await this.updateStatus(tenantId, { ...connection.status, state: "qr_pending" });
      if (!this.isCurrentConnection(tenantId, connection, generation)) return;
    }
    if (update.connection === "connecting") {
      await this.updateStatus(tenantId, { ...connection.status, state: "connecting" });
      return;
    }
    if (update.connection === "open") {
      connection.qr = undefined;
      connection.reconnectAttempts = 0;
      this.prewarmAllowedLidMappings(connection);
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
      if (!this.isCurrentConnection(tenantId, connection, generation)) return;
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
    if (!this.isCurrentConnection(tenantId, connection, generation)) return;
    this.scheduleReconnect(tenantId, connection);
  }

  private scheduleReconnect(tenantId: string, connection: TenantConnection): void {
    if (connection.reconnectAttempts >= this.config.maxReconnectAttempts || connection.reconnectTimer) return;
    const delay = Math.min(this.config.reconnectBaseDelayMs * 2 ** connection.reconnectAttempts, 60_000);
    connection.reconnectAttempts += 1;
    connection.reconnectTimer = setTimeout(() => {
      connection.reconnectTimer = undefined;
      if (this.connections.get(tenantId) !== connection) return;
      void this.openSocket(tenantId, connection).catch(async () => {
        if (this.connections.get(tenantId) !== connection) return;
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

  private prewarmAllowedLidMappings(connection: TenantConnection): void {
    const lidMapping = connection.socket?.signalRepository?.lidMapping;
    if (!lidMapping) return;
    for (const allowedNumber of this.config.allowedNumbers) {
      void lidMapping.getLIDForPN(`${allowedNumber}@s.whatsapp.net`).catch(() => undefined);
    }
  }

  private prepareReplacementSocket(tenantId: string, connection: TenantConnection): void {
    if (connection.reconnectTimer) {
      clearTimeout(connection.reconnectTimer);
      connection.reconnectTimer = undefined;
    }
    this.clearSpoolRetry(tenantId);
    this.reconnectAfterSpool.delete(tenantId);
    connection.generation += 1;
    connection.socket?.end(new Error("connection_replaced"));
    connection.socket = undefined;
    connection.qr = undefined;
    connection.reconnectAttempts = 0;
  }

  private isCurrentConnection(tenantId: string, connection: TenantConnection, generation: number): boolean {
    return this.connections.get(tenantId) === connection && connection.generation === generation;
  }

  private async handleMessages(
    tenantId: string,
    connection: TenantConnection,
    generation: number,
    event: MessageUpsert,
    captureComplete: () => void
  ): Promise<void> {
    if (event.type !== "notify") {
      this.reportIgnoredOnce(tenantId, "unsupported_event_type", {
        eventType: safeEventType(event.type)
      });
      captureComplete();
      return;
    }
    const acceptedMessages: WhatsAppInboundText[] = [];
    for (const message of event.messages) {
      const accepted = await this.parseIncoming(tenantId, connection, message);
      if (!accepted) continue;
      if (!this.takeRateLimit(tenantId, accepted.providerAddress)) {
        this.reportIgnoredOnce(tenantId, "conversation_rate_limited", {});
        continue;
      }
      acceptedMessages.push(accepted);
    }
    if (acceptedMessages.length === 0) {
      captureComplete();
      return;
    }

    let retained = true;
    try {
      await this.spool().retain(acceptedMessages.map((message) => ({ kind: "inbound", message })));
    } catch {
      retained = false;
      this.reportIgnoredOnce(tenantId, "inbound_spool_unavailable", {});
    }
    captureComplete();
    if (!retained) {
      // Best effort only: without a successful fsync there is no crash-safe copy.
      // The socket is latched degraded and requires an explicit reconnect after
      // storage is repaired, regardless of whether this direct idempotent write wins.
      await this.persistInboundBatchWithRetry(acceptedMessages);
      await this.recoverFromInboundPersistenceFailure(tenantId, connection, generation, "inbound_spool_unavailable");
      return;
    }
    const drain = await this.queueSpoolDrain(tenantId);
    if (!drain.inboundReady) {
      await this.recoverFromInboundPersistenceFailure(tenantId, connection, generation, "inbound_persistence_failed");
      return;
    }
    if (drain.deferredDeliveries) this.scheduleSpoolRetry(tenantId, connection);
    if (!this.isCurrentConnection(tenantId, connection, generation)) return;
    const lastReceivedAt = acceptedMessages.reduce(
      (latest, message) => Math.max(latest, message.receivedAt.getTime()),
      0
    );
    connection.status = {
      ...connection.status,
      lastActivityAt: new Date(lastReceivedAt).toISOString(),
      lastError: undefined
    };
    await this.emitStatus(tenantId);
  }

  private persistInboundBatchWithRetry(messages: WhatsAppInboundText[]): Promise<boolean> {
    return this.persistWithRetry(async () => {
      for (const message of messages) await this.inboundHandler(message);
    });
  }

  private async recoverFromInboundPersistenceFailure(
    tenantId: string,
    connection: TenantConnection,
    generation: number,
    errorCode: "inbound_persistence_failed" | "inbound_spool_unavailable"
  ): Promise<void> {
    if (!this.isCurrentConnection(tenantId, connection, generation)) return;
    connection.generation += 1;
    const socket = connection.socket;
    connection.socket = undefined;
    connection.qr = undefined;
    socket?.end(new Error(errorCode));
    await this.updateStatus(tenantId, {
      ...connection.status,
      state: "degraded",
      lastError: errorCode
    });
    if (this.connections.get(tenantId) !== connection) return;
    if (errorCode === "inbound_persistence_failed") {
      this.reconnectAfterSpool.add(tenantId);
      this.scheduleSpoolRetry(tenantId, connection);
    }
  }

  private spool(): EncryptedChannelEventSpool {
    this.assertEnabled();
    this.eventSpool ??= new EncryptedChannelEventSpool(
      resolve(this.config.sessionRoot, ".channel-event-spool"),
      this.config.phoneHashKey!,
      {
        maxRecords: this.config.inboundSpoolMaxRecords,
        maxBytes: this.config.inboundSpoolMaxBytes
      }
    );
    return this.eventSpool;
  }

  private queueSpoolDrain(tenantId: string): Promise<SpoolDrainResult> {
    const previous =
      this.spoolDrains.get(tenantId) ?? Promise.resolve({ inboundReady: true, deferredDeliveries: false });
    const current = previous
      .catch(() => ({ inboundReady: false, deferredDeliveries: false }))
      .then(() => this.drainStoredEvents(tenantId))
      .catch(() => ({ inboundReady: false, deferredDeliveries: false }));
    this.spoolDrains.set(tenantId, current);
    void current.finally(() => {
      if (this.spoolDrains.get(tenantId) === current) this.spoolDrains.delete(tenantId);
    });
    return current;
  }

  private async drainStoredEvents(tenantId: string): Promise<SpoolDrainResult> {
    let entries: Awaited<ReturnType<EncryptedChannelEventSpool["list"]>>;
    try {
      entries = await this.spool().list(tenantId);
    } catch {
      return { inboundReady: false, deferredDeliveries: false };
    }
    let deferredDeliveries = false;
    for (const entry of entries) {
      const persisted = await this.persistWithRetry(async () => {
        if (!(await this.dispatchDurableEvent(entry.event))) throw new Error("durable_event_projection_deferred");
        await this.spool().acknowledge(tenantId, entry.id);
      });
      if (!persisted) {
        if (entry.event.kind === "inbound") return { inboundReady: false, deferredDeliveries };
        deferredDeliveries = true;
      }
    }
    return { inboundReady: true, deferredDeliveries };
  }

  private async dispatchDurableEvent(event: DurableChannelEvent): Promise<boolean> {
    if (event.kind === "inbound") {
      await this.inboundHandler(event.message);
      return true;
    }
    return this.deliveryHandler(event.update);
  }

  private async persistWithRetry(operation: () => Promise<void>): Promise<boolean> {
    for (let attempt = 1; attempt <= this.config.inboundPersistenceMaxAttempts; attempt += 1) {
      try {
        await withTimeout(operation(), this.config.inboundPersistenceAttemptTimeoutMs);
        return true;
      } catch {
        if (attempt === this.config.inboundPersistenceMaxAttempts) return false;
        const delay = Math.min(this.config.inboundPersistenceRetryBaseDelayMs * 2 ** (attempt - 1), 10_000);
        if (delay > 0) await wait(delay);
      }
    }
    return false;
  }

  private scheduleSpoolRetry(tenantId: string, connection: TenantConnection): void {
    if (this.connections.get(tenantId) !== connection || this.spoolRetryTimers.has(tenantId)) return;
    const attempt = this.spoolRetryAttempts.get(tenantId) ?? 0;
    const delay = Math.min(this.config.inboundPersistenceRetryBaseDelayMs * 2 ** Math.min(attempt, 10), 60_000);
    this.spoolRetryAttempts.set(tenantId, attempt + 1);
    const timer = setTimeout(() => {
      this.spoolRetryTimers.delete(tenantId);
      void this.queueSpoolDrain(tenantId).then(async (drain) => {
        if (this.connections.get(tenantId) !== connection) return;
        if (!drain.inboundReady) {
          this.scheduleSpoolRetry(tenantId, connection);
          return;
        }
        this.spoolRetryAttempts.delete(tenantId);
        if (this.reconnectAfterSpool.delete(tenantId)) {
          try {
            await this.openSocket(tenantId, connection);
          } catch {
            await this.updateStatus(tenantId, {
              ...connection.status,
              state: "degraded",
              lastError: "reconnect_failed"
            });
            this.scheduleReconnect(tenantId, connection);
          }
        }
        if (drain.deferredDeliveries) this.scheduleSpoolRetry(tenantId, connection);
      });
    }, delay);
    timer.unref();
    this.spoolRetryTimers.set(tenantId, timer);
  }

  private clearSpoolRetry(tenantId: string): void {
    const timer = this.spoolRetryTimers.get(tenantId);
    if (timer) clearTimeout(timer);
    this.spoolRetryTimers.delete(tenantId);
    this.spoolRetryAttempts.delete(tenantId);
  }

  private async parseIncoming(
    tenantId: string,
    connection: TenantConnection,
    message: IncomingMessage
  ): Promise<WhatsAppInboundText | undefined> {
    if (message.key.fromMe) {
      this.reportIgnoredOnce(tenantId, "own_message", {});
      return undefined;
    }
    const providerAddress = message.key.remoteJid ?? undefined;
    if (!providerAddress || !isIndividualAddress(providerAddress)) {
      this.reportIgnoredOnce(tenantId, "unsupported_address", {
        addressKind: addressKind(providerAddress)
      });
      return undefined;
    }
    const allowedNumber = await authorizedNumber(message.key, this.config.allowedNumbers, connection.socket);
    if (!allowedNumber) {
      this.reportIgnoredOnce(tenantId, "unauthorized_sender", {
        addressKind: addressKind(providerAddress),
        hasPhoneAlternate: hasPhoneAlternate(message.key),
        lidResolverAvailable: Boolean(connection.socket?.signalRepository?.lidMapping)
      });
      return undefined;
    }
    const body = extractPlainText(message.message)?.trim();
    if (!body || body.length > this.config.maxMessageLength) {
      this.reportIgnoredOnce(tenantId, "unsupported_payload", {
        payloadKinds: safePayloadKinds(message.message),
        overLength: Boolean(body && body.length > this.config.maxMessageLength)
      });
      return undefined;
    }
    const externalMessageId = message.key.id?.trim();
    if (!externalMessageId) {
      this.reportIgnoredOnce(tenantId, "missing_message_id", {});
      return undefined;
    }
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

  private reportIgnoredOnce(tenantId: string, reason: string, metadata: Record<string, unknown>): void {
    const dimension = String(metadata.addressKind ?? metadata.eventType ?? "default");
    const key = `${tenantId}:${reason}:${dimension}`;
    if (this.reportedDiagnostics.has(key)) return;
    this.reportedDiagnostics.add(key);
    try {
      this.reportIgnored(reason, metadata);
    } catch {
      // Diagnostics must never change channel behavior.
    }
  }

  private resetDiagnostics(tenantId: string): void {
    const prefix = `${tenantId}:`;
    for (const key of this.reportedDiagnostics) {
      if (key.startsWith(prefix)) this.reportedDiagnostics.delete(key);
    }
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

  private async handleDeliveryUpdates(
    tenantId: string,
    event: MessageUpdate,
    captureComplete: () => void
  ): Promise<void> {
    const updates: WhatsAppDeliveryUpdate[] = [];
    for (const item of event) {
      if (item.key.fromMe !== true) continue;
      const providerMessageId = item.key.id?.trim();
      const status = deliveryStatus(item.update.status);
      if (!providerMessageId || !status) continue;
      updates.push({
        tenantId,
        provider: WHATSAPP_PROVIDER_MODE,
        providerMessageId,
        status,
        occurredAt: new Date()
      });
    }
    if (updates.length === 0) {
      captureComplete();
      return;
    }
    let retained = true;
    try {
      await this.spool().retain(updates.map((update) => ({ kind: "delivery", update })));
    } catch {
      retained = false;
      this.reportIgnoredOnce(tenantId, "delivery_receipt_spool_unavailable", {});
    }
    captureComplete();
    if (!retained) {
      await this.persistWithRetry(async () => {
        for (const update of updates) {
          if (!(await this.deliveryHandler(update))) throw new Error("delivery_projection_deferred");
        }
      });
      const connection = this.connections.get(tenantId);
      if (connection) {
        await this.recoverFromInboundPersistenceFailure(
          tenantId,
          connection,
          connection.generation,
          "inbound_spool_unavailable"
        );
      }
      return;
    }
    const drain = await this.queueSpoolDrain(tenantId);
    if (!drain.inboundReady || drain.deferredDeliveries) {
      this.reportIgnoredOnce(tenantId, "delivery_receipt_persistence_deferred", {});
    }
    const connection = this.connections.get(tenantId);
    if (connection && (!drain.inboundReady || drain.deferredDeliveries)) this.scheduleSpoolRetry(tenantId, connection);
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
    const snapshot = this.status(tenantId);
    const previous = this.statusProjectionTails.get(tenantId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.statusHandler(tenantId, snapshot))
      .catch(() => undefined);
    this.statusProjectionTails.set(tenantId, current);
    await current;
    if (this.statusProjectionTails.get(tenantId) === current) this.statusProjectionTails.delete(tenantId);
  }

  private trackDurableCapture(operation: (captureComplete: () => void) => Promise<void>): Promise<void> {
    let resolveBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      resolveBarrier = resolve;
    });
    let completed = false;
    const captureComplete = () => {
      if (completed) return;
      completed = true;
      this.captureBarriers.delete(barrier);
      resolveBarrier();
    };
    this.captureBarriers.add(barrier);
    const processing = operation(captureComplete).finally(captureComplete);
    void processing.catch(() => undefined);
    return processing;
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

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("channel_event_persistence_timeout")), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

const NON_CONTENT_MESSAGE_KEYS = new Set(["messageContextInfo", "senderKeyDistributionMessage"]);

function extractPlainText(message: IncomingMessage["message"]): string | undefined {
  if (!message) return undefined;
  const keys = Object.keys(message).filter((key) => message[key] != null && !NON_CONTENT_MESSAGE_KEYS.has(key));
  if (keys.length !== 1) return undefined;
  if (keys[0] === "conversation") return message.conversation ?? undefined;
  if (keys[0] === "extendedTextMessage") return message.extendedTextMessage?.text ?? undefined;
  return undefined;
}

async function authorizedNumber(
  key: IncomingMessage["key"],
  allowedNumbers: ReadonlySet<string>,
  socket: WhatsAppSocket | undefined
): Promise<string | undefined> {
  const candidates = [key.remoteJidAlt, key.participantAlt, key.remoteJid, key.participant];
  for (const candidate of candidates) {
    if (!candidate || !candidate.endsWith("@s.whatsapp.net")) continue;
    const number = candidate.slice(0, candidate.indexOf("@")).split(":")[0];
    if (number && allowedNumbers.has(number)) return number;
  }

  const lidCandidates = candidates.filter((candidate): candidate is string => Boolean(candidate?.endsWith("@lid")));
  const lidMapping = socket?.signalRepository?.lidMapping;
  if (!lidMapping || lidCandidates.length === 0) return undefined;
  for (const lid of lidCandidates) {
    const phoneJid = await lidMapping.getPNForLID(lid).catch(() => null);
    const phoneNumber = phoneJid?.endsWith("@s.whatsapp.net")
      ? phoneJid.slice(0, phoneJid.indexOf("@")).split(":")[0]
      : undefined;
    if (phoneNumber && allowedNumbers.has(phoneNumber)) return phoneNumber;
  }
  for (const allowedNumber of allowedNumbers) {
    const allowedLid = await lidMapping.getLIDForPN(`${allowedNumber}@s.whatsapp.net`).catch(() => null);
    if (allowedLid && lidCandidates.some((candidate) => areJidsSameUser(candidate, allowedLid))) {
      return allowedNumber;
    }
  }
  return undefined;
}

function hasPhoneAlternate(key: IncomingMessage["key"]): boolean {
  return [key.remoteJidAlt, key.participantAlt].some((candidate) => candidate?.endsWith("@s.whatsapp.net"));
}

function addressKind(address: string | undefined): "pn" | "lid" | "group" | "broadcast" | "other" | "missing" {
  if (!address) return "missing";
  if (address.endsWith("@s.whatsapp.net")) return "pn";
  if (address.endsWith("@lid")) return "lid";
  if (address.endsWith("@g.us")) return "group";
  if (address.endsWith("@broadcast")) return "broadcast";
  return "other";
}

function safePayloadKinds(message: IncomingMessage["message"]): string[] {
  return message
    ? Object.keys(message)
        .filter((key) => message[key] != null)
        .sort()
        .slice(0, 8)
    : [];
}

function safeEventType(value: string | undefined): string {
  return value && /^[a-z_]{1,24}$/i.test(value) ? value : "unknown";
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

async function wait(delayMs: number): Promise<void> {
  await new Promise<void>((resolveDelay) => {
    const timer = setTimeout(resolveDelay, delayMs);
    timer.unref();
  });
}
