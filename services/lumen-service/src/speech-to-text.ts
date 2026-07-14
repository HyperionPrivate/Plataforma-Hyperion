import { createHash, timingSafeEqual } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { parseBuffer } from "music-metadata";
import { SpeechToTextError, isSpeechToTextError } from "./provider-errors.js";
import { TemporaryAudioError, withTemporaryAudioFile, type TemporaryAudioCleanupState } from "./temporary-audio.js";

export const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
export const MIN_AUDIO_DURATION_SECONDS = 1;
export const MAX_AUDIO_DURATION_SECONDS = 90;
export const MAX_AUDIO_DURATION_DISCREPANCY_SECONDS = 2;
export const ELEVENLABS_STT_MODEL = "scribe_v2";
export const ELEVENLABS_STT_LANGUAGE = "spa";
export const ELEVENLABS_STT_TIMEOUT_MS = 120_000;

export interface SpeechToTextInput {
  audio: Buffer;
  mimeType: string;
  durationSeconds: number;
  audioSha256?: string;
  signal?: AbortSignal;
  /** Durable processing-attempt UUID; used only to derive the private temp directory. */
  cleanupKey?: string;
}

export interface PreparedSpeechToTextInput extends SpeechToTextInput {
  audioSha256: string;
}

export interface Base64SpeechToTextInput {
  audioBase64: string;
  mimeType: string;
  durationSeconds: number;
  audioSha256?: string;
  signal?: AbortSignal;
}

export interface SpeechToTextResult {
  transcript: string;
  provider: string;
  model: string;
  language: string;
  durationSeconds: number;
  audioSha256: string;
  requestIdHash: string | null;
  traceIdHash: string | null;
  temporaryAudioDeleted: true;
}

export interface SpeechToTextProvider {
  readonly name: string;
  readonly model: string;
  readonly language: string;
  isConfigured(): boolean;
  transcribe(input: SpeechToTextInput): Promise<SpeechToTextResult>;
}

export interface ElevenLabsSpeechToTextProviderOptions {
  apiKey?: string;
  model?: string;
  language?: string;
  timeoutMs?: number;
  zeroRetentionMode?: boolean;
  baseUrl?: string;
  tempRootDirectory?: string;
  cleanupOwner?: string;
  fetchImpl?: typeof fetch;
}

interface AudioFormat {
  extension: string;
  signature: "aac" | "mp3" | "mp4" | "ogg" | "wav" | "webm";
  opusParameterAllowed?: boolean;
}

const AUDIO_FORMATS: Readonly<Record<string, AudioFormat>> = {
  "audio/webm": { extension: "webm", signature: "webm", opusParameterAllowed: true },
  "audio/ogg": { extension: "ogg", signature: "ogg", opusParameterAllowed: true },
  "audio/mpeg": { extension: "mp3", signature: "mp3" },
  "audio/mp3": { extension: "mp3", signature: "mp3" },
  "audio/mp4": { extension: "m4a", signature: "mp4" },
  "audio/wav": { extension: "wav", signature: "wav" },
  "audio/x-wav": { extension: "wav", signature: "wav" },
  "audio/aac": { extension: "aac", signature: "aac" },
  "audio/x-m4a": { extension: "m4a", signature: "mp4" }
};

/** Strictly decodes the HTTP contract without retaining a second base64 copy. */
export function decodeBase64SpeechToTextInput(input: Base64SpeechToTextInput): PreparedSpeechToTextInput {
  const encoded = input.audioBase64;
  if (typeof encoded !== "string") {
    throw inputError("invalid_audio", "Audio payload is not valid base64");
  }

  // Reject oversized payloads before allocating their decoded representation.
  const maximumEncodedLength = 4 * Math.ceil(MAX_AUDIO_BYTES / 3);
  if (encoded.length > maximumEncodedLength) {
    throw inputError("audio_too_large", "Audio exceeds the 5 MiB limit");
  }
  if (!isCanonicalBase64(encoded)) {
    throw inputError("invalid_audio", "Audio payload is not valid base64");
  }

  const audio = Buffer.from(encoded, "base64");
  if (audio.toString("base64") !== encoded) {
    throw inputError("invalid_audio", "Audio payload is not canonical base64");
  }

  return prepareSpeechToTextInput({
    audio,
    mimeType: input.mimeType,
    durationSeconds: input.durationSeconds,
    audioSha256: input.audioSha256,
    signal: input.signal
  });
}

