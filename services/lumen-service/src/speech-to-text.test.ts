import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpeechToTextError } from "./provider-errors.js";
import {
  audioSha256,
  decodeBase64SpeechToTextInput,
  ELEVENLABS_STT_LANGUAGE,
  ELEVENLABS_STT_MODEL,
  ElevenLabsSpeechToTextProvider,
  MAX_AUDIO_BYTES,
  normalizeAudioMimeType,
  prepareSpeechToTextInput,
  type ElevenLabsSpeechToTextProviderOptions,
  type SpeechToTextInput
} from "./speech-to-text.js";

const cleanupDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(cleanupDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function newTempRoot(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "lumen-stt-test-"));
  cleanupDirectories.push(parent);
  return join(parent, "audio");
}

function fixtureFor(mimeType = "audio/webm"): Buffer {
  const baseType = mimeType.split(";", 1)[0];
  if (baseType === "audio/webm") return Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81, 0x01]);
  if (baseType === "audio/ogg") return Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]);
  if (baseType === "audio/wav" || baseType === "audio/x-wav") {
    return Buffer.from([0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]);
  }
  if (baseType === "audio/mp4" || baseType === "audio/x-m4a") {
    return Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
  }
  if (baseType === "audio/aac") return Buffer.from([0xff, 0xf1, 0x50, 0x80]);
  return Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
}

function validWavFixture(durationSeconds = 12.5): Buffer {
  const sampleRate = 8_000;
  const channels = 1;
  const bytesPerSample = 2;
  const sampleCount = Math.round(sampleRate * durationSeconds);
  const dataSize = sampleCount * channels * bytesPerSample;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  wav.writeUInt16LE(channels * bytesPerSample, 32);
  wav.writeUInt16LE(bytesPerSample * 8, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataSize, 40);
  return wav;
}

function input(overrides: Partial<SpeechToTextInput> = {}): SpeechToTextInput {
  return {
    audio: validWavFixture(),
    mimeType: "audio/wav",
    durationSeconds: 12.5,
    cleanupKey: randomUUID(),
    ...overrides
  };
}

function providerOptions(
  tempRootDirectory: string,
  fetchImpl: typeof fetch,
  overrides: Partial<ElevenLabsSpeechToTextProviderOptions> = {}
): ElevenLabsSpeechToTextProviderOptions {
  return {
    apiKey: "authorized-test-key",
    model: ELEVENLABS_STT_MODEL,
    language: ELEVENLABS_STT_LANGUAGE,
    zeroRetentionMode: true,
    // Full-workspace CI runs this suite under CPU contention; keep ordinary
    // success/error cases well clear of the dedicated 15 ms timeout tests.
    timeoutMs: 10_000,
    baseUrl: "https://api.elevenlabs.test",
    tempRootDirectory,
    cleanupOwner: "lumen-stt-test-1",
    fetchImpl,
    ...overrides
  };
}

function successResponse(text = "Presión intraocular catorce en ojo derecho.", durationSeconds = 12.25): Response {
  return new Response(
    JSON.stringify({
      text,
      language_code: "spa",
      language_probability: 0.99,
      words: [{ text, start: 0, end: durationSeconds, type: "word", speaker_id: "speaker_0" }]
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "request-id": "provider-request-123",
        "x-trace-id": "provider-trace-456"
      }
    }
  );
}

async function caught(promise: Promise<unknown>): Promise<SpeechToTextError> {
  const error = await promise.catch((value: unknown) => value);
  expect(error).toBeInstanceOf(SpeechToTextError);
  return error as SpeechToTextError;
}

