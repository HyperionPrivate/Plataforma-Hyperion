import type { LumenWorklistEntry } from "@hyperion/contracts";

export function lumenWorklistForSite(
  worklist: readonly LumenWorklistEntry[],
  activeSiteId: string
): LumenWorklistEntry[] {
  return activeSiteId === "all" ? [...worklist] : worklist.filter((entry) => entry.siteId === activeSiteId);
}

export function resolveLumenEncounterSelection(
  worklist: readonly LumenWorklistEntry[],
  requestedEncounterId: string | undefined,
  currentEncounterId?: string
): string | undefined {
  if (requestedEncounterId && worklist.some((entry) => entry.encounterId === requestedEncounterId)) {
    return requestedEncounterId;
  }
  if (currentEncounterId && worklist.some((entry) => entry.encounterId === currentEncounterId)) {
    return currentEncounterId;
  }
  return worklist[0]?.encounterId;
}

export function isCurrentLumenEncounter(targetEncounterId: string, currentEncounterId: string | undefined): boolean {
  return targetEncounterId === currentEncounterId;
}