/** Validates size, duration, MIME, magic bytes and the optional caller hash. */
export function prepareSpeechToTextInput(input: SpeechToTextInput): PreparedSpeechToTextInput {
  if (!Buffer.isBuffer(input.audio) || input.audio.length === 0) {
    throw inputError("invalid_audio", "Audio is required");
  }
  if (input.audio.length > MAX_AUDIO_BYTES) {
    throw inputError("audio_too_large", "Audio exceeds the 5 MiB limit");
  }
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds < MIN_AUDIO_DURATION_SECONDS) {
    throw inputError("invalid_audio", "Audio duration must be at least 1 second");
  }
  if (input.durationSeconds > MAX_AUDIO_DURATION_SECONDS) {
    throw inputError("audio_too_long", "Audio exceeds the 90 second limit");
  }

  const mimeType = normalizeAudioMimeType(input.mimeType);
  const format = AUDIO_FORMATS[mimeBaseType(mimeType)]!;
  if (!matchesAudioSignature(input.audio, format.signature)) {
    throw inputError("invalid_audio", "Audio content does not match its MIME type");
  }

  const calculatedHash = audioSha256(input.audio);
  if (input.audioSha256 !== undefined) {
    const expectedHash = input.audioSha256.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedHash) || !safeHashEqual(calculatedHash, expectedHash)) {
      throw inputError("invalid_audio", "Audio hash does not match the payload");
    }
  }

  return {
    audio: input.audio,
    mimeType,
    durationSeconds: input.durationSeconds,
    audioSha256: calculatedHash,
    signal: input.signal,
    cleanupKey: input.cleanupKey
  };
}

export function normalizeAudioMimeType(value: string): string {
  if (typeof value !== "string") {
    throw inputError("unsupported_media_type", "Audio MIME type is not supported");
  }

  const parts = value
    .trim()
    .toLowerCase()
    .split(";")
    .map((part) => part.trim());
  const baseType = parts[0] ?? "";
  const format = AUDIO_FORMATS[baseType];
  if (!format) throw inputError("unsupported_media_type", "Audio MIME type is not supported");

  if (parts.length === 1) return baseType;
  if (parts.length === 2 && parts[1] === "codecs=opus" && format.opusParameterAllowed) {
    return `${baseType};codecs=opus`;
  }
  throw inputError("unsupported_media_type", "Audio MIME parameters are not supported");
}

export function audioSha256(audio: Buffer): string {
  return createHash("sha256").update(audio).digest("hex");
}

export class ElevenLabsSpeechToTextProvider implements SpeechToTextProvider {
  readonly name = "elevenlabs";
  readonly model: string;
  readonly language: string;
  private readonly apiKey: string;
  private readonly zeroRetentionMode: boolean;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly tempRootDirectory: string;
  private readonly cleanupOwner: string;
  private readonly fetchImpl: typeof fetch;
  private readonly configurationValid: boolean;

