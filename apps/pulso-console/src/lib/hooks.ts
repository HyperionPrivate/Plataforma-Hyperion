import { useCallback, useEffect, useRef, useState } from "react";
import { api, SessionExpiredError } from "./api.js";

export interface PollingState<T> {
  data?: T;
  loading: boolean;
  error?: string;
  refresh: () => void;
}

/**
 * Lee un endpoint PULSO y refresca por intervalo. En 401 llama
 * onSessionExpired.
 */
export function usePolling<T>(
  path: string | undefined,
  intervalMs: number,
  onSessionExpired: () => void
): PollingState<T> {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const savedExpired = useRef(onSessionExpired);
  savedExpired.current = onSessionExpired;

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!path) return;
      try {
        const result = await api.get<T>(path, signal);
        if (!signal?.aborted) {
          setData(result);
          setError(undefined);
        }
      } catch (err) {
        if (signal?.aborted) return;
        if (err instanceof SessionExpiredError) {
          savedExpired.current();
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [path]
  );

  const refresh = useCallback(() => {
    setLoading(true);
    void load();
  }, [load]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void load(controller.signal);

    const timer = window.setInterval(() => void load(), intervalMs);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [load, intervalMs]);

  return { data, loading, error, refresh };
}
