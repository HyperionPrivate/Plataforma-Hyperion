import { describe, expect, it } from "vitest";
import {
  LUMEN_ALLOWED_AUDIO_MIME_TYPES,
  LUMEN_MAX_AUDIO_BYTES,
  LUMEN_MAX_RECORDING_SECONDS,
  clampLumenRecordingDuration,
  createLumenIdempotencyKey,
  isLumenAudioTransportAllowed,
  lumenAudioPayloadFingerprint,
  lumenRecordingReachedLimit,
  lumenShouldRetainIdempotencyKey,
  lumenStructurePayloadFingerprint,
  normalizeLumenAudioMimeType,
  resolveLumenIdempotencySlot,
  resolveLumenIdempotencySlotAfterFailure,
  validateLumenAudio
} from "./lumen-recording.js";

describe("LUMEN recording limits", () => {
  it("caps provider metadata at the 90 second contract limit", () => {
    expect(LUMEN_MAX_RECORDING_SECONDS).toBe(90);
    expect(clampLumenRecordingDuration(91.4)).toBe(90);
    expect(clampLumenRecordingDuration(0)).toBe(1);
  });

  it("stops only once the active recording duration reaches the limit", () => {
    expect(lumenRecordingReachedLimit(89)).toBe(false);
    expect(lumenRecordingReachedLimit(90)).toBe(true);
  });

  it("normalizes codec parameters and known browser MIME aliases", () => {
    expect(normalizeLumenAudioMimeType(" Audio/WebM; codecs=opus ")).toBe("audio/webm");
    expect(normalizeLumenAudioMimeType("audio/x-m4a")).toBe("audio/mp4");
    expect(normalizeLumenAudioMimeType("audio/mp3")).toBe("audio/mpeg");
  });

  it("enforces the MIME allowlist, 5 MiB size and 90 second duration", () => {
    expect(LUMEN_MAX_AUDIO_BYTES).toBe(5 * 1024 * 1024);
    expect(LUMEN_ALLOWED_AUDIO_MIME_TYPES).toContain("audio/webm");
    expect(validateLumenAudio({ mimeType: "video/webm", size: 100 }).code).toBe("invalid_mime");
    expect(validateLumenAudio({ mimeType: "audio/webm", size: LUMEN_MAX_AUDIO_BYTES + 1 }).code).toBe("invalid_size");
    expect(validateLumenAudio({ mimeType: "audio/webm", size: 100, durationSeconds: 90.01 }).code).toBe(
      "invalid_duration"
    );
    expect(validateLumenAudio({ mimeType: "audio/webm;codecs=opus", size: 100, durationSeconds: 8.6 })).toEqual({
      valid: true,
      mimeType: "audio/webm",
      durationSeconds: 9
    });
  });

  it("creates a new UUID idempotency key for every action", () => {
    const first = createLumenIdempotencyKey();
    const second = createLumenIdempotencyKey();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(second).not.toBe(first);
  });

  it("reuses the idempotency key for the same payload and rotates it when input changes", () => {
    let sequence = 0;
    const factory = () => `key-${++sequence}`;
    const first = resolveLumenIdempotencySlot(undefined, "payload-a", factory);
    const retry = resolveLumenIdempotencySlot(first, "payload-a", factory);
    const changed = resolveLumenIdempotencySlot(retry, "payload-b", factory);

    expect(retry).toBe(first);
    expect(retry.key).toBe("key-1");
    expect(changed.key).toBe("key-2");
  });

  it("fingerprints structure payloads by scope, dictation identity and reviewed transcript", () => {
    const first = lumenStructurePayloadFingerprint({
      scope: "tenant-a:encounter-a",
      dictationId: "dictation-a",
      transcript: " Hallazgo revisado "
    });
    expect(
      lumenStructurePayloadFingerprint({
        scope: "tenant-a:encounter-a",
        dictationId: "dictation-a",
        transcript: "Hallazgo revisado"
      })
    ).toBe(first);
    expect(
      lumenStructurePayloadFingerprint({
        scope: "tenant-a:encounter-a",
        dictationId: "dictation-b",
        transcript: "Hallazgo revisado"
      })
    ).not.toBe(first);
  });

  it("fingerprints audio by content and normalized request metadata", async () => {
    const base = {
      scope: "tenant-a:encounter-a",
      audioBase64: "YXVkaW8tYXV0b3JpemFkbw==",
      mimeType: "audio/webm",
      source: "authorized_upload",
      durationSeconds: 8
    };
    const first = await lumenAudioPayloadFingerprint(base);
    expect(await lumenAudioPayloadFingerprint({ ...base })).toBe(first);
    expect(await lumenAudioPayloadFingerprint({ ...base, durationSeconds: 9 })).not.toBe(first);
    expect(await lumenAudioPayloadFingerprint({ ...base, audioBase64: "YXVkaW8tZGlzdGludG8=" })).not.toBe(first);
  });

  it("retains keys only while the processing outcome remains unknown or pre-reservation", () => {
    expect(lumenShouldRetainIdempotencyKey({ kind: "transport" })).toBe(true);
    expect(lumenShouldRetainIdempotencyKey({ kind: "abort" })).toBe(true);
    expect(
      lumenShouldRetainIdempotencyKey({
        kind: "api",
        status: 409,
        message: "Clinical processing is already in progress"
      })
    ).toBe(true);
    expect(lumenShouldRetainIdempotencyKey({ kind: "api", status: 503, message: "Provider is not configured" })).toBe(
      true
    );
  });

  it.each([
    [408, "Clinical processing cancelled"],
    [429, "Provider rate limited"],
    [500, "Clinical processing failed"],
    [502, "Provider request failed"],
    [504, "Provider request timed out"],
    [409, "Previous clinical processing did not complete; retry with a new idempotency key"],
    [409, "Idempotency key was already used with different clinical input"]
  ])("rotates the key after terminal API status %s", (status, message) => {
    expect(lumenShouldRetainIdempotencyKey({ kind: "api", status, message })).toBe(false);
  });

  it("preserves the exact idempotency slot when user cancellation leaves the result unknown", () => {
    const slot = { fingerprint: "payload-a", key: "key-a" };

    expect(resolveLumenIdempotencySlotAfterFailure(slot, { kind: "abort" })).toBe(slot);
    expect(resolveLumenIdempotencySlotAfterFailure(slot, { kind: "transport" })).toBe(slot);
    expect(
      resolveLumenIdempotencySlotAfterFailure(slot, {
        kind: "api",
        status: 408,
        message: "Clinical processing cancelled"
      })
    ).toBeUndefined();
  });

  it.each([
    [{ hostname: "demo.example", protocol: "https:", isSecureContext: true }, true],
    [{ hostname: "localhost", protocol: "http:", isSecureContext: true }, true],
    [{ hostname: "127.0.0.1", protocol: "http:", isSecureContext: true }, true],
    [{ hostname: "[::1]", protocol: "http:", isSecureContext: true }, true],
    [{ hostname: "demo.example", protocol: "http:", isSecureContext: false }, false],
    [{ hostname: "demo.example", protocol: "https:", isSecureContext: false }, false],
    [{ hostname: "localhost.example", protocol: "http:", isSecureContext: true }, false]
  ])("allows audio transport only from HTTPS or an explicit loopback origin: %o", (context, expected) => {
    expect(isLumenAudioTransportAllowed(context)).toBe(expected);
  });
});
