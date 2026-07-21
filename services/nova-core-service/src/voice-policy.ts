import { createHash } from "node:crypto";
import type { ComplianceSettings } from "./domain.js";

export interface RevisionedVoicePolicy extends ComplianceSettings {
  policyRevision: number;
}

/**
 * Hashes only dispatch-affecting policy fields in a fixed order. The revision
 * is included so an approval cannot be replayed after any policy update.
 */
export function computeVoicePolicySha256(policy: RevisionedVoicePolicy): string {
  const canonical = JSON.stringify({
    schema: "nova.voice-policy.v1",
    policy_revision: policy.policyRevision,
    window_start_hour: policy.windowStartHour,
    window_end_hour: policy.windowEndHour,
    time_zone: policy.timeZone,
    allowed_weekdays: [...policy.allowedWeekdays],
    voice_enabled: policy.voiceEnabled,
    whatsapp_enabled: policy.whatsappEnabled,
    max_attempts_per_day: policy.maxAttemptsPerDay,
    max_attempts_per_contact: policy.maxAttemptsPerContact,
    rolling_window_days: policy.rollingWindowDays,
    max_concurrent_calls: policy.maxConcurrentCalls,
    min_hours_between_attempts: policy.minHoursBetweenAttempts,
    respect_holidays: policy.respectHolidays
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
