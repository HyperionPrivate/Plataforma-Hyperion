import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { chmod, link, mkdir, open, readdir, readFile, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { WhatsAppDeliveryUpdate, WhatsAppInboundText } from "./types.js";
import { WHATSAPP_PROVIDER_MODE } from "./types.js";

export type DurableChannelEvent =
  { kind: "inbound"; message: WhatsAppInboundText } | { kind: "delivery"; update: WhatsAppDeliveryUpdate };

export interface DurableChannelEventEntry {
  id: string;
  event: DurableChannelEvent;
}

export interface EncryptedChannelEventSpoolOptions {
  maxRecords: number;
  maxBytes: number;
}

export class DurableEventSpoolConflictError extends Error {
  constructor() {
    super("A retained channel event conflicts with the existing durable record");
    this.name = "DurableEventSpoolConflictError";
  }
}

export class DurableEventSpoolLimitError extends Error {
  constructor() {
    super("The durable channel event spool limit would be exceeded");
    this.name = "DurableEventSpoolLimitError";
  }
}

export class DurableEventSpoolCorruptionError extends Error {
  constructor() {
    super("A durable channel event record is corrupt or cannot be authenticated");
    this.name = "DurableEventSpoolCorruptionError";
  }
}

const FORMAT_MAGIC = Buffer.from("HCSPOOL1", "ascii");
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const RECORD_OVERHEAD_BYTES = FORMAT_MAGIC.length + IV_BYTES + AUTH_TAG_BYTES;
const ID_PATTERN = /^[a-f0-9]{64}$/;
const TENANT_DIRECTORY_PATTERN = /^tenant-[a-f0-9]{64}$/;
const FINAL_RECORD_PATTERN = /^([a-f0-9]{64})\.event$/;
const TEMP_RECORD_PATTERN = /^\.pending-([a-f0-9]{64})-[a-f0-9]{32}\.tmp$/;
const HKDF_SALT = createHash("sha256").update("hyperion:whatsapp:durable-event-spool:v1").digest();
const ENCRYPTION_INFO = Buffer.from("channel-event-payload-encryption:v1", "utf8");
const IDENTITY_INFO = Buffer.from("channel-event-filename-identity:v1", "utf8");
const TENANT_ENCRYPTION_INFO = Buffer.from("channel-event-tenant-aes-256-gcm:v1", "utf8");

interface PlannedRecord {
  id: string;
  tenantId: string;
  plaintext: Buffer;
  event: DurableChannelEvent;
  order: number;
  exists: boolean;
}

interface SpoolUsage {
  records: number;
  bytes: number;
}

export class EncryptedChannelEventSpool {
  private readonly rootDirectory: string;
  private readonly maxRecords: number;
  private readonly maxBytes: number;
  private readonly encryptionRootKey: Buffer;
  private readonly identityKey: Buffer;
  private readonly tenantLastOrders = new Map<string, number>();
  private tail: Promise<void> = Promise.resolve();

  constructor(rootDirectory: string, secret: string, options: EncryptedChannelEventSpoolOptions) {
    if (typeof rootDirectory !== "string" || rootDirectory.trim().length === 0) {
      throw new TypeError("A spool root directory is required");
    }
    if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
      throw new TypeError("The spool secret must contain at least 32 bytes");
    }
    if (!Number.isSafeInteger(options.maxRecords) || options.maxRecords < 1) {
      throw new TypeError("maxRecords must be a positive safe integer");
    }
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < RECORD_OVERHEAD_BYTES + 1) {
      throw new TypeError("maxBytes is too small for a durable record");
    }

    this.rootDirectory = resolve(rootDirectory);
    this.maxRecords = options.maxRecords;
    this.maxBytes = options.maxBytes;

    const secretBytes = Buffer.from(secret, "utf8");
    try {
      this.encryptionRootKey = deriveKey(secretBytes, ENCRYPTION_INFO);
      this.identityKey = deriveKey(secretBytes, IDENTITY_INFO);
    } finally {
      secretBytes.fill(0);
    }
  }

  retain(events: DurableChannelEvent[]): Promise<void> {
    return this.exclusive(async () => this.retainUnsafe(events));
  }

  list(tenantId: string): Promise<DurableChannelEventEntry[]> {
    return this.exclusive(async () => this.listUnsafe(validateTenantId(tenantId)));
  }

  acknowledge(tenantId: string, id: string): Promise<void> {
    return this.exclusive(async () => {
      const validatedTenantId = validateTenantId(tenantId);
      if (!ID_PATTERN.test(id)) throw new TypeError("Invalid durable event identifier");
      await this.prepareRootUnsafe();
      const directory = await this.ensureTenantDirectoryUnsafe(validatedTenantId);
      await this.recoverTenantUnsafe(validatedTenantId, directory);
      await unlinkIfPresent(join(directory, finalFilename(id)));
      await syncDirectory(directory);
    });
  }

  pendingCount(tenantId: string): Promise<number> {
    return this.exclusive(async () => (await this.listUnsafe(validateTenantId(tenantId))).length);
  }

  private async retainUnsafe(events: DurableChannelEvent[]): Promise<void> {
    if (!Array.isArray(events)) throw new TypeError("Durable events must be an array");
    if (events.length === 0) return;
    if (events.length > this.maxRecords) throw new DurableEventSpoolLimitError();

    const unique = new Map<string, PlannedRecord>();
    for (const candidate of events) {
      const event = normalizeEvent(candidate);
      const tenantId = tenantIdOf(event);
      const id = this.eventId(event);
      const current = unique.get(id);
      if (current) {
        if (!eventsEquivalent(current.event, event)) throw new DurableEventSpoolConflictError();
        continue;
      }
      unique.set(id, { id, tenantId, plaintext: Buffer.alloc(0), event, order: 0, exists: false });
    }

    await this.prepareRootUnsafe();
    const tenantDirectories = new Map<string, string>();
    for (const tenantId of new Set([...unique.values()].map((record) => record.tenantId))) {
      const directory = await this.ensureTenantDirectoryUnsafe(tenantId);
      await this.recoverTenantUnsafe(tenantId, directory);
      tenantDirectories.set(tenantId, directory);
    }

    let addedRecords = 0;
    let addedBytes = 0;
    for (const record of unique.values()) {
      const directory = tenantDirectories.get(record.tenantId);
      if (!directory) throw new DurableEventSpoolCorruptionError();
      const target = join(directory, finalFilename(record.id));
      const existing = await this.readBoundedFileIfPresent(target);
      if (existing) {
        const existingRecord = this.decodeRecord(record.tenantId, record.id, existing);
        if (!eventsEquivalent(existingRecord.event, record.event)) {
          throw new DurableEventSpoolConflictError();
        }
        record.order = existingRecord.order;
        record.exists = true;
        continue;
      }

      record.order = await this.nextTenantOrderUnsafe(record.tenantId, directory);
      record.plaintext = serializeEvent(record.event, record.order);
      addedRecords += 1;
      addedBytes += encryptedSize(record.plaintext);
      if (!Number.isSafeInteger(addedBytes) || addedBytes > this.maxBytes) {
        throw new DurableEventSpoolLimitError();
      }
    }

    const usage = await this.scanUsageUnsafe();
    if (
      usage.records + addedRecords > this.maxRecords ||
      usage.bytes + addedBytes > this.maxBytes ||
      !Number.isSafeInteger(usage.bytes + addedBytes)
    ) {
      throw new DurableEventSpoolLimitError();
    }

    for (const record of unique.values()) {
      if (record.exists) continue;
      const directory = tenantDirectories.get(record.tenantId);
      if (!directory) throw new DurableEventSpoolCorruptionError();
      await this.writeRecordUnsafe(directory, record);
    }
  }

  private async listUnsafe(tenantId: string): Promise<DurableChannelEventEntry[]> {
    await this.prepareRootUnsafe();
    const directory = await this.ensureTenantDirectoryUnsafe(tenantId);
    await this.recoverTenantUnsafe(tenantId, directory);
    const entries = await readdir(directory, { withFileTypes: true });
    const result: Array<DurableChannelEventEntry & { order: number }> = [];

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile()) continue;
      const match = FINAL_RECORD_PATTERN.exec(entry.name);
      if (!match) continue;
      const id = match[1];
      if (!id) throw new DurableEventSpoolCorruptionError();
      const encrypted = await this.readBoundedFile(join(directory, entry.name));
      const decoded = this.decodeRecord(tenantId, id, encrypted);
      result.push({ id, event: decoded.event, order: decoded.order });
    }
    return result
      .sort(
        (left, right) =>
          eventTimestamp(left.event) - eventTimestamp(right.event) ||
          left.order - right.order ||
          left.id.localeCompare(right.id)
      )
      .map(({ id, event }) => ({ id, event }));
  }

  private async writeRecordUnsafe(directory: string, record: PlannedRecord): Promise<void> {
    const target = join(directory, finalFilename(record.id));
    const temporary = join(directory, temporaryFilename(record.id));
    const encrypted = this.encryptRecord(record.tenantId, record.id, record.plaintext);
    let handle: Awaited<ReturnType<typeof open>> | undefined;

    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(encrypted);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(temporary, 0o600);

      try {
        await link(temporary, target);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        const existing = await this.readBoundedFile(target);
        const existingRecord = this.decodeRecord(record.tenantId, record.id, existing);
        if (!eventsEquivalent(existingRecord.event, record.event)) {
          throw new DurableEventSpoolConflictError();
        }
      }
      await unlinkIfPresent(temporary);
      await syncDirectory(directory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlinkIfPresent(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async recoverTenantUnsafe(tenantId: string, directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile()) continue;
      const match = TEMP_RECORD_PATTERN.exec(entry.name);
      if (!match) continue;
      const id = match[1];
      if (!id) throw new DurableEventSpoolCorruptionError();
      const temporary = join(directory, entry.name);
      const temporaryRecord = this.decodeRecord(tenantId, id, await this.readBoundedFile(temporary));

      const target = join(directory, finalFilename(id));
      try {
        await link(temporary, target);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        const existingRecord = this.decodeRecord(tenantId, id, await this.readBoundedFile(target));
        if (!eventsEquivalent(existingRecord.event, temporaryRecord.event)) {
          throw new DurableEventSpoolConflictError();
        }
      }
      await unlinkIfPresent(temporary);
      await syncDirectory(directory);
    }
  }

  private encryptRecord(tenantId: string, id: string, plaintext: Buffer): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.tenantEncryptionKey(tenantId), iv);
    cipher.setAAD(recordAad(tenantId, id));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([FORMAT_MAGIC, iv, cipher.getAuthTag(), ciphertext]);
  }

  private decryptRecord(tenantId: string, id: string, encrypted: Buffer): Buffer {
    try {
      if (
        encrypted.length <= RECORD_OVERHEAD_BYTES ||
        !encrypted.subarray(0, FORMAT_MAGIC.length).equals(FORMAT_MAGIC)
      ) {
        throw new Error("invalid record");
      }
      const ivStart = FORMAT_MAGIC.length;
      const tagStart = ivStart + IV_BYTES;
      const ciphertextStart = tagStart + AUTH_TAG_BYTES;
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.tenantEncryptionKey(tenantId),
        encrypted.subarray(ivStart, tagStart)
      );
      decipher.setAAD(recordAad(tenantId, id));
      decipher.setAuthTag(encrypted.subarray(tagStart, ciphertextStart));
      return Buffer.concat([decipher.update(encrypted.subarray(ciphertextStart)), decipher.final()]);
    } catch {
      throw new DurableEventSpoolCorruptionError();
    }
  }

  private decodeRecord(
    tenantId: string,
    id: string,
    encrypted: Buffer
  ): { plaintext: Buffer; event: DurableChannelEvent; order: number } {
    const plaintext = this.decryptRecord(tenantId, id, encrypted);
    const { event, order } = deserializeEvent(plaintext);
    if (tenantIdOf(event) !== tenantId || this.eventId(event) !== id) {
      throw new DurableEventSpoolCorruptionError();
    }
    return { plaintext, event, order };
  }

  private async nextTenantOrderUnsafe(tenantId: string, directory: string): Promise<number> {
    let last = this.tenantLastOrders.get(tenantId);
    if (last === undefined) {
      last = 0;
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const match = entry.isFile() ? FINAL_RECORD_PATTERN.exec(entry.name) : null;
        const id = match?.[1];
        if (!id) continue;
        const decoded = this.decodeRecord(tenantId, id, await this.readBoundedFile(join(directory, entry.name)));
        last = Math.max(last, decoded.order);
      }
    }
    const wallOrder = Date.now() * 1_000;
    const next = Math.max(last + 1, wallOrder);
    if (!Number.isSafeInteger(next)) throw new DurableEventSpoolLimitError();
    this.tenantLastOrders.set(tenantId, next);
    return next;
  }

  private eventId(event: DurableChannelEvent): string {
    const identity =
      event.kind === "inbound"
        ? ["inbound", event.message.tenantId, event.message.provider, event.message.externalMessageId]
        : [
            "delivery",
            event.update.tenantId,
            event.update.provider,
            event.update.providerMessageId,
            event.update.status
          ];
    return createHmac("sha256", this.identityKey).update(JSON.stringify(identity)).digest("hex");
  }

  private tenantEncryptionKey(tenantId: string): Buffer {
    const salt = createHash("sha256")
      .update("hyperion:whatsapp:durable-event-spool:tenant:v1")
      .update("\0")
      .update(tenantId)
      .digest();
    return Buffer.from(hkdfSync("sha256", this.encryptionRootKey, salt, TENANT_ENCRYPTION_INFO, 32));
  }

  private tenantDirectory(tenantId: string): string {
    const directoryId = createHmac("sha256", this.identityKey)
      .update("tenant-directory:v1")
      .update("\0")
      .update(tenantId)
      .digest("hex");
    return join(this.rootDirectory, "tenant-" + directoryId);
  }

  private async prepareRootUnsafe(): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.rootDirectory, 0o700);
  }

  private async ensureTenantDirectoryUnsafe(tenantId: string): Promise<string> {
    const directory = this.tenantDirectory(tenantId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await syncDirectory(this.rootDirectory);
    return directory;
  }

  private async scanUsageUnsafe(): Promise<SpoolUsage> {
    const usage: SpoolUsage = { records: 0, bytes: 0 };
    const tenants = await readdir(this.rootDirectory, { withFileTypes: true });
    for (const tenant of tenants) {
      if (!tenant.isDirectory() || !TENANT_DIRECTORY_PATTERN.test(tenant.name)) continue;
      const directory = join(this.rootDirectory, tenant.name);
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || (!FINAL_RECORD_PATTERN.test(entry.name) && !TEMP_RECORD_PATTERN.test(entry.name))) {
          continue;
        }
        const file = await stat(join(directory, entry.name));
        usage.records += 1;
        usage.bytes += file.size;
        if (usage.records > this.maxRecords || usage.bytes > this.maxBytes || !Number.isSafeInteger(usage.bytes)) {
          throw new DurableEventSpoolLimitError();
        }
      }
    }
    return usage;
  }

  private async readBoundedFile(path: string): Promise<Buffer> {
    const details = await stat(path);
    if (details.size <= RECORD_OVERHEAD_BYTES || details.size > this.maxBytes) {
      throw new DurableEventSpoolCorruptionError();
    }
    return readFile(path);
  }

  private async readBoundedFileIfPresent(path: string): Promise<Buffer | undefined> {
    try {
      return await this.readBoundedFile(path);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: () => void = () => undefined;
    this.tail = new Promise<void>((resolveTail) => {
      release = resolveTail;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function deriveKey(secret: Buffer, info: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, HKDF_SALT, info, 32));
}

function encryptedSize(plaintext: Buffer): number {
  return RECORD_OVERHEAD_BYTES + plaintext.length;
}

function recordAad(tenantId: string, id: string): Buffer {
  return Buffer.from(JSON.stringify(["hyperion-channel-event-spool-aad:v1", tenantId, id]), "utf8");
}

function finalFilename(id: string): string {
  return id + ".event";
}

function temporaryFilename(id: string): string {
  return ".pending-" + id + "-" + randomBytes(16).toString("hex") + ".tmp";
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (
      process.platform === "win32" &&
      (hasCode(error, "EISDIR") || hasCode(error, "EPERM") || hasCode(error, "EINVAL") || hasCode(error, "EBADF"))
    ) {
      return;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function normalizeEvent(candidate: DurableChannelEvent): DurableChannelEvent {
  if (!isRecord(candidate)) throw new TypeError("Invalid durable channel event");
  if (candidate.kind === "inbound" && isRecord(candidate.message)) {
    const message = candidate.message;
    return {
      kind: "inbound",
      message: {
        tenantId: readRequiredString(message, "tenantId", 512),
        provider: readProvider(message, "provider"),
        externalMessageId: readRequiredString(message, "externalMessageId", 512),
        providerAddress: readRequiredString(message, "providerAddress", 512),
        phoneHash: readPhoneHash(message, "phoneHash"),
        phoneMasked: readRequiredString(message, "phoneMasked", 64),
        body: readRequiredString(message, "body", 10_000),
        receivedAt: readDateValue(message.receivedAt)
      }
    };
  }
  if (candidate.kind === "delivery" && isRecord(candidate.update)) {
    const update = candidate.update;
    const status = update.status;
    if (status !== "delivered" && status !== "read" && status !== "failed") {
      throw new TypeError("Invalid delivery status");
    }
    return {
      kind: "delivery",
      update: {
        tenantId: readRequiredString(update, "tenantId", 512),
        provider: readProvider(update, "provider"),
        providerMessageId: readRequiredString(update, "providerMessageId", 512),
        status,
        occurredAt: readDateValue(update.occurredAt)
      }
    };
  }
  throw new TypeError("Invalid durable channel event");
}

function serializeEvent(event: DurableChannelEvent, order: number): Buffer {
  const serializable =
    event.kind === "inbound"
      ? {
          version: 2,
          order,
          kind: "inbound",
          message: {
            tenantId: event.message.tenantId,
            provider: event.message.provider,
            externalMessageId: event.message.externalMessageId,
            providerAddress: event.message.providerAddress,
            phoneHash: event.message.phoneHash,
            phoneMasked: event.message.phoneMasked,
            body: event.message.body,
            receivedAt: event.message.receivedAt.toISOString()
          }
        }
      : {
          version: 2,
          order,
          kind: "delivery",
          update: {
            tenantId: event.update.tenantId,
            provider: event.update.provider,
            providerMessageId: event.update.providerMessageId,
            status: event.update.status,
            occurredAt: event.update.occurredAt.toISOString()
          }
        };
  return Buffer.from(JSON.stringify(serializable), "utf8");
}

function deserializeEvent(plaintext: Buffer): { event: DurableChannelEvent; order: number } {
  try {
    const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
    if (!isRecord(parsed) || parsed.version !== 2 || !Number.isSafeInteger(parsed.order) || Number(parsed.order) < 1) {
      throw new Error("invalid record envelope");
    }
    const order = Number(parsed.order);
    if (parsed.kind === "inbound" && isRecord(parsed.message)) {
      return {
        order,
        event: normalizeEvent({
          kind: "inbound",
          message: {
            tenantId: readRequiredString(parsed.message, "tenantId", 512),
            provider: readProvider(parsed.message, "provider"),
            externalMessageId: readRequiredString(parsed.message, "externalMessageId", 512),
            providerAddress: readRequiredString(parsed.message, "providerAddress", 512),
            phoneHash: readPhoneHash(parsed.message, "phoneHash"),
            phoneMasked: readRequiredString(parsed.message, "phoneMasked", 64),
            body: readRequiredString(parsed.message, "body", 10_000),
            receivedAt: readSerializedDate(parsed.message, "receivedAt")
          }
        })
      };
    }
    if (parsed.kind === "delivery" && isRecord(parsed.update)) {
      const status = parsed.update.status;
      if (status !== "delivered" && status !== "read" && status !== "failed") {
        throw new Error("invalid status");
      }
      return {
        order,
        event: normalizeEvent({
          kind: "delivery",
          update: {
            tenantId: readRequiredString(parsed.update, "tenantId", 512),
            provider: readProvider(parsed.update, "provider"),
            providerMessageId: readRequiredString(parsed.update, "providerMessageId", 512),
            status,
            occurredAt: readSerializedDate(parsed.update, "occurredAt")
          }
        })
      };
    }
    throw new Error("invalid event");
  } catch {
    throw new DurableEventSpoolCorruptionError();
  }
}

function tenantIdOf(event: DurableChannelEvent): string {
  return event.kind === "inbound" ? event.message.tenantId : event.update.tenantId;
}

function eventTimestamp(event: DurableChannelEvent): number {
  return event.kind === "inbound" ? event.message.receivedAt.getTime() : event.update.occurredAt.getTime();
}

function eventsEquivalent(left: DurableChannelEvent, right: DurableChannelEvent): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "inbound" && right.kind === "inbound") {
    return (
      left.message.tenantId === right.message.tenantId &&
      left.message.provider === right.message.provider &&
      left.message.externalMessageId === right.message.externalMessageId &&
      left.message.body === right.message.body &&
      left.message.phoneHash === right.message.phoneHash
    );
  }
  if (left.kind === "delivery" && right.kind === "delivery") {
    return (
      left.update.tenantId === right.update.tenantId &&
      left.update.provider === right.update.provider &&
      left.update.providerMessageId === right.update.providerMessageId &&
      left.update.status === right.update.status
    );
  }
  return false;
}

function validateTenantId(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || value.includes("\0")) {
    throw new TypeError("Invalid tenant identifier");
  }
  return value;
}

function readRequiredString(record: Record<string, unknown>, key: string, maxLength: number): string {
  const value = record[key];
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || value.includes("\0")) {
    throw new TypeError("Invalid durable event field");
  }
  return value;
}

function readProvider(record: Record<string, unknown>, key: string): typeof WHATSAPP_PROVIDER_MODE {
  if (record[key] !== WHATSAPP_PROVIDER_MODE) throw new TypeError("Invalid channel provider");
  return WHATSAPP_PROVIDER_MODE;
}

function readPhoneHash(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError("Invalid phone hash");
  }
  return value;
}

function readDateValue(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("Invalid durable event date");
  }
  return new Date(value.getTime());
}

function readSerializedDate(record: Record<string, unknown>, key: string): Date {
  const value = record[key];
  if (typeof value !== "string") throw new Error("invalid date");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error("invalid date");
  }
  return date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
