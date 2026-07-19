import type { LumenWorklistEntry } from "@hyperion/lumen-contracts";

export function lumenWorklistForFacility(
  worklist: readonly LumenWorklistEntry[],
  activeFacilityId: string
): LumenWorklistEntry[] {
  return activeFacilityId === "all" ? [...worklist] : worklist.filter((entry) => entry.siteId === activeFacilityId);
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
