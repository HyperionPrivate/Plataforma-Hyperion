import { describe, expect, it } from "vitest";
import {
  LUMEN_MAX_RECORDING_SECONDS,
  clampLumenRecordingDuration,
  lumenRecordingReachedLimit
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
});
