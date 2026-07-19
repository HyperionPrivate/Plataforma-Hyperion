const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const BOGOTA_TIMEZONE = "America/Bogota";

export type EligibilityDecision =
  "eligible" | "blocked_window" | "blocked_opt_out" | "blocked_policy" | "blocked_frequency";

export interface EligibilityResult {
  eligibility: EligibilityDecision;
  reason?: string;
}

export interface ComplianceSettings {
  windowStartHour: number;
  windowEndHour: number;
  voiceEnabled: boolean;
  whatsappEnabled: boolean;
  maxAttemptsPerContact: number;
  minHoursBetweenAttempts: number;
  respectHolidays: boolean;
}

export const DEFAULT_COMPLIANCE: ComplianceSettings = {
  windowStartHour: 8,
  windowEndHour: 20,
  voiceEnabled: true,
  whatsappEnabled: true,
  maxAttemptsPerContact: 3,
  minHoursBetweenAttempts: 24,
  respectHolidays: true
};

/** Normalizes common phone inputs to E.164 or returns null when invalid. */
export function normalizeE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let candidate = trimmed.replace(/[\s().-]/g, "");
  if (!candidate.startsWith("+")) {
    if (/^0\d{10}$/.test(candidate)) {
      candidate = `+57${candidate.slice(1)}`;
    } else if (/^57\d{10}$/.test(candidate)) {
      candidate = `+${candidate}`;
    } else if (/^\d{10}$/.test(candidate)) {
      candidate = `+57${candidate}`;
    } else {
      return null;
    }
  }

  candidate = `+${candidate.slice(1).replace(/\D/g, "")}`;
  return E164_PATTERN.test(candidate) ? candidate : null;
}

export function decideEligibility(input: {
  optedOut: boolean;
  at?: Date;
  channel?: "voice" | "whatsapp";
  settings?: ComplianceSettings;
  isHoliday?: boolean;
  attemptCount?: number;
  hoursSinceLastAttempt?: number | null;
  rneBlocked?: boolean;
}): EligibilityResult {
  const settings = input.settings ?? DEFAULT_COMPLIANCE;
  const channel = input.channel ?? "voice";

  if (input.optedOut) {
    return { eligibility: "blocked_opt_out", reason: "opt_out_suppressed" };
  }
  if (input.rneBlocked) {
    return { eligibility: "blocked_policy", reason: "rne_excluded" };
  }
  if (channel === "voice" && !settings.voiceEnabled) {
    return { eligibility: "blocked_policy", reason: "channel_disabled_voz" };
  }
  if (channel === "whatsapp" && !settings.whatsappEnabled) {
    return { eligibility: "blocked_policy", reason: "channel_disabled_whatsapp" };
  }
  if (settings.respectHolidays && input.isHoliday) {
    return { eligibility: "blocked_window", reason: "holiday" };
  }

  const hour = hourInTimeZone(input.at ?? new Date(), BOGOTA_TIMEZONE);
  if (hour < settings.windowStartHour || hour >= settings.windowEndHour) {
    return {
      eligibility: "blocked_window",
      reason: `outside_contact_window_${settings.windowStartHour}_${settings.windowEndHour}`
    };
  }

  if (typeof input.attemptCount === "number" && input.attemptCount >= settings.maxAttemptsPerContact) {
    return { eligibility: "blocked_frequency", reason: "max_attempts_reached" };
  }

  if (
    typeof input.hoursSinceLastAttempt === "number" &&
    input.hoursSinceLastAttempt < settings.minHoursBetweenAttempts
  ) {
    return { eligibility: "blocked_frequency", reason: "min_hours_between_attempts" };
  }

  return { eligibility: "eligible" };
}

export interface ScoreFeatures {
  segment?: string | null;
  cupoPreaprobado?: boolean | null;
  moraActual?: number | null;
  saldoTotal?: number | null;
  universidad?: string | null;
}

export interface ScoreResult {
  propensity: number;
  urgency: number;
  score: number;
  segment: string;
  wave: "voz" | "whatsapp" | "mixto";
}

/** Rule-based scoring v1 (real features; replaces pilot hash demo). */
export function scoreContact(features: ScoreFeatures): ScoreResult {
  const segment = normalizeSegment(features.segment);
  let propensity = 40;
  let urgency = 35;

  if (features.cupoPreaprobado) propensity += 25;
  if (features.universidad) propensity += 10;
  if ((features.saldoTotal ?? 0) > 0) propensity += 8;

  if (segment) urgency += 15;
  if ((features.moraActual ?? 0) > 0) urgency += 20;
  if (features.universidad) urgency += 8;

  propensity = Math.min(100, propensity);
  urgency = Math.min(100, urgency);
  const score = Number(((propensity * 0.55 + urgency * 0.45) / 100).toFixed(4));

  let wave: ScoreResult["wave"] = "mixto";
  if (urgency >= 50 && propensity < 50) wave = "voz";
  else if (urgency >= 50 && propensity >= 50) wave = "whatsapp";

  return { propensity, urgency, score, segment, wave };
}

export function normalizeSegment(raw?: string | null): string {
  return (raw ?? "").trim();
}

function hourInTimeZone(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hour12: false
  }).formatToParts(at);
  const hourPart = parts.find((part) => part.type === "hour")?.value;
  const hour = Number(hourPart);
  return Number.isFinite(hour) ? hour : 0;
}