describe("speech-to-text audio validation", () => {
  it.each([
    "audio/webm",
    "audio/webm;codecs=opus",
    "audio/ogg",
    "audio/ogg;codecs=opus",
    "audio/mpeg",
    "audio/mp3",
    "audio/mp4",
    "audio/wav",
    "audio/x-wav",
    "audio/aac",
    "audio/x-m4a"
  ])("accepts the allowlisted MIME and matching magic bytes: %s", (mimeType) => {
    const prepared = prepareSpeechToTextInput(
      input({ audio: fixtureFor(mimeType), mimeType, durationSeconds: mimeType.length % 2 === 0 ? 1 : 90 })
    );

    expect(prepared.mimeType).toBe(mimeType);
    expect(prepared.audioSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("canonicalizes case and whitespace without accepting arbitrary MIME parameters", () => {
    expect(normalizeAudioMimeType(" Audio/WebM ; codecs=opus ")).toBe("audio/webm;codecs=opus");

    for (const mimeType of ["audio/flac", "video/webm", "audio/webm;codecs=vorbis", "audio/wav;charset=binary"]) {
      expect(() => normalizeAudioMimeType(mimeType)).toThrowError(
        expect.objectContaining({ code: "unsupported_media_type" })
      );
    }
  });

  it("rejects empty, oversized, too-short and too-long audio with stable categories", () => {
    expect(() => prepareSpeechToTextInput(input({ audio: Buffer.alloc(0) }))).toThrowError(
      expect.objectContaining({ code: "invalid_audio" })
    );
    expect(() =>
      prepareSpeechToTextInput(input({ audio: Buffer.concat([fixtureFor(), Buffer.alloc(MAX_AUDIO_BYTES)]) }))
    ).toThrowError(expect.objectContaining({ code: "audio_too_large" }));
    expect(() => prepareSpeechToTextInput(input({ durationSeconds: 0.99 }))).toThrowError(
      expect.objectContaining({ code: "invalid_audio" })
    );
    expect(() => prepareSpeechToTextInput(input({ durationSeconds: 90.01 }))).toThrowError(
      expect.objectContaining({ code: "audio_too_long" })
    );
  });

  it("rejects a MIME/signature mismatch", () => {
    expect(() =>
      prepareSpeechToTextInput(input({ audio: fixtureFor("audio/wav"), mimeType: "audio/webm" }))
    ).toThrowError(expect.objectContaining({ code: "invalid_audio", message: expect.not.stringContaining("RIFF") }));
  });

  it("computes and constant-time verifies the caller-provided audio hash", () => {
    const audio = validWavFixture();
    const hash = audioSha256(audio);

    expect(prepareSpeechToTextInput(input({ audio, audioSha256: hash.toUpperCase() })).audioSha256).toBe(hash);
    expect(() => prepareSpeechToTextInput(input({ audio, audioSha256: "0".repeat(64) }))).toThrowError(
      expect.objectContaining({ code: "invalid_audio" })
    );
    expect(audioSha256(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("strictly decodes canonical base64 once and returns a reusable hash", () => {
    const audio = fixtureFor();
    const prepared = decodeBase64SpeechToTextInput({
      audioBase64: audio.toString("base64"),
      mimeType: "audio/webm",
      durationSeconds: 4
    });

    expect(prepared.audio).toEqual(audio);
    expect(prepared.audioSha256).toBe(audioSha256(audio));
    for (const audioBase64 of ["", "not base64", "AB==", "YWJjZA"]) {
      expect(() =>
        decodeBase64SpeechToTextInput({ audioBase64, mimeType: "audio/webm", durationSeconds: 4 })
      ).toThrowError(expect.objectContaining({ code: "invalid_audio" }));
    }
  });

  it("rejects encoded input above the limit before decoding it", () => {
    const maximumEncodedLength = 4 * Math.ceil(MAX_AUDIO_BYTES / 3);
    expect(() =>
      decodeBase64SpeechToTextInput({
        audioBase64: "A".repeat(maximumEncodedLength + 4),
        mimeType: "audio/webm",
        durationSeconds: 4
      })
    ).toThrowError(expect.objectContaining({ code: "audio_too_large" }));
  });
});

describe("ElevenLabs speech-to-text provider", () => {
  it("fails closed unless the authorized zero-retention configuration is exact", async () => {
    const root = await newTempRoot();
    const fetchImpl = vi.fn(async () => successResponse()) as unknown as typeof fetch;
    const valid = providerOptions(root, fetchImpl);

    for (const overrides of [
      { apiKey: "" },
      { zeroRetentionMode: false },
      { model: "scribe_v1" },
      { language: "eng" },
      { timeoutMs: 0 },
      { timeoutMs: 120_001 },
      { tempRootDirectory: "" }
    ]) {
      const provider = new ElevenLabsSpeechToTextProvider({ ...valid, ...overrides });
      expect(provider.isConfigured()).toBe(false);
      expect(await caught(provider.transcribe(input()))).toMatchObject({
        code: "not_configured",
        temporaryAudioDeleted: null
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads the approved environment names and defaults to the required model, language and timeout", () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "environment-test-key");
    vi.stubEnv("ELEVENLABS_STT_MODEL", "scribe_v2");
    vi.stubEnv("ELEVENLABS_STT_LANGUAGE", "spa");
    vi.stubEnv("ELEVENLABS_STT_TIMEOUT_MS", "120000");
    vi.stubEnv("ELEVENLABS_ZERO_RETENTION_MODE", "true");
    vi.stubEnv("LUMEN_AUDIO_TEMP_DIR", join(tmpdir(), "environment-audio-test"));

    const provider = new ElevenLabsSpeechToTextProvider({
      fetchImpl: vi.fn() as unknown as typeof fetch
    });
    expect(provider.isConfigured()).toBe(true);
    expect(provider.model).toBe("scribe_v2");
    expect(provider.language).toBe("spa");
  });

  it("posts the official batch multipart request and returns only hashed vendor identifiers", async () => {
    const root = await newTempRoot();
    const audio = validWavFixture();
    const fetchImpl = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      expect(String(request)).toBe("https://api.elevenlabs.test/v1/speech-to-text?enable_logging=false");
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("xi-api-key")).toBe("authorized-test-key");
      expect(headers.has("authorization")).toBe(false);
      expect(headers.has("content-type")).toBe(false);

      const form = init?.body as FormData;
      expect(form).toBeInstanceOf(FormData);
      expect(form.get("model_id")).toBe("scribe_v2");
      expect(form.get("language_code")).toBe("spa");
      expect(form.get("timestamps_granularity")).toBe("word");
      expect(form.get("num_speakers")).toBe("1");
      expect(form.get("diarize")).toBe("false");
      expect(form.get("tag_audio_events")).toBe("false");
      expect(form.get("no_verbatim")).toBe("false");
      const uploadedFile = form.get("file");
      expect(uploadedFile).toBeInstanceOf(Blob);
      expect(Buffer.from(await (uploadedFile as Blob).arrayBuffer())).toEqual(audio);
      expect(await readdir(root)).toHaveLength(1);
      return successResponse();
    }) as unknown as typeof fetch;
    const provider = new ElevenLabsSpeechToTextProvider(providerOptions(root, fetchImpl));

    const result = await provider.transcribe(input({ audio }));

    expect(result).toEqual({
      transcript: "Presión intraocular catorce en ojo derecho.",
      provider: "elevenlabs",
      model: "scribe_v2",
      language: "spa",
      durationSeconds: 12.5,
      audioSha256: audioSha256(audio),
      requestIdHash: createHash("sha256").update("provider-request-123").digest("hex"),
      traceIdHash: createHash("sha256").update("provider-trace-456").digest("hex"),
      temporaryAudioDeleted: true
    });
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    [401, "authentication", false],
    [403, "authentication", false],
    [408, "provider_unavailable", true],
    [429, "rate_limited", true],
    [500, "provider_unavailable", true],
    [422, "provider_rejected", false]
  ] as const)("categorizes HTTP %s without reading its sensitive body", async (status, code, retryable) => {
    const root = await newTempRoot();
    const fetchImpl = vi.fn(
      async () => new Response("secret provider diagnostic and transcript", { status })
    ) as unknown as typeof fetch;
    const provider = new ElevenLabsSpeechToTextProvider(providerOptions(root, fetchImpl));

    const error = await caught(provider.transcribe(input()));

    expect(error).toMatchObject({ code, retryable, statusCode: status, temporaryAudioDeleted: true });
    expect(error.message).not.toContain("secret");
    expect(JSON.stringify(error)).not.toContain("transcript");
    expect(await readdir(root)).toEqual([]);
  });

  it("sanitizes transport failures and cleans temporary audio", async () => {
    const root = await newTempRoot();
    const fetchImpl = vi.fn(async () => {
      throw new Error("Bearer top-secret-key audio transcript private");
    }) as unknown as typeof fetch;
    const provider = new ElevenLabsSpeechToTextProvider(providerOptions(root, fetchImpl));

    const error = await caught(provider.transcribe(input()));

    expect(error).toMatchObject({ code: "network", retryable: true, temporaryAudioDeleted: true });
    expect(`${error.message} ${JSON.stringify(error)}`).not.toMatch(/top-secret|transcript private/i);
    expect(error.cause).toBeUndefined();
    expect(await readdir(root)).toEqual([]);
  });

  it("reports no residue when staging cannot create a request directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "lumen-stt-occupied-test-"));
    cleanupDirectories.push(parent);
    const occupiedPath = join(parent, "occupied");
    await writeFile(occupiedPath, "not-a-directory");
    const fetchImpl = vi.fn(async () => successResponse()) as unknown as typeof fetch;
    const provider = new ElevenLabsSpeechToTextProvider(providerOptions(occupiedPath, fetchImpl));

    const error = await caught(provider.transcribe(input()));

    expect(error).toMatchObject({ code: "temporary_storage", temporaryAudioDeleted: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["not-json", "invalid_response"],
    [JSON.stringify({ words: [] }), "invalid_response"],
    [JSON.stringify({ text: "   ", words: [] }), "invalid_response"],
    [JSON.stringify({ text: "Texto", words: [] }), "invalid_response"],
    [JSON.stringify({ text: "Texto", words: [{ start: 0, end: null }] }), "invalid_response"],
    [JSON.stringify({ text: "Texto", words: [{ start: 2, end: 1 }] }), "invalid_response"]
  ])("rejects malformed successful responses without leaking the body", async (body, code) => {
    const root = await newTempRoot();
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const provider = new ElevenLabsSpeechToTextProvider(providerOptions(root, fetchImpl));

    const error = await caught(provider.transcribe(input()));

    expect(error.code).toBe(code);
    expect(error.temporaryAudioDeleted).toBe(true);
    expect(error.message).not.toContain(body);
    expect(await readdir(root)).toEqual([]);
  });

  it("fails closed when provider timestamps exceed 90 seconds", async () => {
    const root = await newTempRoot();
    const fetchImpl = vi.fn(async () => successResponse("Texto largo", 90.001)) as unknown as typeof fetch;
    const provider = new ElevenLabsSpeechToTextProvider(providerOptions(root, fetchImpl));

    const error = await caught(provider.transcribe(input({ audio: validWavFixture(90), durationSeconds: 90 })));

    expect(error).toMatchObject({ code: "audio_too_long", temporaryAudioDeleted: true });
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects inconsistent provider timestamps while returning the locally verified duration", async () => {
    const root = await newTempRoot();
    const mismatchedFetch = vi.fn(async () => successResponse("Texto", 20)) as unknown as typeof fetch;
    const mismatchedProvider = new ElevenLabsSpeechToTextProvider(providerOptions(root, mismatchedFetch));

    const error = await caught(mismatchedProvider.transcribe(input({ durationSeconds: 12 })));
    expect(error).toMatchObject({ code: "invalid_response", temporaryAudioDeleted: true });

    const acceptedFetch = vi.fn(async () => successResponse("Texto", 16.999)) as unknown as typeof fetch;
    const acceptedProvider = new ElevenLabsSpeechToTextProvider(providerOptions(root, acceptedFetch));
    const result = await acceptedProvider.transcribe(input({ durationSeconds: 12 }));

    expect(result.durationSeconds).toBe(12.5);
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects locally malformed, too-long and duration-mismatched audio before fetch", async () => {
    const root = await newTempRoot();
    const fetchImpl = vi.fn(async () => successResponse()) as unknown as typeof fetch;
    const provider = new ElevenLabsSpeechToTextProvider(providerOptions(root, fetchImpl));

    const malformed = await caught(
      provider.transcribe(input({ audio: fixtureFor("audio/webm"), mimeType: "audio/webm" }))
    );
    expect(malformed).toMatchObject({ code: "invalid_audio", temporaryAudioDeleted: true });

    const tooLong = await caught(provider.transcribe(input({ audio: validWavFixture(91), durationSeconds: 90 })));
    expect(tooLong).toMatchObject({ code: "audio_too_long", temporaryAudioDeleted: true });

    const mismatched = await caught(provider.transcribe(input({ audio: validWavFixture(20), durationSeconds: 12 })));
    expect(mismatched).toMatchObject({ code: "invalid_audio", temporaryAudioDeleted: true });

    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels an in-flight provider request and cleans temporary audio", async () => {
    const root = await newTempRoot();
    const controller = new AbortController();
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => (requestStarted = resolve));
    const fetchImpl = vi.fn(async (_request: string | URL | Request, init?: RequestInit) => {
      requestStarted();
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true
        });
      });
    }) as unknown as typeof fetch;
    const provider = new ElevenLabsSpeechToTextProvider(providerOptions(root, fetchImpl));

    const transcription = provider.transcribe(input({ signal: controller.signal }));
    await started;
    expect(await readdir(root)).toHaveLength(1);
    controller.abort();
    const error = await caught(transcription);

    expect(error.code).toBe("cancelled");
    expect(error.temporaryAudioDeleted).toBe(true);
    expect(await readdir(root)).toEqual([]);
  });

  it("times out an in-flight provider request and cleans temporary audio", async () => {
    const root = await newTempRoot();
    const fetchImpl = vi.fn(async (_request: string | URL | Request, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Timed out", "TimeoutError")), {
          once: true
        });
      });
    }) as unknown as typeof fetch;
    const provider = new ElevenLabsSpeechToTextProvider(providerOptions(root, fetchImpl, { timeoutMs: 15 }));

    const error = await caught(provider.transcribe(input()));

    expect(error.code).toBe("timeout");
    expect(error.temporaryAudioDeleted).toBe(true);
    expect(await readdir(root)).toEqual([]);
  });

  it("classifies a timeout while reading the provider body and still cleans temporary audio", async () => {
    const root = await newTempRoot();
    const fetchImpl = vi.fn(async (_request: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener(
            "abort",
            () => controller.error(new DOMException("Timed out", "TimeoutError")),
            { once: true }
          );
        }
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const provider = new ElevenLabsSpeechToTextProvider(providerOptions(root, fetchImpl, { timeoutMs: 15 }));

    const error = await caught(provider.transcribe(input()));

    expect(error).toMatchObject({ code: "timeout", temporaryAudioDeleted: true });
    expect(await readdir(root)).toEqual([]);
  });

  it("honors an already-aborted caller without creating a temporary file", async () => {
    const root = await newTempRoot();
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async () => successResponse()) as unknown as typeof fetch;
    const provider = new ElevenLabsSpeechToTextProvider(providerOptions(root, fetchImpl));

    const error = await caught(provider.transcribe(input({ signal: controller.signal })));

    expect(error.code).toBe("cancelled");
    expect(error.temporaryAudioDeleted).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("isolates concurrent requests and leaves no audio behind", async () => {
    const root = await newTempRoot();
    const requestDirectoryCounts: number[] = [];
    const fetchImpl = vi.fn(async () => {
      requestDirectoryCounts.push((await readdir(root)).length);
      return successResponse();
    }) as unknown as typeof fetch;
    const provider = new ElevenLabsSpeechToTextProvider(providerOptions(root, fetchImpl));

    const [first, second] = await Promise.all([
      provider.transcribe(input()),
      provider.transcribe(input({ audio: validWavFixture(12.4), durationSeconds: 12.4 }))
    ]);

    expect(first.temporaryAudioDeleted).toBe(true);
    expect(second.temporaryAudioDeleted).toBe(true);
    expect(requestDirectoryCounts.every((count) => count >= 1)).toBe(true);
    expect(await readdir(root)).toEqual([]);
  });
});