  constructor(options: ElevenLabsSpeechToTextProviderOptions = {}) {
    this.apiKey = (options.apiKey ?? process.env.ELEVENLABS_API_KEY ?? "").trim();
    this.model = (options.model ?? process.env.ELEVENLABS_STT_MODEL ?? ELEVENLABS_STT_MODEL).trim();
    this.language = (options.language ?? process.env.ELEVENLABS_STT_LANGUAGE ?? ELEVENLABS_STT_LANGUAGE).trim();
    this.zeroRetentionMode =
      options.zeroRetentionMode ?? process.env.ELEVENLABS_ZERO_RETENTION_MODE?.trim().toLowerCase() === "true";
    this.timeoutMs = options.timeoutMs ?? parseTimeout(process.env.ELEVENLABS_STT_TIMEOUT_MS);
    this.baseUrl = (options.baseUrl ?? "https://api.elevenlabs.io").replace(/\/+$/, "");
    this.tempRootDirectory =
      options.tempRootDirectory ?? process.env.LUMEN_AUDIO_TEMP_DIR?.trim() ?? join(tmpdir(), "hyperion-lumen-audio");
    this.cleanupOwner =
      options.cleanupOwner ??
      process.env.LUMEN_INSTANCE_ID?.trim() ??
      process.env.HOSTNAME?.trim() ??
      hostname().trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.configurationValid =
      this.model === ELEVENLABS_STT_MODEL &&
      this.language === ELEVENLABS_STT_LANGUAGE &&
      Number.isInteger(this.timeoutMs) &&
      this.timeoutMs > 0 &&
      this.timeoutMs <= ELEVENLABS_STT_TIMEOUT_MS &&
      Boolean(this.tempRootDirectory) &&
      /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(this.cleanupOwner);
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey) && this.zeroRetentionMode && this.configurationValid;
  }

  async transcribe(input: SpeechToTextInput): Promise<SpeechToTextResult> {
    if (!this.isConfigured()) {
      throw new SpeechToTextError("not_configured", "ElevenLabs STT is not configured for zero-retention use", {
        provider: this.name
      });
    }

    const prepared = prepareSpeechToTextInput(input);
    if (prepared.signal?.aborted) throw cancelledError(this.name);

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = prepared.signal ? AbortSignal.any([prepared.signal, timeoutSignal]) : timeoutSignal;
    // No temporary file exists during local container validation.
    const cleanupState: TemporaryAudioCleanupState = { deleted: true };

    try {
      const verifiedDurationSeconds = await verifyLocalAudioDuration(prepared);
      assertRequestActive(prepared.signal, timeoutSignal, this.name);
      const pendingResult = await withTemporaryAudioFile(
        prepared.audio,
        {
          rootDirectory: this.tempRootDirectory,
          extension: AUDIO_FORMATS[mimeBaseType(prepared.mimeType)]!.extension,
          cleanupOwner: this.cleanupOwner,
          cleanupKey: prepared.cleanupKey ?? "",
          cleanupState
        },
        async (temporaryAudio) => {
          assertRequestActive(prepared.signal, timeoutSignal, this.name);
          const stagedAudio = await temporaryAudio.read();
          assertRequestActive(prepared.signal, timeoutSignal, this.name);

          const form = new FormData();
          form.append(
            "file",
            new Blob([Uint8Array.from(stagedAudio)], { type: prepared.mimeType }),
            temporaryAudio.fileName
          );
          form.append("model_id", this.model);
          form.append("language_code", this.language);
          form.append("timestamps_granularity", "word");
          form.append("num_speakers", "1");
          form.append("diarize", "false");
          form.append("tag_audio_events", "false");
          form.append("no_verbatim", "false");

          let response: Response;
          try {
            response = await this.fetchImpl(`${this.baseUrl}/v1/speech-to-text?enable_logging=false`, {
              method: "POST",
              headers: { "xi-api-key": this.apiKey },
              body: form,
              signal: requestSignal
            });
          } catch {
            if (prepared.signal?.aborted) throw cancelledError(this.name);
            if (timeoutSignal.aborted) throw timeoutError(this.name);
            throw new SpeechToTextError("network", "ElevenLabs STT transport failed", {
              provider: this.name,
              retryable: true
            });
          }

          if (!response.ok) throw providerHttpError(response.status, this.name);
          let transcription: { transcript: string; durationSeconds: number };
          try {
            transcription = await readTranscription(response, this.name, verifiedDurationSeconds);
          } catch (error) {
            if (prepared.signal?.aborted) throw cancelledError(this.name);
            if (timeoutSignal.aborted) throw timeoutError(this.name);
            throw error;
          }
          assertRequestActive(prepared.signal, timeoutSignal, this.name);
          return {
            transcript: transcription.transcript,
            provider: this.name,
            model: this.model,
            language: this.language,
            durationSeconds: verifiedDurationSeconds,
            audioSha256: prepared.audioSha256,
            requestIdHash: hashOpaqueIdentifier(response.headers.get("request-id")),
            traceIdHash: hashOpaqueIdentifier(response.headers.get("x-trace-id"))
          };
        }
      );

      // This line is reached only after withTemporaryAudioFile's cleanup succeeds.
      return { ...pendingResult, temporaryAudioDeleted: true };
    } catch (error) {
      if (isSpeechToTextError(error)) throw speechToTextErrorWithCleanupState(error, cleanupState.deleted);
      if (error instanceof TemporaryAudioError) {
        throw new SpeechToTextError("temporary_storage", "Private temporary audio handling failed", {
          provider: this.name,
          retryable: error.operation === "cleanup",
          temporaryAudioDeleted: cleanupState.deleted
        });
      }
      throw new SpeechToTextError("provider_unavailable", "ElevenLabs STT request failed", {
        provider: this.name,
        retryable: true,
        temporaryAudioDeleted: cleanupState.deleted
      });
    }
  }
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return ELEVENLABS_STT_TIMEOUT_MS;
  return Number(value);
}

