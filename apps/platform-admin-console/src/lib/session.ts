import type { AccessOperator, ProductGrant } from "@hyperion/platform-contracts";
import { platformControlTenantId } from "@hyperion/platform-contracts/platform-control";
import { api } from "./api.js";

export interface AdminSession {
  operator: AccessOperator;
  tenantIds: string[];
  grants: ProductGrant[];
}

export async function readSession(): Promise<AdminSession | undefined> {
  try {
    return await api.get<AdminSession>("/v1/auth/me");
  } catch (error) {
    if (typeof error === "object" && error && "status" in error && error.status === 401) return undefined;
    throw error;
  }
}

export async function login(email: string, password: string): Promise<AdminSession> {
  await api.post("/v1/auth/login", { email, password }, { csrf: false });
  return api.get<AdminSession>("/v1/auth/me");
}

export async function logout(): Promise<void> {
  await api.post("/v1/auth/logout").catch(() => undefined);
}

export function canAdministerPlatform(session: AdminSession): boolean {
  return session.grants.some(
    (grant) =>
      grant.active &&
      grant.tenantId === platformControlTenantId &&
      grant.productId === "PLATFORM" &&
      grant.roles.includes("platform-admin") &&
      grant.capabilities.includes("manage:platform")
  );
}
