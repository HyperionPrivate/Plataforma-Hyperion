/**
 * Legacy shared-console redirects — permanently retired (DEBT-023).
 *
 * Product consoles are reached only via hostname edge / direct product origins.
 * This module remains so the empty shell can render a static 404 for old paths.
 */

export interface ConsoleTargets {
  nova: string;
  lumen: string;
  pulso: string;
}

/** Permanently retired: always returns undefined (env and targets ignored). */
export function resolveLegacyRedirect(
  _pathname: string,
  _search: string,
  _targets: ConsoleTargets
): string | undefined {
  return undefined;
}
