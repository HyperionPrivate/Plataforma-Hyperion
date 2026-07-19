import type { PlatformRole as OperatorRole } from "@hyperion/platform-contracts";

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
  | "write:rpa";
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
    "write:rpa"
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
