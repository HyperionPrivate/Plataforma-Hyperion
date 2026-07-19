import { createContext, useContext } from "react";
import type { PulsoIrisSite } from "@hyperion/pulso-contracts";
import type { PulsoGrant, PulsoSession } from "./session.js";

export interface TenantInfo {
  id: string;
  displayName: string;
}
export interface ConsoleContextValue {
  session: PulsoSession;
  grant: PulsoGrant;
  tenant: TenantInfo;
  sites: PulsoIrisSite[];
  activeSiteId: string | "all";
  setActiveSiteId: (siteId: string | "all") => void;
  logout: () => void;
}

export const ConsoleContext = createContext<ConsoleContextValue | undefined>(undefined);
export function useConsole(): ConsoleContextValue {
  const value = useContext(ConsoleContext);
  if (!value) throw new Error("useConsole must be used within the PULSO console");
  return value;
}

export function tenantPath(tenantId: string, suffix: string): string {
  return `/v1/tenants/${encodeURIComponent(tenantId)}/pulso-iris/${suffix}`;
}
