export const LUMEN_MAX_RECORDING_SECONDS = 90;
export const LUMEN_MAX_AUDIO_BYTES = 5 * 1024 * 1024;

export const LUMEN_ALLOWED_AUDIO_MIME_TYPES = [
  "audio/aac",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm"
] as const;

export type LumenAudioValidationCode = "invalid_mime" | "invalid_size" | "invalid_duration";

export interface LumenAudioValidationResult {
  valid: boolean;
  code?: LumenAudioValidationCode;
  mimeType?: string;
  durationSeconds?: number;
}

export interface LumenIdempotencySlot {
  fingerprint: string;
  key: string;
}

export interface LumenAudioTransportContext {
  hostname: string;
  protocol: string;
  isSecureContext: boolean;
}

export type LumenIdempotencyFailure =
  { kind: "abort" } | { kind: "transport" } | { kind: "api"; status: number; message: string };

const LUMEN_AUDIO_MIME_ALIASES: Readonly<Record<string, (typeof LUMEN_ALLOWED_AUDIO_MIME_TYPES)[number]>> = {
  "audio/mp3": "audio/mpeg",
  "audio/m4a": "audio/mp4",
  "audio/x-m4a": "audio/mp4",
  "audio/vnd.wave": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/x-wav": "audio/wav"
};

/** Returns only the canonical base MIME; codec and casing variations never reach the API. */
export function normalizeLumenAudioMimeType(mimeType: string): string {
  const baseMimeType = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return LUMEN_AUDIO_MIME_ALIASES[baseMimeType] ?? baseMimeType;
}

export function validateLumenAudio(input: {
  mimeType: string;
  size: number;
  durationSeconds?: number;
}): LumenAudioValidationResult {
  const mimeType = normalizeLumenAudioMimeType(input.mimeType);
  if (!LUMEN_ALLOWED_AUDIO_MIME_TYPES.includes(mimeType as (typeof LUMEN_ALLOWED_AUDIO_MIME_TYPES)[number])) {
    return { valid: false, code: "invalid_mime" };
  }
  if (!Number.isFinite(input.size) || input.size <= 0 || input.size > LUMEN_MAX_AUDIO_BYTES) {
    return { valid: false, code: "invalid_size" };
  }
  if (input.durationSeconds !== undefined) {
    if (
      !Number.isFinite(input.durationSeconds) ||
      input.durationSeconds <= 0 ||
      input.durationSeconds > LUMEN_MAX_RECORDING_SECONDS
    ) {
      return { valid: false, code: "invalid_duration" };
    }
    return {
      valid: true,
      mimeType,
      durationSeconds: clampLumenRecordingDuration(input.durationSeconds)
    };
  }
  return { valid: true, mimeType };
}

export function clampLumenRecordingDuration(seconds: number): number {
  if (!Number.isFinite(seconds)) return 1;
  return Math.max(1, Math.min(LUMEN_MAX_RECORDING_SECONDS, Math.round(seconds)));
}

export function lumenRecordingReachedLimit(seconds: number): boolean {
  return seconds >= LUMEN_MAX_RECORDING_SECONDS;
}

export function createLumenIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function resolveLumenIdempotencySlot(
  current: LumenIdempotencySlot | undefined,
  fingerprint: string,
  keyFactory: () => string = createLumenIdempotencyKey
): LumenIdempotencySlot {
  return current?.fingerprint === fingerprint ? current : { fingerprint, key: keyFactory() };
}

export function lumenShouldRetainIdempotencyKey(failure: LumenIdempotencyFailure): boolean {
  if (failure.kind === "abort" || failure.kind === "transport") return true;
  if (failure.status === 503) return true;
  return failure.status === 409 && failure.message.toLowerCase().includes("already in progress");
}

export function resolveLumenIdempotencySlotAfterFailure(
  current: LumenIdempotencySlot | undefined,
  failure: LumenIdempotencyFailure
): LumenIdempotencySlot | undefined {
  return lumenShouldRetainIdempotencyKey(failure) ? current : undefined;
}

/** Audio may leave the browser only from HTTPS or an explicit loopback origin. */
export function isLumenAudioTransportAllowed(context: LumenAudioTransportContext): boolean {
  const hostname = context.hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  return loopback || (context.protocol === "https:" && context.isSecureContext);
}

export function lumenStructurePayloadFingerprint(input: {
  scope: string;
  dictationId?: string;
  transcript: string;
}): string {
  return JSON.stringify([input.scope, input.dictationId ?? null, input.transcript.trim()]);
}

export async function lumenAudioPayloadFingerprint(input: {
  scope: string;
  audioBase64: string;
  mimeType: string;
  source: string;
  durationSeconds: number;
}): Promise<string> {
  const value = `${JSON.stringify([
    input.scope,
    input.mimeType,
    input.source,
    input.durationSeconds
  ])}\0${input.audioBase64}`;
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  return fallbackPayloadFingerprint(value);
}

/** Reads the browser-decoded duration without uploading or retaining the audio. */
export function measureLumenAudioDuration(blob: Blob, signal?: AbortSignal): Promise<number> {
  if (signal?.aborted) return Promise.reject(abortError());

  return new Promise<number>((resolve, reject) => {
    const audio = document.createElement("audio");
    const objectUrl = URL.createObjectURL(blob);
    let settled = false;

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
      audio.removeEventListener("loadedmetadata", onMetadata);
      audio.removeEventListener("durationchange", onMetadata);
      audio.removeEventListener("seeked", onMetadata);
      audio.removeEventListener("timeupdate", onMetadata);
      audio.removeEventListener("error", onError);
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(objectUrl);
    };
    const finish = (work: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      work();
    };
    const onMetadata = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        finish(() => resolve(audio.duration));
        return;
      }
      // Some WebM files initially expose Infinity until the browser seeks to their final cue.
      if (audio.duration === Number.POSITIVE_INFINITY && audio.seekable.length === 0) {
        audio.currentTime = Number.MAX_SAFE_INTEGER;
      }
    };
    const onError = () => finish(() => reject(new Error("audio_metadata_unavailable")));
    const onAbort = () => finish(() => reject(abortError()));
    const timeoutId = window.setTimeout(() => finish(() => reject(new Error("audio_metadata_timeout"))), 10_000);

    signal?.addEventListener("abort", onAbort, { once: true });
    audio.preload = "metadata";
    audio.addEventListener("loadedmetadata", onMetadata);
    audio.addEventListener("durationchange", onMetadata);
    audio.addEventListener("seeked", onMetadata);
    audio.addEventListener("timeupdate", onMetadata);
    audio.addEventListener("error", onError, { once: true });
    audio.src = objectUrl;
    audio.load();
  });
}

function abortError(): DOMException {
  return new DOMException("Operation aborted", "AbortError");
}

function fallbackPayloadFingerprint(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ (code + index), 0x85ebca6b);
  }
  return `fallback:${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}:${value.length}`;
}
