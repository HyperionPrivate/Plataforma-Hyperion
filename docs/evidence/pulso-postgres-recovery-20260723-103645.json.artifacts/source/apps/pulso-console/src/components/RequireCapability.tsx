import type { ReactNode } from "react";
import { useConsole } from "../lib/context.js";
import { can, type Capability } from "../lib/rbac.js";
import { hasPulsoCapability } from "../lib/session.js";
import { EmptyState } from "./ui.js";

export function RequireCapability({ capability, children }: { capability: Capability; children: ReactNode }) {
  const { session, grant } = useConsole();
  const productCapability = capability.startsWith("write:") ? "pulso:write" : "pulso:read";
  if (!can(session.operator.role, capability) || !hasPulsoCapability(grant, productCapability)) {
    return <EmptyState label="No tienes permisos para ver esta seccion." />;
  }

  return <>{children}</>;
}
