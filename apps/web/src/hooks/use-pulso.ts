"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, createLiveEvent } from "@/services";
import type { LiveEvent } from "@/components/domain/live-feed";

export function useDashboard() {
  return useQuery({ queryKey: ["dashboard"], queryFn: () => api.getDashboard() });
}

export function useCampaigns() {
  return useQuery({ queryKey: ["campaigns"], queryFn: () => api.getCampaigns() });
}

export function useConversations() {
  return useQuery({ queryKey: ["conversations"], queryFn: () => api.getConversations() });
}

export function useCrm() {
  return useQuery({ queryKey: ["crm"], queryFn: () => api.getCrm() });
}

export function useHandoff() {
  return useQuery({ queryKey: ["handoff"], queryFn: () => api.getHandoff() });
}

export function useLiveFeed(seed: LiveEvent[] = []) {
  const [events, setEvents] = useState<LiveEvent[]>(seed);

  useEffect(() => {
    setEvents(seed);
  }, [seed]);

  useEffect(() => {
    const id = setInterval(() => {
      setEvents((prev) => [createLiveEvent() as LiveEvent, ...prev].slice(0, 12));
    }, 4000);
    return () => clearInterval(id);
  }, []);

  return events;
}
