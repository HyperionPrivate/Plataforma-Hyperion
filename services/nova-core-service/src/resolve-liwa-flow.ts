import type { DatabaseExecutor } from "@hyperion/database";

export type NovaProductFlow = string;

/**
 * Resolve LIWA flow id for outbound WhatsApp:
 * 1) explicit override
 * 2) nova.agent_configs.liwa_flow_id for product_flow
 * 3) tenant-neutral emergency default from LIWA_DEFAULT_FLOW_ID
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
  const fallback = env.LIWA_DEFAULT_FLOW_ID?.trim();
  if (fallback) return fallback;
  throw new Error(`No LIWA flow is configured for NOVA flow ${productFlow}`);
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
  const campaignFlow = fromCampaign.rows[0]?.product_flow?.trim();
  if (campaignFlow) return campaignFlow;

  const configured = await db.query<{ product_flow: string }>(
    `select product_flow from nova.agent_configs
      where tenant_id = $1 and coalesce(is_active, true) = true
      order by product_flow
      limit 1`,
    [tenantId]
  );
  const configuredFlow = configured.rows[0]?.product_flow?.trim();
  if (configuredFlow) return configuredFlow;
  throw new Error(`No active NOVA flow is configured for tenant ${tenantId}`);
}
