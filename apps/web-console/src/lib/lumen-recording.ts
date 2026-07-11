export const LUMEN_MAX_RECORDING_SECONDS = 90;

export function clampLumenRecordingDuration(seconds: number): number {
  if (!Number.isFinite(seconds)) return 1;
  return Math.max(1, Math.min(LUMEN_MAX_RECORDING_SECONDS, Math.round(seconds)));
}

export function lumenRecordingReachedLimit(seconds: number): boolean {
  return seconds >= LUMEN_MAX_RECORDING_SECONDS;
}
