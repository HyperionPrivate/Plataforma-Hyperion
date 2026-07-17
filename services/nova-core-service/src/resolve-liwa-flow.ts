import type { DatabaseExecutor } from "@hyperion/database";

export type NovaProductFlow = "renovacion" | "reactivacion";

/**
 * Resolve LIWA flow id for outbound WhatsApp:
 * 1) explicit override
 * 2) nova.agent_configs.liwa_flow_id for product_flow
 * 3) env LIWA_FLOW_ID_B / LIWA_DEFAULT_FLOW_ID by flow
 */
export async function resolveLiwaFlowId(
  db: DatabaseExecutor,
  tenantId: string,
  productFlow: NovaProductFlow,
  options: {
    explicitFlowId?: string | null;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<string> {
  const explicit = options.explicitFlowId?.trim();
  if (explicit) return explicit;

  const row = await db.query<{ liwa_flow_id: string | null }>(
    `select liwa_flow_id
       from nova.agent_configs
      where tenant_id = $1 and product_flow = $2 and coalesce(is_active, true) = true
      limit 1`,
    [tenantId, productFlow]
  );
  const fromConfig = row.rows[0]?.liwa_flow_id?.trim();
  if (fromConfig) return fromConfig;

  const env = options.env ?? process.env;
  if (productFlow === "reactivacion") {
    const flowB = env.LIWA_FLOW_ID_B?.trim();
    if (flowB) return flowB;
  }
  return env.LIWA_DEFAULT_FLOW_ID?.trim() || "1782399915832";
}

export async function resolveProductFlowForContact(
  db: DatabaseExecutor,
  tenantId: string,
  contactId: string
): Promise<NovaProductFlow> {
  const fromCampaign = await db.query<{ product_flow: string }>(
    `select c.product_flow
       from nova.campaign_enrollments e
       join nova.campaigns c
         on c.tenant_id = e.tenant_id and c.campaign_id = e.campaign_id
      where e.tenant_id = $1 and e.contact_id = $2
      order by e.updated_at desc nulls last
      limit 1`,
    [tenantId, contactId]
  );
  const flow = fromCampaign.rows[0]?.product_flow;
  if (flow === "reactivacion" || flow === "renovacion") return flow;

  const segment = await db.query<{ segment: string | null }>(
    `select segment from nova.contacts where tenant_id = $1 and contact_id = $2`,
    [tenantId, contactId]
  );
  const seg = (segment.rows[0]?.segment ?? "").toLowerCase();
  if (seg.includes("reactiv")) return "reactivacion";
  return "renovacion";
}
