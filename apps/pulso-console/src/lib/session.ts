import type { AccessOperator } from "@hyperion/platform-contracts";
import type { PulsoCapability, PulsoGrant } from "@hyperion/pulso-contracts";
import { ApiError, SessionExpiredError, api, setCsrfToken } from "./api.js";

export type { PulsoCapability, PulsoGrant } from "@hyperion/pulso-contracts";

export interface SessionTenant {
  id: string;
  displayName: string;
}

export interface PulsoSession {
  operator: AccessOperator;
  tenants: SessionTenant[];
  grants: PulsoGrant[];
  csrfToken: string;
}

export async function readSession(): Promise<PulsoSession | undefined> {
  try {
    const session = await api.get<PulsoSession>("/v1/auth/session");
    setCsrfToken(session.csrfToken);
    return session;
  } catch (error) {
    if (error instanceof SessionExpiredError || (error instanceof ApiError && error.status === 401)) return undefined;
    throw error;
  }
}

export async function login(email: string, password: string): Promise<PulsoSession> {
  await api.post("/v1/auth/login", { email, password }, { csrf: false });
  const session = await api.get<PulsoSession>("/v1/auth/session");
  setCsrfToken(session.csrfToken);
  return session;
}

export async function logout(): Promise<void> {
  await api.post("/v1/auth/logout", undefined).catch(() => undefined);
  setCsrfToken(undefined);
}

export function hasPulsoCapability(grant: PulsoGrant, capability: PulsoCapability): boolean {
  return grant.capabilities.includes("pulso:admin") || grant.capabilities.includes(capability);
}

export function pulsoGrantFor(session: PulsoSession, tenantId: string): PulsoGrant | undefined {
  return session.grants.find(
    (grant) =>
      grant.tenantId === tenantId &&
      grant.active &&
      grant.productId === "PULSO_IRIS" &&
      hasPulsoCapability(grant, "pulso:read")
  );
}
