import { resolve } from "node:path";

export interface WhatsAppProviderConfig {
  enabled: boolean;
  allowedNumbers: ReadonlySet<string>;
  phoneHashKey?: string;
  sessionRoot: string;
  maxMessageLength: number;
  rateLimitMessages: number;
  rateLimitWindowMs: number;
  qrTtlMs: number;
  inboundPersistenceMaxAttempts: number;
  inboundPersistenceRetryBaseDelayMs: number;
  inboundPersistenceAttemptTimeoutMs: number;
  inboundSpoolMaxRecords: number;
  inboundSpoolMaxBytes: number;
  maxReconnectAttempts: number;
  reconnectBaseDelayMs: number;
}

export function readWhatsAppProviderConfig(): WhatsAppProviderConfig {
  return {
    enabled: process.env.WHATSAPP_WEB_TEST_ENABLED === "true",
    allowedNumbers: new Set(readAllowedNumbers(process.env.WHATSAPP_TEST_ALLOWED_NUMBERS)),
    phoneHashKey: process.env.WHATSAPP_PHONE_HASH_KEY?.trim() || process.env.INTERNAL_SERVICE_TOKEN?.trim(),
    sessionRoot: resolve(process.env.WHATSAPP_SESSION_DIR ?? "tmp/whatsapp-sessions"),
    maxMessageLength: readInteger("WHATSAPP_MAX_MESSAGE_LENGTH", 2_000, 1, 10_000),
    rateLimitMessages: readInteger("WHATSAPP_RATE_LIMIT_MESSAGES", 12, 1, 120),
    rateLimitWindowMs: readInteger("WHATSAPP_RATE_LIMIT_WINDOW_MS", 60_000, 1_000, 3_600_000),
    qrTtlMs: readInteger("WHATSAPP_QR_TTL_MS", 60_000, 10_000, 300_000),
    inboundPersistenceMaxAttempts: readInteger("WHATSAPP_INBOUND_PERSIST_MAX_ATTEMPTS", 3, 1, 10),
    inboundPersistenceRetryBaseDelayMs: readInteger("WHATSAPP_INBOUND_PERSIST_RETRY_BASE_DELAY_MS", 250, 50, 10_000),
    inboundPersistenceAttemptTimeoutMs: readInteger(
      "WHATSAPP_INBOUND_PERSIST_ATTEMPT_TIMEOUT_MS",
      10_000,
      10_000,
      60_000
    ),
    inboundSpoolMaxRecords: readInteger("WHATSAPP_INBOUND_SPOOL_MAX_RECORDS", 2_000, 1, 50_000),
    inboundSpoolMaxBytes: readInteger("WHATSAPP_INBOUND_SPOOL_MAX_BYTES", 16_777_216, 65_536, 268_435_456),
    maxReconnectAttempts: readInteger("WHATSAPP_MAX_RECONNECT_ATTEMPTS", 4, 0, 20),
    reconnectBaseDelayMs: readInteger("WHATSAPP_RECONNECT_BASE_DELAY_MS", 1_000, 100, 60_000)
  };
}

export function normalizeAllowedNumber(value: string): string | undefined {
  const normalized = value.replace(/[^0-9]/g, "");
  return normalized.length >= 8 && normalized.length <= 15 ? normalized : undefined;
}

function readAllowedNumbers(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => normalizeAllowedNumber(item.trim()))
    .filter((item): item is string => Boolean(item));
}

function readInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}
