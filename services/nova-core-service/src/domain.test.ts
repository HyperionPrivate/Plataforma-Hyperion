import { describe, expect, it } from "vitest";
import { decideEligibility, DEFAULT_COMPLIANCE, normalizeE164, scoreContact } from "./domain.js";

describe("normalizeE164", () => {
  it("accepts canonical E.164", () => {
    expect(normalizeE164("+573001234567")).toBe("+573001234567");
  });

  it("normalizes Colombian local numbers", () => {
    expect(normalizeE164("3001234567")).toBe("+573001234567");
    expect(normalizeE164("573001234567")).toBe("+573001234567");
    expect(normalizeE164("03001234567")).toBe("+573001234567");
  });

  it("rejects invalid numbers", () => {
    expect(normalizeE164("abc")).toBeNull();
    expect(normalizeE164("+1234")).toBeNull();
  });
});

describe("decideEligibility", () => {
  it("blocks opted-out contacts", () => {
    expect(decideEligibility({ optedOut: true, at: new Date("2026-07-16T15:00:00.000Z") }).eligibility).toBe(
      "blocked_opt_out"
    );
  });

  it("blocks outside Bogota contact window", () => {
    // 02:00 UTC ≈ 21:00 Bogota (UTC-5) in July
    expect(decideEligibility({ optedOut: false, at: new Date("2026-07-16T02:00:00.000Z") }).eligibility).toBe(
      "blocked_window"
    );
  });

  it("allows inside Bogota contact window", () => {
    // 15:00 UTC ≈ 10:00 Bogota
    expect(decideEligibility({ optedOut: false, at: new Date("2026-07-16T15:00:00.000Z") }).eligibility).toBe(
      "eligible"
    );
  });

  it("blocks on holiday when respectHolidays is enabled", () => {
    const result = decideEligibility({
      optedOut: false,
      at: new Date("2026-07-16T15:00:00.000Z"),
      isHoliday: true,
      settings: DEFAULT_COMPLIANCE
    });
    expect(result).toEqual({ eligibility: "blocked_window", reason: "holiday" });
  });

  it("allows holiday when respectHolidays is disabled", () => {
    const result = decideEligibility({
      optedOut: false,
      at: new Date("2026-07-16T15:00:00.000Z"),
      isHoliday: true,
      settings: { ...DEFAULT_COMPLIANCE, respectHolidays: false }
    });
    expect(result.eligibility).toBe("eligible");
  });

  it("blocks when max attempts reached", () => {
    const result = decideEligibility({
      optedOut: false,
      at: new Date("2026-07-16T15:00:00.000Z"),
      attemptCount: 3,
      settings: { ...DEFAULT_COMPLIANCE, maxAttemptsPerContact: 3 }
    });
    expect(result).toEqual({ eligibility: "blocked_frequency", reason: "max_attempts_reached" });
  });

  it("blocks when min hours between attempts not met", () => {
    const result = decideEligibility({
      optedOut: false,
      at: new Date("2026-07-16T15:00:00.000Z"),
      attemptCount: 1,
      hoursSinceLastAttempt: 6,
      settings: { ...DEFAULT_COMPLIANCE, minHoursBetweenAttempts: 24 }
    });
    expect(result).toEqual({ eligibility: "blocked_frequency", reason: "min_hours_between_attempts" });
  });

  it("allows when frequency gaps are satisfied", () => {
    const result = decideEligibility({
      optedOut: false,
      at: new Date("2026-07-16T15:00:00.000Z"),
      attemptCount: 1,
      hoursSinceLastAttempt: 30,
      settings: DEFAULT_COMPLIANCE
    });
    expect(result.eligibility).toBe("eligible");
  });
});

describe("scoreContact", () => {
  it("scores a tenant-defined segment with arrears toward the voice wave", () => {
    const result = scoreContact({
      segment: "priority",
      cupoPreaprobado: false,
      moraActual: 120_000,
      saldoTotal: null,
      universidad: null
    });
    expect(result.segment).toBe("priority");
    expect(result.propensity).toBeLessThan(50);
    expect(result.urgency).toBeGreaterThanOrEqual(70);
    expect(result.score).toBeGreaterThan(0.4);
    expect(result.wave).toBe("voz");
  });

  it("preserves tenant-defined segment identifiers", () => {
    expect(scoreContact({ segment: "flow-b" }).segment).toBe("flow-b");
    expect(scoreContact({ segment: "priority" }).segment).toBe("priority");
  });

  it("boosts propensity for universidad and preapproved cupo", () => {
    const base = scoreContact({ segment: "priority" });
    const boosted = scoreContact({
      segment: "priority",
      cupoPreaprobado: true,
      universidad: "UIS",
      saldoTotal: 1
    });
    expect(boosted.propensity).toBeGreaterThan(base.propensity);
    expect(boosted.urgency).toBeGreaterThan(base.urgency);
  });

  it("selects whatsapp wave when urgency and propensity are both high", () => {
    const result = scoreContact({
      segment: "priority",
      cupoPreaprobado: true,
      moraActual: 50_000,
      saldoTotal: 200_000,
      universidad: "UNAB"
    });
    expect(result.propensity).toBeGreaterThanOrEqual(50);
    expect(result.urgency).toBeGreaterThanOrEqual(50);
    expect(result.wave).toBe("whatsapp");
  });
});
