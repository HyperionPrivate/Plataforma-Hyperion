/**
 * Smoke outbound LIWA real (sin webhook inbound).
 *
 * Uso:
 *   LIWA_API_TOKEN=... LIWA_SMOKE_PHONE=+57300... node scripts/autonomy/liwa-outbound-smoke.mjs
 *
 * Opcional:
 *   LIWA_BASE_URL (default https://chat.liwa.co/api)
 *   LIWA_DEFAULT_FLOW_ID (default 1782399915832 Renovaciones)
 *   LIWA_SMOKE_AGENCY_TAG (default AG_BUCARAMANGA)
 *   LIWA_SMOKE_FIRST_NAME (default Smoke Hyperion)
 */

const baseUrl = (process.env.LIWA_BASE_URL ?? "https://chat.liwa.co/api").replace(/\/$/, "");
const token = process.env.LIWA_API_TOKEN?.trim() || process.env.LIWA_ACCESS_TOKEN?.trim();
const phone = process.env.LIWA_SMOKE_PHONE?.trim();
const flowId = process.env.LIWA_DEFAULT_FLOW_ID?.trim() || "1782399915832";
const agencyTag = process.env.LIWA_SMOKE_AGENCY_TAG?.trim() || "AG_BUCARAMANGA";
const firstName = process.env.LIWA_SMOKE_FIRST_NAME?.trim() || "Smoke Hyperion";
const vipTag = process.env.LIWA_VIP_TAG?.trim() || "RENOVACION_VIP";

if (!token) {
  console.error("LIWA_API_TOKEN is required");
  process.exit(64);
}
if (!phone || !/^\+[1-9]\d{7,14}$/.test(phone)) {
  console.error("LIWA_SMOKE_PHONE must be E.164 (e.g. +573001234567)");
  process.exit(64);
}

async function liwa(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "X-ACCESS-TOKEN": token,
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 400) };
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

console.log("1) ensure contact", phone);
const contact = await liwa("POST", "/contacts", { phone, first_name: firstName });
const nested = contact?.data && typeof contact.data === "object" ? contact.data : {};
const contactId = String(nested.id ?? nested.contact_id ?? contact.id ?? contact.contact_id ?? "");
if (!contactId) throw new Error(`ensureContact did not return id: ${JSON.stringify(contact)}`);

console.log("2) ensure/apply agency tag", agencyTag);
const tags = await liwa("GET", "/accounts/tags");
const tagList = Array.isArray(tags) ? tags : tags.items ?? [];
let agency = tagList.find((t) => String(t.name).toUpperCase() === agencyTag.toUpperCase());
if (!agency) {
  agency = await liwa("POST", "/accounts/tags", { name: agencyTag });
}
const agencyId = String(agency.id ?? agency.tag_id);
await liwa("POST", `/contacts/${contactId}/tags/${agencyId}`);

console.log("3) ensure/apply VIP tag", vipTag);
let vip = tagList.find((t) => String(t.name).toUpperCase() === vipTag.toUpperCase());
if (!vip) {
  try {
    vip = await liwa("POST", "/accounts/tags", { name: vipTag });
  } catch {
    vip = null;
  }
}
if (vip?.id || vip?.tag_id) {
  await liwa("POST", `/contacts/${contactId}/tags/${String(vip.id ?? vip.tag_id)}`);
}

console.log("4) send flow", flowId);
const sent = await liwa("POST", `/contacts/${contactId}/send/${flowId}`, {});

console.log(
  JSON.stringify(
    {
      ok: true,
      contactId,
      phone,
      flowId,
      agencyTag,
      vipTag,
      provider: sent
    },
    null,
    2
  )
);
console.log("Verifica en https://chat.liwa.co que el chat/flow arrancó.");
