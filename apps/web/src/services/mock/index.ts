import dashboard from "@/data/dashboard.json";
import campaigns from "@/data/campaigns.json";
import conversation from "@/data/conversation.json";
import crm from "@/data/crm.json";
import handoff from "@/data/handoff.json";
import type {
  ConversationsPayload,
  CrmPayload,
  HandoffPayload,
  SegmentationPayload,
} from "../live";

const delay = (ms = 280) => new Promise((r) => setTimeout(r, ms));

export async function getDashboard() {
  await delay();
  return dashboard;
}

export async function getCampaigns() {
  await delay();
  return campaigns;
}

export async function getConversations(): Promise<ConversationsPayload> {
  await delay();
  return conversation as ConversationsPayload;
}

export async function getCrm(): Promise<CrmPayload> {
  await delay();
  return crm as CrmPayload;
}

export async function getHandoff(): Promise<HandoffPayload> {
  await delay();
  return handoff as HandoffPayload;
}

export async function getSegmentation(): Promise<SegmentationPayload> {
  await delay();
  return {
    points: [],
    waves: [],
    retries: [],
    heatmap: { days: [], hours: [], values: [] },
  };
}

export function createLiveEvent() {
  const names = ["Laura Gómez", "Carlos Ruiz", "Andrea Díaz", "Julián Mora", "Paola Niño"];
  const kinds = ["Llamada conectada", "Orden recibida", "WhatsApp entregado", "Handoff creado"];
  const channels = ["voz", "whatsapp"] as const;
  const now = new Date();
  const at = now.toLocaleTimeString("es-CO", { hour12: false });
  return {
    id: `${now.getTime()}`,
    channel: channels[Math.floor(Math.random() * 2)],
    personName: names[Math.floor(Math.random() * names.length)],
    kind: kinds[Math.floor(Math.random() * kinds.length)],
    at,
  };
}
