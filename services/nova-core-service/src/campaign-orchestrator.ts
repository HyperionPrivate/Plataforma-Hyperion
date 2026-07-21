import type { DatabaseClient } from "@hyperion/database";
import { authorizeVoiceCall } from "./voice-authorization.js";

export interface CampaignDispatchDestinations {
  voice: string;
  audit: string;
}

export interface CampaignBatchResult {
  campaignId: string;
  status: "running" | "not_running";
  queued: number;
  blocked: number;
}

export async function dispatchCampaignBatch(
  db: DatabaseClient,
  tenantId: string,
  campaignId: string,
  destinations: CampaignDispatchDestinations,
  limit = 25
): Promise<CampaignBatchResult> {
  return db.transaction(async (tx) => {
    const campaign = await tx.query<{ channel: string; productFlow: string }>(
      `select channel, product_flow as "productFlow"
         from nova.campaigns
        where tenant_id = $1 and campaign_id = $2 and status = 'running'
        for update`,
      [tenantId, campaignId]
    );
    const active = campaign.rows[0];
    if (!active) return { campaignId, status: "not_running", queued: 0, blocked: 0 };
    if (active.channel === "whatsapp") return { campaignId, status: "running", queued: 0, blocked: 0 };

    const candidates = await tx.query<{ contactId: string }>(
      `select e.contact_id as "contactId"
         from nova.campaign_enrollments e
        where e.tenant_id = $1 and e.campaign_id = $2
          and e.status in ('enrolled', 'failed')
          and (e.next_attempt_at is null or e.next_attempt_at <= now())
        order by e.next_attempt_at nulls first, e.last_attempt_at nulls first, e.contact_id
        for update of e skip locked
        limit $3`,
      [tenantId, campaignId, Math.max(1, Math.min(100, Math.trunc(limit)))]
    );

    let queued = 0;
    let blocked = 0;
    for (const candidate of candidates.rows) {
      const result = await authorizeVoiceCall(tx, {
        tenantId,
        contactId: candidate.contactId,
        campaignId,
        productFlow: active.productFlow,
        voiceDestination: destinations.voice,
        auditDestination: destinations.audit
      });
      if (result.status === "authorized") queued += 1;
      else blocked += 1;
    }

    if (candidates.rowCount === 0) {
      const remaining = await tx.query(
        `select 1 from nova.campaign_enrollments
          where tenant_id = $1 and campaign_id = $2
            and status in ('enrolled', 'failed', 'attempted')
          limit 1`,
        [tenantId, campaignId]
      );
      if ((remaining.rowCount ?? 0) === 0) {
        await tx.query(
          `update nova.campaigns set status = 'completed', updated_at = now()
            where tenant_id = $1 and campaign_id = $2 and status = 'running'`,
          [tenantId, campaignId]
        );
      }
    }

    return { campaignId, status: "running", queued, blocked };
  });
}

export class CampaignOrchestrator {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly db: DatabaseClient,
    private readonly destinations: CampaignDispatchDestinations,
    private readonly onError: (error: unknown) => void,
    private readonly intervalMs = 5_000
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const campaigns = await this.db.query<{ tenantId: string; campaignId: string }>(
        `select tenant_id as "tenantId", campaign_id as "campaignId"
           from nova.campaigns
          where status = 'running'
          order by updated_at, campaign_id
          limit 50`
      );
      for (const campaign of campaigns.rows) {
        try {
          await dispatchCampaignBatch(this.db, campaign.tenantId, campaign.campaignId, this.destinations);
        } catch (error) {
          this.onError(error);
        }
      }
    } catch (error) {
      this.onError(error);
    } finally {
      this.running = false;
    }
  }
}
