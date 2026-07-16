import { createContext, useContext } from "react";
import type { PulsoIrisSite } from "@hyperion/contracts";
import type { StoredSession } from "./session.js";

export interface TenantInfo {
  id: string;
  slug: string;
  displayName: string;
}

export interface ConsoleContextValue {
  session: StoredSession;
  tenant: TenantInfo;
  tenants: TenantInfo[];
  sites: PulsoIrisSite[];
  activeSiteId: string | "all";
  setActiveSiteId: (siteId: string | "all") => void;
  logout: () => void;
}

export const ConsoleContext = createContext<ConsoleContextValue | undefined>(undefined);

export function useConsole(): ConsoleContextValue {
  const value = useContext(ConsoleContext);
  if (!value) {
    throw new Error("useConsole must be used within the console layout");
  }
  return value;
}

/** Prefijo de rutas de PULSO IRIS para el tenant activo. */
export function tenantPath(tenantId: string, suffix: string): string {
  return `/v1/tenants/${tenantId}/pulso-iris/${suffix}`;
}

export function lumenPath(tenantId: string, suffix: string): string {
  return `/v1/tenants/${tenantId}/lumen/${suffix}`;
}

export function novaPath(tenantId: string, suffix: string): string {
  return `/v1/tenants/${tenantId}/nova/${suffix}`;
}

export function voicePath(tenantId: string, suffix: string): string {
  return `/v1/tenants/${tenantId}/voice/${suffix}`;
}

export function liwaPath(tenantId: string, suffix: string): string {
  return `/v1/tenants/${tenantId}/liwa/${suffix}`;
}

export function documentsPath(tenantId: string, suffix: string): string {
  return `/v1/tenants/${tenantId}/documents/${suffix}`;
}
