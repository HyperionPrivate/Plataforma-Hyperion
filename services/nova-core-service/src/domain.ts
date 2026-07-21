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
  timeZone: string;
  allowedWeekdays: readonly number[];
  voiceEnabled: boolean;
  whatsappEnabled: boolean;
  maxAttemptsPerDay: number;
  maxAttemptsPerContact: number;
  rollingWindowDays: number;
  maxConcurrentCalls: number;
  minHoursBetweenAttempts: number;
  respectHolidays: boolean;
}

export const DEFAULT_COMPLIANCE: ComplianceSettings = {
  windowStartHour: 8,
  windowEndHour: 19,
  timeZone: BOGOTA_TIMEZONE,
  allowedWeekdays: [1, 2, 3, 4, 5, 6],
  voiceEnabled: true,
  whatsappEnabled: true,
  maxAttemptsPerDay: 2,
  maxAttemptsPerContact: 4,
  rollingWindowDays: 7,
  maxConcurrentCalls: 10,
  minHoursBetweenAttempts: 4,
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
  attemptsToday?: number;
  attemptCount?: number;
  activeVoiceCalls?: number;
  hoursSinceLastAttempt?: number | null;
  rneBlocked?: boolean;
  voiceSuppressed?: boolean;
}): EligibilityResult {
  const settings = input.settings ?? DEFAULT_COMPLIANCE;
  const channel = input.channel ?? "voice";

  if (input.optedOut) {
    return { eligibility: "blocked_opt_out", reason: "opt_out_suppressed" };
  }
  if (input.rneBlocked) {
    return { eligibility: "blocked_policy", reason: "rne_excluded" };
  }
  if (channel === "voice" && input.voiceSuppressed) {
    return { eligibility: "blocked_policy", reason: "whatsapp_engaged" };
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

  const local = localTimeParts(input.at ?? new Date(), settings.timeZone);
  if (!local) {
    return { eligibility: "blocked_policy", reason: "invalid_time_zone" };
  }
  if (!settings.allowedWeekdays.includes(local.weekday)) {
    return { eligibility: "blocked_window", reason: "weekday_not_allowed" };
  }

  const hour = local.hour;
  if (hour < settings.windowStartHour || hour >= settings.windowEndHour) {
    return {
      eligibility: "blocked_window",
      reason: `outside_contact_window_${settings.windowStartHour}_${settings.windowEndHour}`
    };
  }

  if (typeof input.attemptsToday === "number" && input.attemptsToday >= settings.maxAttemptsPerDay) {
    return { eligibility: "blocked_frequency", reason: "max_daily_attempts_reached" };
  }

  if (typeof input.activeVoiceCalls === "number" && input.activeVoiceCalls >= settings.maxConcurrentCalls) {
    return { eligibility: "blocked_frequency", reason: "max_concurrent_calls" };
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

function localTimeParts(at: Date, timeZone: string): { hour: number; weekday: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hour12: false,
      weekday: "short"
    }).formatToParts(at);
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const weekdayName = parts.find((part) => part.type === "weekday")?.value;
    const weekday = weekdayName ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(weekdayName) + 1 : 0;
    return Number.isFinite(hour) && weekday > 0 ? { hour, weekday } : null;
  } catch {
    return null;
  }
}
