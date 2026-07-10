import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DurableEventSpoolConflictError,
  DurableEventSpoolCorruptionError,
  DurableEventSpoolLimitError,
  EncryptedChannelEventSpool,
  type DurableChannelEvent
} from "./durable-event-spool.js";
import { WHATSAPP_PROVIDER_MODE } from "./types.js";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const SECRET = "unit-test-spool-secret-with-more-than-thirty-two-bytes";
const PHONE_HASH = "a".repeat(64);
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("EncryptedChannelEventSpool", () => {
  it("encrypts private fields, restores Date values and applies private permissions", async () => {
    const root = await temporaryRoot();
    const spool = createSpool(root);
    const inbound = inboundEvent();
    const delivery = deliveryEvent();

    await spool.retain([delivery, inbound]);

    const listed = await spool.list(TENANT_ID);
    expect(listed.map((entry) => entry.event.kind)).toEqual(["inbound", "delivery"]);
    expect(listed[0]?.event).toEqual(inbound);
    expect(listed[1]?.event).toEqual(delivery);
    expect(listed[0]?.event.kind === "inbound" && listed[0].event.message.receivedAt instanceof Date).toBe(true);
    expect(listed[1]?.event.kind === "delivery" && listed[1].event.update.occurredAt instanceof Date).toBe(true);

    const directory = await tenantDirectory(root);
    const files = await recordFiles(root);
    expect(files).toHaveLength(2);
    const diskBytes = Buffer.concat(await Promise.all(files.map((file) => readFile(file))));
    for (const privateValue of [
      inbound.message.body,
      inbound.message.providerAddress,
      inbound.message.phoneHash,
      inbound.message.phoneMasked,
      inbound.message.externalMessageId,
      delivery.update.providerMessageId
    ]) {
      expect(diskBytes.includes(Buffer.from(privateValue, "utf8"))).toBe(false);
    }
    expect(JSON.stringify(await readdir(root))).not.toContain(TENANT_ID);

    if (process.platform !== "win32") {
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      for (const file of files) expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it("deduplicates semantic redelivery, preserves the first event and rejects identity conflicts", async () => {
    const root = await temporaryRoot();
    const spool = createSpool(root);
    const inbound = inboundEvent();
    const inboundRedelivery: DurableChannelEvent = {
      kind: "inbound",
      message: {
        ...inbound.message,
        providerAddress: "changed-address@lid",
        phoneMasked: "****9999",
        receivedAt: new Date("2026-07-10T10:05:00.000Z")
      }
    };
    const delivery = deliveryEvent();
    const deliveryRedelivery: DurableChannelEvent = {
      kind: "delivery",
      update: { ...delivery.update, occurredAt: new Date("2026-07-10T10:06:00.000Z") }
    };

    await spool.retain([inbound, inboundRedelivery, delivery, deliveryRedelivery]);
    await spool.retain([inboundRedelivery, deliveryRedelivery]);

    const listed = await spool.list(TENANT_ID);
    expect(listed).toHaveLength(2);
    expect(listed.find((entry) => entry.event.kind === "inbound")?.event).toEqual(inbound);
    expect(listed.find((entry) => entry.event.kind === "delivery")?.event).toEqual(delivery);

    await expect(
      spool.retain([
        {
          kind: "inbound",
          message: { ...inbound.message, body: "different private body" }
        }
      ])
    ).rejects.toBeInstanceOf(DurableEventSpoolConflictError);
    await expect(
      spool.retain([
        {
          kind: "inbound",
          message: { ...inbound.message, phoneHash: "b".repeat(64) }
        }
      ])
    ).rejects.toBeInstanceOf(DurableEventSpoolConflictError);
    await expect(
      spool.retain([
        {
          kind: "inbound",
          message: { ...inbound.message, receivedAt: new Date(Number.NaN) }
        }
      ])
    ).rejects.toBeInstanceOf(TypeError);
    expect(await spool.pendingCount(TENANT_ID)).toBe(2);
  });

  it("preserves provider batch order when event timestamps are identical, including after restart", async () => {
    const root = await temporaryRoot();
    const first = inboundEvent();
    const second: DurableChannelEvent = {
      kind: "inbound",
      message: { ...first.message, externalMessageId: "same-second-second-message" }
    };
    const third: DurableChannelEvent = {
      kind: "inbound",
      message: { ...first.message, externalMessageId: "same-second-third-message" }
    };

    await createSpool(root).retain([second, third]);
    const listed = await createSpool(root).list(TENANT_ID);

    expect(
      listed.map((entry) => (entry.event.kind === "inbound" ? entry.event.message.externalMessageId : "delivery"))
    ).toEqual(["same-second-second-message", "same-second-third-message"]);
  });

  it("preflights batches and disk limits without partially retaining them", async () => {
    const recordLimitedRoot = await temporaryRoot();
    const recordLimited = createSpool(recordLimitedRoot, { maxRecords: 1, maxBytes: 1_000_000 });
    await expect(recordLimited.retain([inboundEvent(), deliveryEvent()])).rejects.toBeInstanceOf(
      DurableEventSpoolLimitError
    );
    expect(await recordLimited.pendingCount(TENANT_ID)).toBe(0);

    const conflictingRoot = await temporaryRoot();
    const conflicting = createSpool(conflictingRoot);
    const inbound = inboundEvent();
    await expect(
      conflicting.retain([
        inbound,
        { kind: "inbound", message: { ...inbound.message, body: "conflicting batch body" } }
      ])
    ).rejects.toBeInstanceOf(DurableEventSpoolConflictError);
    expect(await conflicting.pendingCount(TENANT_ID)).toBe(0);

    const byteLimitedRoot = await temporaryRoot();
    const byteLimited = createSpool(byteLimitedRoot, { maxRecords: 10, maxBytes: 128 });
    await expect(byteLimited.retain([inbound])).rejects.toBeInstanceOf(DurableEventSpoolLimitError);
    expect(await byteLimited.pendingCount(TENANT_ID)).toBe(0);
  });

  it("recovers a complete temporary record after restart and acknowledges idempotently", async () => {
    const root = await temporaryRoot();
    const first = createSpool(root);
    const inbound = inboundEvent();
    await first.retain([inbound]);
    const [entry] = await first.list(TENANT_ID);
    if (!entry) throw new Error("Expected retained event");

    const directory = await tenantDirectory(root);
    const finalPath = join(directory, entry.id + ".event");
    const temporaryPath = join(directory, ".pending-" + entry.id + "-" + "c".repeat(32) + ".tmp");
    await rename(finalPath, temporaryPath);

    const restarted = createSpool(root);
    expect(await restarted.list(TENANT_ID)).toEqual([entry]);
    expect(await readdir(directory)).toContain(entry.id + ".event");
    expect(await readdir(directory)).not.toContain(".pending-" + entry.id + "-" + "c".repeat(32) + ".tmp");

    await restarted.acknowledge(TENANT_ID, entry.id);
    await restarted.acknowledge(TENANT_ID, entry.id);
    expect(await restarted.pendingCount(TENANT_ID)).toBe(0);
  });

  it("fails closed on corruption and leaves the record available for investigation", async () => {
    const root = await temporaryRoot();
    const spool = createSpool(root);
    await spool.retain([inboundEvent()]);
    const [file] = await recordFiles(root);
    if (!file) throw new Error("Expected encrypted record");
    const corrupt = await readFile(file);
    corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] ?? 0) ^ 0xff;
    await writeFile(file, corrupt);

    await expect(spool.list(TENANT_ID)).rejects.toBeInstanceOf(DurableEventSpoolCorruptionError);
    expect(await readFile(file)).toEqual(corrupt);
  });
});

function createSpool(
  root: string,
  options: { maxRecords: number; maxBytes: number } = {
    maxRecords: 100,
    maxBytes: 1_000_000
  }
): EncryptedChannelEventSpool {
  return new EncryptedChannelEventSpool(root, SECRET, options);
}

async function temporaryRoot(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "hyperion-channel-spool-test-"));
  roots.push(parent);
  return join(parent, "spool");
}

