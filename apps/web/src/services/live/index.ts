/** Live Ops API → pilot-core `/ops/*` (MODULES.md). */
const base = (process.env.NEXT_PUBLIC_PILOT_CORE_URL ?? "http://127.0.0.1:8201").replace(/\/$/, "");

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`pilot-core ${path} → HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function getDashboard() {
  return getJson("/ops/dashboard");
}
export async function getCampaigns() {
  return getJson("/ops/campaigns");
}
export async function getConversations() {
  return getJson("/ops/conversations");
}
export async function getCrm() {
  return getJson("/ops/crm");
}
export async function getHandoff() {
  return getJson("/ops/handoff");
}

export async function getSegmentation() {
  return getJson("/ops/segmentation");
}
