import { useCallback, useEffect, useMemo, useState } from "react";
import { NovaShell } from "../components/NovaShell.js";
import { Card, CardHead, LoadingState } from "../components/ui.js";
import { api, ApiError } from "../lib/api.js";
import { novaPath, useNovaConsole, voicePath } from "../lib/context.js";
import { novaGrantAllows, primaryNovaRole } from "../lib/session.js";
import {
  NovaCampaignsTab,
  NovaConfigTab,
  NovaConversationsTab,
  NovaCrmTab,
  NovaDashboardTab,
  NovaHandoffTab,
  NovaImportTab,
  NovaLabTab,
  NovaReportsTab,
  NovaReviewsTab,
  NovaSegmentationTab,
  NOVA_TABS,
  type ChannelStatus
} from "./nova/index.js";
import type {
  AnalyticsDailyRow,
  CallRow,
  CampaignRow,
  ConversationRow,
  DashboardSummary,
  HandoffRow,
  ImportedContact,
  LeadRow,
  NovaTab,
  ReviewRow
} from "./nova/types.js";

export function readAnalyticsCoverageNotice(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const coverage = value as Record<string, unknown>;
  const status = typeof coverage.status === "string" ? coverage.status : undefined;
  const coverageFrom = typeof coverage.coverageFrom === "string" ? coverage.coverageFrom : undefined;
  const appliedAt = typeof coverage.appliedAt === "string" ? coverage.appliedAt : undefined;

  if (status === "complete_since_cutover" && coverageFrom) {
    return `El desglose por sede es completo desde ${coverageFrom}. El histórico anterior al corte${
      appliedAt ? ` (${appliedAt})` : ""
    } permanece en un agregado no atribuible y no se muestra como dato de una sede.`;
  }
  if (status === "partial") {
    return `El desglose por sede no está disponible porque la reconciliación detectó datos sin atribución${
      coverageFrom ? ` desde ${coverageFrom}` : ""
    }. Se requiere un backfill verificado antes de mostrar la serie.`;
  }
  if (status === "unavailable") {
    return "No fue posible verificar la cobertura del desglose por sede; la serie se mantiene oculta.";
  }
  return undefined;
}

