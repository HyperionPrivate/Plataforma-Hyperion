/** Live Ops API → pilot-core `/ops/*` (MODULES.md). */
import type dashboard from "@/data/dashboard.json";
import type campaigns from "@/data/campaigns.json";
import type conversation from "@/data/conversation.json";
import type crm from "@/data/crm.json";
import type handoff from "@/data/handoff.json";
import { pilotCoreBaseUrl, redirectToLogin, sessionHeaders } from "@/lib/auth";

const base = pilotCoreBaseUrl();

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    credentials: "include",
    headers: sessionHeaders({ Accept: "application/json" }),
    cache: "no-store",
  });
  if (res.status === 401) {
    redirectToLogin("expired");
    throw new Error("Sesión NOVA expirada");
  }
  if (!res.ok) {
    throw new Error(`pilot-core ${path} → HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

type ConversationRow = (typeof conversation.conversations)[number] & {
  claimedBy?: string;
  botPaused?: boolean;
};

export type ConversationsPayload = Omit<typeof conversation, "conversations"> & {
  conversations: ConversationRow[];
  pii_masked?: boolean;
};

export type SegmentationPayload = {
  points: Array<{
    id?: string;
    x: number;
    y: number;
    segment?: string;
    label?: string;
  }>;
  waves: Array<{
    ola: string;
    registros: number;
    score: number;
    cierre: string;
    canal: string;
  }>;
  retries: string[];
  heatmap: { days: string[]; hours: string[]; values: number[][] };
};

type HandoffRow = (typeof handoff.queue)[number] & {
  conversationId?: string;
};

export type HandoffPayload = Omit<typeof handoff, "queue"> & {
  queue: HandoffRow[];
};

type CrmCard = {
  id: string;
  name: string;
  universidad: string;
  score: number;
  channel: string;
  urgency: string;
  phone?: string;
  allowed_next?: string[];
};

export type CrmPayload = typeof crm & {
  transitions?: Record<string, string[]>;
  tipificacion_required?: string[];
  funnels: Record<
    string,
    {
      title?: string;
      tipificaciones?: Array<{ key: string; label: string; count: number }>;
      columns: Array<{
        id: string;
        label: string;
        count: number;
        cards: CrmCard[];
      }>;
    }
  >;
};

export async function getDashboard() {
  return getJson<typeof dashboard>("/ops/dashboard");
}
export async function getCampaigns() {
  return getJson<typeof campaigns>("/ops/campaigns");
}
export async function getConversations() {
  return getJson<ConversationsPayload>("/ops/conversations");
}
export async function getCrm() {
  return getJson<CrmPayload>("/ops/crm");
}
export async function getHandoff() {
  return getJson<HandoffPayload>("/ops/handoff");
}

export async function getSegmentation() {
  return getJson<SegmentationPayload>("/ops/segmentation");
}