async function verifyLocalAudioDuration(input: PreparedSpeechToTextInput): Promise<number> {
  let durationSeconds: unknown;
  try {
    const metadata = await parseBuffer(
      input.audio,
      { mimeType: mimeBaseType(input.mimeType), size: input.audio.length },
      { duration: true, skipCovers: true }
    );
    durationSeconds = metadata.format.duration;
  } catch {
    throw inputError("invalid_audio", "Audio container could not be validated");
  }

  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw inputError("invalid_audio", "Audio duration could not be determined");
  }
  if (durationSeconds < MIN_AUDIO_DURATION_SECONDS) {
    throw inputError("invalid_audio", "Audio duration must be at least 1 second");
  }
  if (durationSeconds > MAX_AUDIO_DURATION_SECONDS) {
    throw inputError("audio_too_long", "Audio exceeds the 90 second limit");
  }
  if (Math.abs(durationSeconds - input.durationSeconds) > MAX_AUDIO_DURATION_DISCREPANCY_SECONDS) {
    throw inputError("invalid_audio", "Audio duration does not match the authorized recording");
  }
  return Math.round(durationSeconds * 1_000) / 1_000;
}

function inputError(
  code: "invalid_audio" | "unsupported_media_type" | "audio_too_large" | "audio_too_long",
  message: string
) {
  return new SpeechToTextError(code, message);
}

function speechToTextErrorWithCleanupState(error: SpeechToTextError, deleted: boolean | null): SpeechToTextError {
  return new SpeechToTextError(error.code, error.message, {
    provider: error.provider ?? undefined,
    retryable: error.retryable,
    statusCode: error.statusCode ?? undefined,
    temporaryAudioDeleted: deleted
  });
}

