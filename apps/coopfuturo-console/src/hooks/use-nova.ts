"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, createLiveEvent } from "@/services";
import type { LiveEvent } from "@/components/domain/live-feed";

export function useDashboard() {
  return useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.getDashboard(),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
}

export function useCampaigns() {
  return useQuery({ queryKey: ["campaigns"], queryFn: () => api.getCampaigns() });
}

export function useConversations() {
  return useQuery({
    queryKey: ["conversations"],
    queryFn: () => api.getConversations(),
    // Near-live inbox for advisor replies / webhook events (when LIWA posts inbound).
    refetchInterval: 3000,
    refetchIntervalInBackground: false,
  });
}

export function useCrm() {
  return useQuery({ queryKey: ["crm"], queryFn: () => api.getCrm() });
}

export function useHandoff() {
  return useQuery({ queryKey: ["handoff"], queryFn: () => api.getHandoff() });
}

export function useSegmentation() {
  return useQuery({ queryKey: ["segmentation"], queryFn: () => api.getSegmentation() });
}

/** Stable empty seed — inline `= []` creates a new array every render and loops setState. */
const EMPTY_SEED: LiveEvent[] = [];
const isLiveApi = (process.env.NEXT_PUBLIC_API_MODE ?? "mock") === "live";

export function useLiveFeed(seed: LiveEvent[] = EMPTY_SEED) {
  const [events, setEvents] = useState<LiveEvent[]>(() => seed);
  const seedKey = seed.map((e) => e.id).join("|");
  const lastKey = useRef<string>("");

  useEffect(() => {
    if (seedKey === lastKey.current) return;
    lastKey.current = seedKey;
    setEvents(seed);
  }, [seed, seedKey]);

  useEffect(() => {
    // En live, el feed viene del store (dashboard.liveEvents); no inventar eventos.
    if (isLiveApi) return;
    const id = setInterval(() => {
      setEvents((prev) => [createLiveEvent() as LiveEvent, ...prev].slice(0, 12));
    }, 4000);
    return () => clearInterval(id);
  }, []);

  return events;
}
