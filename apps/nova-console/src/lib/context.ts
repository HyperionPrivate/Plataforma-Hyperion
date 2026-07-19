import { createContext, useContext } from "react";
import type { AccessPrincipal, NovaGrant } from "./session.js";

export interface TenantInfo {
  id: string;
  displayName: string;
}

export interface NovaConsoleContextValue {
  session: AccessPrincipal;
  tenant: TenantInfo;
  tenants: TenantInfo[];
  grant: NovaGrant;
  selectTenant: (tenantId: string) => void;
  logout: () => void;
}

export const NovaConsoleContext = createContext<NovaConsoleContextValue | undefined>(undefined);

export function useNovaConsole(): NovaConsoleContextValue {
  const value = useContext(NovaConsoleContext);
  if (!value) throw new Error("useNovaConsole debe usarse dentro de NovaConsoleContext");
  return value;
}

function encodePath(suffix: string): string {
  return suffix
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function cellPath(tenantId: string, component: "nova" | "voice", suffix: string): string {
  return `/v1/tenants/${encodeURIComponent(tenantId)}/${component}/${encodePath(suffix)}`;
}

export function novaPath(tenantId: string, suffix: string): string {
  return cellPath(tenantId, "nova", suffix);
}

export function voicePath(tenantId: string, suffix: string): string {
  return cellPath(tenantId, "voice", suffix);
}