export function NovaPage() {
  const { session, tenant, grant } = useNovaConsole();
  const novaRole = primaryNovaRole(grant);
  const visibleTabs = useMemo(() => NOVA_TABS.filter((tab) => tab.roles.includes(novaRole)), [novaRole]);
  const [tab, setTab] = useState<NovaTab>("dashboard");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [dashboard, setDashboard] = useState<DashboardSummary>();
  const [analytics, setAnalytics] = useState<AnalyticsDailyRow[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [handoffs, setHandoffs] = useState<HandoffRow[]>([]);
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [flowIds, setFlowIds] = useState<string[]>([]);
  const [notice, setNotice] = useState<string>();
  const [analyticsCoverageNotice, setAnalyticsCoverageNotice] = useState<string>();

  const canWriteOps = novaGrantAllows(grant, "nova:write");
  const canAdminOps = novaRole === "admin" && novaGrantAllows(grant, "nova:admin");
  const canReadProviderConfig = novaRole === "admin" || novaRole === "supervisor";
  const canReadManagementViews = novaRole === "admin" || novaRole === "supervisor";

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    setAnalyticsCoverageNotice(undefined);
    try {
      const [dash, camps, hands, convs, leadRows] = await Promise.all([
        api.get<DashboardSummary>(novaPath(tenant.id, "dashboard")),
        api.get<CampaignRow[]>(novaPath(tenant.id, "campaigns")),
        api.get<HandoffRow[]>(novaPath(tenant.id, "handoffs")),
        api.get<ConversationRow[]>(novaPath(tenant.id, "conversations")),
        api.get<LeadRow[]>(novaPath(tenant.id, "leads"))
      ]);
      setDashboard(dash);
      setCampaigns(camps);
      setHandoffs(hands);
      setConversations(convs);
      setLeads(leadRows);

      if (canReadProviderConfig) {
        try {
          const configs = await api.get<Array<{ product_flow: string }> | { items: Array<{ product_flow: string }> }>(
            novaPath(tenant.id, "agent-configs")
          );
          const items = Array.isArray(configs) ? configs : configs.items;
          setFlowIds(
            [...new Set(items.map((config) => config.product_flow.trim()).filter(Boolean))].sort((left, right) =>
              left.localeCompare(right)
            )
          );
        } catch {
          setFlowIds([]);
        }
      } else {
        setFlowIds([]);
      }

      if (canReadManagementViews) {
        try {
          const analyticsResponse = await api.getEnvelope<AnalyticsDailyRow[]>(novaPath(tenant.id, "analytics/daily"));
          setAnalytics(Array.isArray(analyticsResponse.data) ? analyticsResponse.data : []);
          setAnalyticsCoverageNotice(readAnalyticsCoverageNotice(analyticsResponse.meta?.analyticsCoverage));
        } catch (analyticsError) {
          setAnalytics([]);
          setAnalyticsCoverageNotice(
            analyticsError instanceof ApiError ? readAnalyticsCoverageNotice(analyticsError.data?.coverage) : undefined
          );
        }
      } else {
        setAnalytics([]);
      }

      if (canReadManagementViews) {
        try {
          const reviewRows = await api.get<ReviewRow[]>(novaPath(tenant.id, "reviews"));
          setReviews(Array.isArray(reviewRows) ? reviewRows : []);
        } catch {
          setReviews([]);
        }
      } else {
        setReviews([]);
      }

      if (canAdminOps) {
        try {
          const recon = await api.get<{ needs_reconciliation: CallRow[] }>(
            voicePath(tenant.id, "calls/reconciliation")
          );
          setCalls(recon.needs_reconciliation ?? []);
        } catch {
          setCalls([]);
        }
      } else {
        setCalls([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [canAdminOps, canReadManagementViews, canReadProviderConfig, tenant.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!visibleTabs.some((item) => item.id === tab)) {
      setTab(visibleTabs[0]?.id ?? "dashboard");
    }
  }, [tab, visibleTabs]);

  async function bootstrapTenant() {
    if (!canAdminOps) return;
    await api.post(novaPath(tenant.id, "bootstrap"), {
      display_name: tenant.displayName
    });
    setNotice("Tenant NOVA inicializado con su catálogo operativo.");
    await refresh();
  }

  async function importContactsJson(
    contacts: Array<{ phone_e164: string; full_name?: string; agency_code?: string }>
  ): Promise<ImportedContact[]> {
    if (!canWriteOps) return [];
    const result = await api.post<{ imported: ImportedContact[] }>(novaPath(tenant.id, "contacts/import"), {
      contacts
    });
    setNotice(`Importados ${result.imported?.length ?? 0} contactos.`);
    await refresh();
    return result.imported ?? [];
  }

  async function importContactsFile(file: File): Promise<ImportedContact[] | null> {
    if (!canWriteOps) return null;
    const form = new FormData();
    form.append("file", file);
    try {
      const payload = await api.form<{ imported?: ImportedContact[] }>(
        novaPath(tenant.id, "contacts/import/file"),
        form
      );
      const imported = payload.imported ?? [];
      setNotice(`Importados ${imported.length} contactos vía archivo.`);
      await refresh();
      return imported;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 405)) return null;
      throw error;
    }
  }

  async function createCampaign(input: {
    name: string;
    channel: "voice" | "whatsapp" | "mixed";
    product_flow: string;
  }): Promise<string | undefined> {
    if (!canWriteOps) return undefined;
    const created = await api.post<{ campaign_id: string }>(novaPath(tenant.id, "campaigns"), input);
    setNotice("Campaña creada en borrador.");
    await refresh();
    return created.campaign_id;
  }

  async function enrollCampaign(campaignId: string, contactIds: string[]) {
    if (!canWriteOps) return;
    const result = await api.post<{ enrolled: number }>(novaPath(tenant.id, `campaigns/${campaignId}/enroll`), {
      contact_ids: contactIds
    });
    setNotice(`Enrolados ${result.enrolled ?? 0} contactos.`);
    await refresh();
  }

  async function startCampaign(campaignId: string) {
    if (!canWriteOps) return;
    const result = await api.post<{ voice_calls_queued?: number }>(
      novaPath(tenant.id, `campaigns/${campaignId}/start`),
      {}
    );
    setNotice(`Campaña lanzada · voces en cola: ${result.voice_calls_queued ?? 0}.`);
    await refresh();
  }

  async function pauseCampaign(campaignId: string) {
    if (!canWriteOps) return;
    await api.post(novaPath(tenant.id, `campaigns/${campaignId}/pause`), {});
    setNotice("Campaña pausada.");
    await refresh();
  }

  async function cancelCampaign(campaignId: string) {
    if (!canWriteOps) return;
    await api.post(novaPath(tenant.id, `campaigns/${campaignId}/cancel`), {});
    setNotice("Campaña cancelada.");
    await refresh();
  }

  async function placeCall(contactId: string) {
    if (!canWriteOps) return;
    await api.post(novaPath(tenant.id, `contacts/${contactId}/calls`), {});
    setNotice("Llamada individual autorizada y puesta en cola por NOVA Core.");
    await refresh();
  }

  async function claimHandoff(handoffId: string) {
    await api.post(novaPath(tenant.id, `handoffs/${handoffId}/claim`), {});
    setNotice("Handoff reclamado.");
    await refresh();
  }

  async function claimConversation(conversationId: string) {
    await api.post(novaPath(tenant.id, `conversations/${conversationId}/claim`), {});
    setNotice("Conversación reclamada.");
    await refresh();
  }

  async function replyConversation(conversationId: string, text: string) {
    await api.post(novaPath(tenant.id, `conversations/${conversationId}/reply`), { text });
    setNotice("Respuesta enviada.");
    await refresh();
  }

  async function fetchConversationMessages(conversationId: string) {
    return api.get<
      Array<{
        message_id: string;
        direction: "inbound" | "outbound";
        body: string;
        kind: string;
        created_at?: string;
      }>
    >(novaPath(tenant.id, `conversations/${conversationId}/messages`));
  }

  async function decideReview(reviewId: string, decision: "approve" | "skip") {
    if (!canWriteOps) return;
    await api.post(novaPath(tenant.id, `reviews/${reviewId}/decide`), {
      decision,
      operator_id: session.operator.id
    });
    setNotice(decision === "approve" ? "Revisión aprobada / WA solicitado." : "Revisión omitida.");
    await refresh();
  }

  async function patchLead(leadId: string, body: { stage?: string; tipification?: string; product_line?: string }) {
    if (!canWriteOps) return;
    await api.patch(novaPath(tenant.id, `leads/${leadId}`), body);
    setNotice("Lead actualizado.");
    await refresh();
  }

  async function scoreContact(contactId: string) {
    const result = await api.post<{
      contact_id: string;
      segment?: string;
      score?: number;
      propensity?: number;
      urgency?: number;
      wave?: string;
    }>(novaPath(tenant.id, `contacts/${contactId}/score`), { auto: true });
    return result;
  }

  async function eligibilityContact(contactId: string) {
    return api.post(novaPath(tenant.id, `contacts/${contactId}/eligibility`), {});
  }

  async function lookupAssociate(documentId: string) {
    return api.get(novaPath(tenant.id, `core/associates/${documentId}`));
  }

  async function simulateLiwaEvent(input: {
    event: string;
    phone: string;
    ciudad?: string;
    score?: number;
    tipificacion?: string;
  }) {
    return api.post(novaPath(tenant.id, "lab/liwa-event"), input);
  }

  async function fetchChannelStatus(conversationId: string): Promise<ChannelStatus> {
    return api.get<ChannelStatus>(novaPath(tenant.id, `conversations/${conversationId}/channel-status`));
  }

  return (
    <NovaShell
      title="NOVA"
      subtitle={`Operación omnicanal · rol de producto: ${novaRole}`}
      actions={
        <button className="btn" type="button" onClick={() => void refresh()}>
          Actualizar
        </button>
      }
    >
      <div className="col" style={{ gap: 16 }}>
        <div className="row" role="tablist" aria-label="Módulos NOVA" style={{ gap: 8, flexWrap: "wrap" }}>
          {visibleTabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              aria-controls="nova-active-panel"
              className={`chip${tab === item.id ? " active" : ""}`}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        {notice ? (
          <Card>
            <CardHead title="Estado" />
            <p role="status">{notice}</p>
          </Card>
        ) : null}
        {analyticsCoverageNotice ? (
          <Card>
            <CardHead title="Cobertura de analytics" />
            <p role="status">{analyticsCoverageNotice}</p>
          </Card>
        ) : null}
        {loading ? <LoadingState label="Cargando NOVA…" /> : null}
        {error ? <div className="banner">{error}</div> : null}

        <section id="nova-active-panel" role="tabpanel" aria-label={visibleTabs.find((item) => item.id === tab)?.label}>
          {!loading && !error && tab === "dashboard" ? (
            <NovaDashboardTab
              dashboard={dashboard}
              analytics={analytics}
              leads={leads}
              canBootstrap={canAdminOps}
              onBootstrap={() => void bootstrapTenant()}
            />
          ) : null}

          {!loading && !error && tab === "campaigns" ? (
            <NovaCampaignsTab
              campaigns={campaigns}
              flowIds={flowIds}
              canWriteOps={canWriteOps}
              onCreate={createCampaign}
              onEnroll={enrollCampaign}
              onStart={startCampaign}
              onPause={pauseCampaign}
              onCancel={cancelCampaign}
            />
          ) : null}

          {!loading && !error && tab === "conversations" ? (
            <NovaConversationsTab
              conversations={conversations}
              onClaim={claimConversation}
              onReply={replyConversation}
              onChannelStatus={fetchChannelStatus}
              onLoadMessages={fetchConversationMessages}
            />
          ) : null}

          {!loading && !error && tab === "reviews" ? (
            <NovaReviewsTab reviews={reviews} canWriteOps={canWriteOps} onDecide={decideReview} />
          ) : null}

          {!loading && !error && tab === "crm" ? (
            <NovaCrmTab leads={leads} canWriteOps={canWriteOps} onPatchLead={patchLead} />
          ) : null}

          {!loading && !error && tab === "handoff" ? (
            <NovaHandoffTab handoffs={handoffs} onClaim={claimHandoff} />
          ) : null}

          {!loading && !error && tab === "segmentation" ? (
            <NovaSegmentationTab tenantId={tenant.id} leads={leads} canWriteOps={canWriteOps} onScore={scoreContact} />
          ) : null}

          {!loading && !error && tab === "import" ? (
            <NovaImportTab
              canWriteOps={canWriteOps}
              onImportJson={importContactsJson}
              onImportFile={importContactsFile}
            />
          ) : null}

          {!loading && !error && tab === "reports" ? (
            <NovaReportsTab
              dashboard={dashboard}
              analytics={analytics}
              leads={leads}
              handoffs={handoffs}
              campaigns={campaigns}
            />
          ) : null}

          {!loading && !error && tab === "lab" ? (
            <NovaLabTab
              calls={calls}
              canWriteOps={canWriteOps}
              canViewReconciliation={canAdminOps}
              onPlaceCall={placeCall}
              onEligibility={eligibilityContact}
              onScore={scoreContact}
              onLookupAssociate={lookupAssociate}
              onSimulateLiwa={simulateLiwaEvent}
            />
          ) : null}

          {!loading && !error && tab === "config" ? <NovaConfigTab tenantId={tenant.id} /> : null}
        </section>
      </div>
    </NovaShell>
  );
}