function mimeBaseType(mimeType: string): string {
  return mimeType.split(";", 1)[0]!;
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function matchesAudioSignature(audio: Buffer, signature: AudioFormat["signature"]): boolean {
  if (signature === "webm") return startsWith(audio, [0x1a, 0x45, 0xdf, 0xa3]);
  if (signature === "ogg") return startsWith(audio, [0x4f, 0x67, 0x67, 0x53]);
  if (signature === "wav") {
    return startsWith(audio, [0x52, 0x49, 0x46, 0x46]) && bytesAt(audio, 8, [0x57, 0x41, 0x56, 0x45]);
  }
  if (signature === "mp4") return bytesAt(audio, 4, [0x66, 0x74, 0x79, 0x70]);
  if (signature === "aac") return isAdtsFrame(audio);
  return startsWith(audio, [0x49, 0x44, 0x33]) || isMpegAudioFrame(audio);
}

function startsWith(buffer: Buffer, signature: readonly number[]): boolean {
  return bytesAt(buffer, 0, signature);
}

function bytesAt(buffer: Buffer, offset: number, signature: readonly number[]): boolean {
  return (
    buffer.length >= offset + signature.length && signature.every((byte, index) => buffer[offset + index] === byte)
  );
}

function isAdtsFrame(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0xff && (buffer[1]! & 0xf6) === 0xf0;
}

function isMpegAudioFrame(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0 && (buffer[1]! & 0x06) !== 0;
}

function safeHashEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function hashOpaqueIdentifier(value: string | null): string | null {
  const identifier = value?.trim();
  if (!identifier) return null;
  return createHash("sha256").update(identifier).digest("hex");
}

function assertRequestActive(
  externalSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
  provider: string
): void {
  if (externalSignal?.aborted) throw cancelledError(provider);
  if (timeoutSignal.aborted) throw timeoutError(provider);
}

function cancelledError(provider: string): SpeechToTextError {
  return new SpeechToTextError("cancelled", "ElevenLabs STT request was cancelled", {
    provider,
    retryable: true
  });
}

function timeoutError(provider: string): SpeechToTextError {
  return new SpeechToTextError("timeout", "ElevenLabs STT request timed out", {
    provider,
    retryable: true
  });
}

function providerHttpError(statusCode: number, provider: string): SpeechToTextError {
  if (statusCode === 401 || statusCode === 403) {
    return new SpeechToTextError("authentication", "ElevenLabs STT authentication failed", {
      provider,
      statusCode
    });
  }
  if (statusCode === 429) {
    return new SpeechToTextError("rate_limited", "ElevenLabs STT rate limit was reached", {
      provider,
      statusCode,
      retryable: true
    });
  }
  if (statusCode >= 500 || statusCode === 408) {
    return new SpeechToTextError("provider_unavailable", "ElevenLabs STT is temporarily unavailable", {
      provider,
      statusCode,
      retryable: true
    });
  }
  return new SpeechToTextError("provider_rejected", "ElevenLabs STT rejected the audio request", {
    provider,
    statusCode
  });
}

async function readTranscription(
  response: Response,
  provider: string,
  declaredDurationSeconds: number
): Promise<{ transcript: string; durationSeconds: number }> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new SpeechToTextError("invalid_response", "ElevenLabs STT returned an invalid response", {
      provider
    });
  }

  if (!isRecord(payload) || typeof payload.text !== "string") {
    throw new SpeechToTextError("invalid_response", "ElevenLabs STT response is missing a transcript", { provider });
  }
  const transcript = payload.text.trim();
  if (!transcript || transcript.length > 200_000) {
    throw new SpeechToTextError("invalid_response", "ElevenLabs STT returned an invalid transcript", { provider });
  }

  const durationSeconds = deriveTimestampDuration(payload.words, provider);
  if (durationSeconds > MAX_AUDIO_DURATION_SECONDS) {
    throw new SpeechToTextError("audio_too_long", "Audio exceeds the 90 second limit", { provider });
  }
  // Word timestamps exclude some leading/trailing silence, so this secondary
  // provider check deliberately allows a slightly wider skew than the local
  // container-vs-browser validation performed before upload.
  if (Math.abs(durationSeconds - declaredDurationSeconds) > 5) {
    throw new SpeechToTextError("invalid_response", "ElevenLabs STT returned inconsistent word timestamps", {
      provider
    });
  }

  return { transcript, durationSeconds };
}

function deriveTimestampDuration(words: unknown, provider: string): number {
  if (!Array.isArray(words) || words.length === 0) {
    throw invalidTimestampResponse(provider);
  }

  let maximumEnd = 0;
  for (const word of words) {
    if (
      !isRecord(word) ||
      typeof word.start !== "number" ||
      !Number.isFinite(word.start) ||
      word.start < 0 ||
      typeof word.end !== "number" ||
      !Number.isFinite(word.end) ||
      word.end <= 0 ||
      word.end < word.start
    ) {
      throw invalidTimestampResponse(provider);
    }
    maximumEnd = Math.max(maximumEnd, word.end);
  }

  if (!Number.isFinite(maximumEnd) || maximumEnd <= 0) throw invalidTimestampResponse(provider);
  return Math.round(maximumEnd * 1_000) / 1_000;
}

function invalidTimestampResponse(provider: string): SpeechToTextError {
  return new SpeechToTextError("invalid_response", "ElevenLabs STT response is missing valid word timestamps", {
    provider
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
