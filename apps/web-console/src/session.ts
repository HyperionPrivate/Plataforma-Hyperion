import type { AuthOperator, AuthSession } from "@hyperion/contracts";

const STORAGE_KEY = "hyperion.session";

export interface StoredSession {
  token: string;
  expiresAt: string;
  operator: AuthOperator;
}

export function loadSession(): StoredSession | undefined {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return undefined;
    }

    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed.token || new Date(parsed.expiresAt).getTime() <= Date.now()) {
      window.localStorage.removeItem(STORAGE_KEY);
      return undefined;
    }

    return parsed;
  } catch {
    return undefined;
  }
}

export function saveSession(session: AuthSession): StoredSession {
  const stored: StoredSession = {
    token: session.token,
    expiresAt: session.expiresAt,
    operator: session.operator
  };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  return stored;
}

export function clearSession(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}
