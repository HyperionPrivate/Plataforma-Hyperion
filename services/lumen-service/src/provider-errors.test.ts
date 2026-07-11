import { describe, expect, it } from "vitest";
import { isSpeechToTextError, SpeechToTextError, speechToTextErrorCodes } from "./provider-errors.js";

describe("speech-to-text provider errors", () => {
  it("carries only explicit, categorized boundary metadata", () => {
    const error = new SpeechToTextError("rate_limited", "Provider rate limit was reached", {
      provider: "elevenlabs",
      retryable: true,
      statusCode: 429,
      temporaryAudioDeleted: true
    });

    expect(isSpeechToTextError(error)).toBe(true);
    expect(error).toMatchObject({
      name: "SpeechToTextError",
      code: "rate_limited",
      provider: "elevenlabs",
      retryable: true,
      statusCode: 429,
      temporaryAudioDeleted: true
    });
    expect(speechToTextErrorCodes).toContain(error.code);
  });

  it("does not mistake arbitrary provider-shaped objects for trusted errors", () => {
    expect(isSpeechToTextError({ code: "network", message: "forged" })).toBe(false);
  });
});
