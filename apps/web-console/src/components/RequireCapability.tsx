import type { ReactNode } from "react";
import { useConsole } from "../lib/context.js";
import { can, type Capability } from "../lib/rbac.js";
import { EmptyState } from "./ui.js";

export function RequireCapability({ capability, children }: { capability: Capability; children: ReactNode }) {
  const { session } = useConsole();
  if (!can(session.operator.role, capability)) {
    return <EmptyState label="No tienes permisos para ver esta seccion." />;
  }

  return <>{children}</>;
}
