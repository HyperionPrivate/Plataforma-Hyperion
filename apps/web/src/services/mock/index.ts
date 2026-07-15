import dashboard from "@/data/dashboard.json";
import campaigns from "@/data/campaigns.json";
import conversation from "@/data/conversation.json";
import crm from "@/data/crm.json";
import handoff from "@/data/handoff.json";

const delay = (ms = 280) => new Promise((r) => setTimeout(r, ms));

export async function getDashboard() {
  await delay();
  return dashboard;
}

export async function getCampaigns() {
  await delay();
  return campaigns;
}

export async function getConversations() {
  await delay();
  return conversation;
}

export async function getCrm() {
  await delay();
  return crm;
}

export async function getHandoff() {
  await delay();
  return handoff;
}

export async function getSegmentation() {
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