async function tenantDirectory(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  const tenant = entries.find((entry) => entry.isDirectory() && entry.name.startsWith("tenant-"));
  if (!tenant) throw new Error("Expected tenant spool directory");
  return join(root, tenant.name);
}

async function recordFiles(root: string): Promise<string[]> {
  const directory = await tenantDirectory(root);
  return (await readdir(directory)).filter((name) => name.endsWith(".event")).map((name) => join(directory, name));
}

function inboundEvent(): Extract<DurableChannelEvent, { kind: "inbound" }> {
  return {
    kind: "inbound",
    message: {
      tenantId: TENANT_ID,
      provider: WHATSAPP_PROVIDER_MODE,
      externalMessageId: "private-external-message-id",
      providerAddress: "573001234567@s.whatsapp.net",
      phoneHash: PHONE_HASH,
      phoneMasked: "********4567",
      body: "private appointment request body",
      receivedAt: new Date("2026-07-10T10:00:00.000Z")
    }
  };
}

function deliveryEvent(): Extract<DurableChannelEvent, { kind: "delivery" }> {
  return {
    kind: "delivery",
    update: {
      tenantId: TENANT_ID,
      provider: WHATSAPP_PROVIDER_MODE,
      providerMessageId: "private-provider-message-id",
      status: "delivered",
      occurredAt: new Date("2026-07-10T10:01:00.000Z")
    }
  };
}
