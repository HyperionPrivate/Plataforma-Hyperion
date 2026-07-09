import type { OperatorRole } from "@hyperion/contracts";

export type Capability =
  | "view:operation"
  | "view:conversations"
  | "view:agenda"
  | "view:rpa"
  | "view:campaigns"
  | "view:bi"
  | "view:config"
  | "write:operation"
  | "write:config"
  | "write:rpa"
  | "manage:operators";

const ROLE_CAPABILITIES: Record<OperatorRole, Capability[]> = {
  admin: [
    "view:operation",
    "view:conversations",
    "view:agenda",
    "view:rpa",
    "view:campaigns",
    "view:bi",
    "view:config",
    "write:operation",
    "write:config",
    "write:rpa",
    "manage:operators"
  ],
  coordinator: [
    "view:operation",
    "view:conversations",
    "view:agenda",
    "view:rpa",
    "view:campaigns",
    "view:bi",
    "view:config",
    "write:operation",
    "write:config",
    "write:rpa"
  ],
  advisor: ["view:operation", "view:conversations", "view:agenda", "view:bi", "write:operation"],
  auditor: [
    "view:operation",
    "view:conversations",
    "view:agenda",
    "view:rpa",
    "view:campaigns",
    "view:bi",
    "view:config"
  ]
};

export function can(role: OperatorRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}
