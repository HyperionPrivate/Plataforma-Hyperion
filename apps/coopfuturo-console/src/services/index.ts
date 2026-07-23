import * as mock from "./mock";
import * as live from "./live";

function isRestrictedApiModeEnvironment(): boolean {
  const deployment =
    process.env.HYPERION_DEPLOYMENT_ENVIRONMENT?.trim().toLowerCase() ||
    process.env.HYPERION_ENVIRONMENT?.trim().toLowerCase() ||
    "";
  return deployment === "staging" || deployment === "production" || deployment === "prod";
}

function resolveApiMode(): "mock" | "live" {
  const configured = process.env.NEXT_PUBLIC_API_MODE?.trim().toLowerCase();
  const mode = configured === "live" || configured === "mock" ? configured : "mock";
  if (isRestrictedApiModeEnvironment() && mode !== "live") {
    throw new Error(
      "NEXT_PUBLIC_API_MODE=mock (or unset) is forbidden when HYPERION_ENVIRONMENT/HYPERION_DEPLOYMENT_ENVIRONMENT is staging or production"
    );
  }
  return mode;
}

const mode = resolveApiMode();

export const api = mode === "live" ? live : mock;
export { createLiveEvent } from "./mock";
