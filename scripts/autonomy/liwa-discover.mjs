/**
 * LIWA read-only discovery against the live API (Swagger-compatible).
 *
 * Uso:
 *   LIWA_API_TOKEN=... node scripts/autonomy/liwa-discover.mjs
 *
 * Variables:
 *   LIWA_API_TOKEN or LIWA_ACCESS_TOKEN (required)
 *   LIWA_BASE_URL (default https://chat.liwa.co/api)
 *
 * Solo GETs: me, tags, flows, teams, custom_fields. No crea contactos ni envía WhatsApp.
 */

const baseUrl = (process.env.LIWA_BASE_URL ?? "https://chat.liwa.co/api").replace(/\/$/, "");
const token = process.env.LIWA_API_TOKEN?.trim() || process.env.LIWA_ACCESS_TOKEN?.trim();

if (!token) {
  console.error("LIWA_API_TOKEN (or LIWA_ACCESS_TOKEN) is required");
  process.exit(64);
}

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { "X-ACCESS-TOKEN": token }
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  if (!response.ok) {
    throw new Error(`GET ${path} -> ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    if (Array.isArray(value.data)) return value.data;
    if (Array.isArray(value.items)) return value.items;
  }
  return [];
}

const me = await get("/accounts/me");
const tags = asList(await get("/accounts/tags"));
const flows = asList(await get("/accounts/flows"));
const teams = asList(await get("/accounts/teams"));
const customFields = asList(await get("/accounts/custom_fields"));

const agencyTags = tags.filter((t) => String(t.name ?? "").startsWith("AG_"));
const renovacionFlows = flows.filter((f) => /renov/i.test(String(f.name ?? "")));

const inventory = {
  ok: true,
  baseUrl,
  account: {
    page_id: me.page_id ?? me.id ?? null,
    name: me.name ?? null,
    active: me.active ?? null,
    total_users: me.total_users ?? null
  },
  counts: {
    tags: tags.length,
    agency_tags: agencyTags.length,
    flows: flows.length,
    teams: teams.length,
    custom_fields: customFields.length
  },
  recommended: {
    LIWA_ACCOUNT_ID: String(me.page_id ?? ""),
    LIWA_DEFAULT_FLOW_ID:
      flows.find((f) => String(f.name) === "Renovaciones")?.id ??
      renovacionFlows[0]?.id ??
      null,
    LIWA_FLOW_ID_B: flows.find((f) => String(f.name).includes("RENOVACION_FLOR"))?.id ?? null
  },
  agency_tags: agencyTags.map((t) => ({ id: String(t.id), name: String(t.name) })),
  flows: flows.map((f) => ({ id: String(f.id), name: String(f.name) })),
  teams: teams.map((t) => ({ id: String(t.id), name: String(t.name) })),
  custom_fields: customFields.map((f) => ({
    id: String(f.id),
    name: String(f.name),
    type: f.type
  })),
  notes: [
    "Webhooks are not exposed via API; configure in LIWA UI (Herramientas → Webhooks).",
    "No dedicated 'reactivacion' flow was required for this inventory; check flows list.",
    "Handoff is tag-based: POST /contacts/{id}/tags/{tag_id} with AG_*."
  ]
};

console.log(JSON.stringify(inventory, null, 2));
