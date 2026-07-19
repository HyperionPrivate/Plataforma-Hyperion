import type { LumenWorklistEntry } from "@hyperion/lumen-contracts";
import { createContext, useContext } from "react";
import type { ClinicalTenant, LumenGrant, LumenSession } from "./session.js";

export interface ClinicalFacility {
  id: string;
  name: string;
}

export interface LumenContextValue {
  session: LumenSession;
  grant: LumenGrant;
  tenant: ClinicalTenant;
  facilities: ClinicalFacility[];
  activeFacilityId: string | "all";
  setActiveFacilityId: (facilityId: string | "all") => void;
  replaceClinicalFacilities: (facilities: ClinicalFacility[]) => void;
  logout: () => void;
}

export const LumenContext = createContext<LumenContextValue | undefined>(undefined);

export function useLumenContext(): LumenContextValue {
  const value = useContext(LumenContext);
  if (!value) throw new Error("useLumenContext must be used inside the LUMEN shell");
  return value;
}

export function lumenPath(tenantId: string, suffix: string): string {
  return `/v1/tenants/${tenantId}/lumen/${suffix}`;
}

export function clinicalFacilitiesFromWorklist(rows: readonly LumenWorklistEntry[]): ClinicalFacility[] {
  return Array.from(new Map(rows.map((row) => [row.siteId, { id: row.siteId, name: row.siteName }])).values()).sort(
    (left, right) => left.name.localeCompare(right.name, "es")
  );
}
