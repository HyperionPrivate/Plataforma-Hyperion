import { afterEach, describe, expect, it } from "vitest";
import { readWhatsAppProviderConfig } from "./provider-config.js";

const VARIABLE_NAMES = [
  "WHATSAPP_INBOUND_PERSIST_MAX_ATTEMPTS",
  "WHATSAPP_INBOUND_PERSIST_RETRY_BASE_DELAY_MS",
  "WHATSAPP_INBOUND_PERSIST_ATTEMPT_TIMEOUT_MS",
  "WHATSAPP_INBOUND_SPOOL_MAX_RECORDS",
  "WHATSAPP_INBOUND_SPOOL_MAX_BYTES",
  "WHATSAPP_WEB_TEST_ENABLED",
  "WHATSAPP_TEST_ALLOWED_NUMBERS",
  "WHATSAPP_PHONE_HASH_KEY",
  "INTERNAL_SERVICE_TOKEN"
] as const;

const originalValues = new Map(VARIABLE_NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of VARIABLE_NAMES) {
    const value = originalValues.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("WhatsApp durability configuration", () => {
  it("uses bounded defaults for retry and encrypted spool capacity", () => {
    for (const name of VARIABLE_NAMES) delete process.env[name];

    expect(readWhatsAppProviderConfig()).toMatchObject({
      inboundPersistenceMaxAttempts: 3,
      inboundPersistenceRetryBaseDelayMs: 250,
      inboundPersistenceAttemptTimeoutMs: 10_000,
      inboundSpoolMaxRecords: 2_000,
      inboundSpoolMaxBytes: 16_777_216
    });
  });

  it("accepts controlled overrides and rejects unsafe limits", () => {
    process.env.WHATSAPP_INBOUND_PERSIST_MAX_ATTEMPTS = "5";
    process.env.WHATSAPP_INBOUND_PERSIST_RETRY_BASE_DELAY_MS = "500";
    process.env.WHATSAPP_INBOUND_PERSIST_ATTEMPT_TIMEOUT_MS = "15000";
    process.env.WHATSAPP_INBOUND_SPOOL_MAX_RECORDS = "100";
    process.env.WHATSAPP_INBOUND_SPOOL_MAX_BYTES = "1048576";

    expect(readWhatsAppProviderConfig()).toMatchObject({
      inboundPersistenceMaxAttempts: 5,
      inboundPersistenceRetryBaseDelayMs: 500,
      inboundPersistenceAttemptTimeoutMs: 15_000,
      inboundSpoolMaxRecords: 100,
      inboundSpoolMaxBytes: 1_048_576
    });

    process.env.WHATSAPP_INBOUND_SPOOL_MAX_BYTES = "1024";
    expect(() => readWhatsAppProviderConfig()).toThrow(
      "WHATSAPP_INBOUND_SPOOL_MAX_BYTES must be an integer between 65536 and 268435456"
    );

    process.env.WHATSAPP_INBOUND_SPOOL_MAX_BYTES = "1048576";
    process.env.WHATSAPP_INBOUND_PERSIST_ATTEMPT_TIMEOUT_MS = "9999";
    expect(() => readWhatsAppProviderConfig()).toThrow(
      "WHATSAPP_INBOUND_PERSIST_ATTEMPT_TIMEOUT_MS must be an integer between 10000 and 60000"
    );
  });

  it("requires a dedicated phone hash key and never falls back to an edge credential", () => {
    process.env.WHATSAPP_WEB_TEST_ENABLED = "true";
    process.env.WHATSAPP_TEST_ALLOWED_NUMBERS = "573001234567";
    process.env.INTERNAL_SERVICE_TOKEN = "legacy-shared-token-that-must-not-be-used";
    delete process.env.WHATSAPP_PHONE_HASH_KEY;

    expect(() => readWhatsAppProviderConfig()).toThrow(
      "WHATSAPP_PHONE_HASH_KEY is required when WHATSAPP_WEB_TEST_ENABLED=true"
    );

    process.env.WHATSAPP_PHONE_HASH_KEY = "short";
    expect(() => readWhatsAppProviderConfig()).toThrow("between 32 and 512 safe characters");

    const dedicatedKey = "channel-phone-hash-key-000000000001";
    process.env.WHATSAPP_PHONE_HASH_KEY = dedicatedKey;
    expect(readWhatsAppProviderConfig().phoneHashKey).toBe(dedicatedKey);
  });
});
