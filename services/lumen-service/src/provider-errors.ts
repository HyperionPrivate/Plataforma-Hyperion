export const speechToTextErrorCodes = [
  "not_configured",
  "invalid_audio",
  "unsupported_media_type",
  "audio_too_large",
  "audio_too_long",
  "cancelled",
  "timeout",
  "authentication",
  "rate_limited",
  "provider_rejected",
  "provider_unavailable",
  "network",
  "invalid_response",
  "temporary_storage"
] as const;

export type SpeechToTextErrorCode = (typeof speechToTextErrorCodes)[number];

export interface SpeechToTextErrorOptions {
  provider?: string;
  retryable?: boolean;
  statusCode?: number;
  temporaryAudioDeleted?: boolean | null;
  cause?: unknown;
}

/**
 * A provider error whose message is safe to expose to the service boundary.
 *
 * Never pass response bodies, credentials, transcripts, audio data or raw
 * transport errors as `message`. The original error may be retained as `cause`
 * for in-process classification, but callers must not serialize it.
 */
export class SpeechToTextError extends Error {
  readonly code: SpeechToTextErrorCode;
  readonly provider: string | null;
  readonly retryable: boolean;
  readonly statusCode: number | null;
  readonly temporaryAudioDeleted: boolean | null;

  constructor(code: SpeechToTextErrorCode, message: string, options: SpeechToTextErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SpeechToTextError";
    this.code = code;
    this.provider = options.provider ?? null;
    this.retryable = options.retryable ?? false;
    this.statusCode = options.statusCode ?? null;
    this.temporaryAudioDeleted = options.temporaryAudioDeleted ?? null;
  }
}

export function isSpeechToTextError(error: unknown): error is SpeechToTextError {
  return error instanceof SpeechToTextError;
}
