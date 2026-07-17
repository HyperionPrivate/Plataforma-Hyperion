import { useCallback, useEffect, useMemo, useState } from "react";
import { Layout } from "../components/Layout.js";
import { Card, CardHead, LoadingState } from "../components/ui.js";
import { api, apiBaseUrl, ApiError } from "../lib/api.js";
import { novaPath, useConsole, voicePath } from "../lib/context.js";
import { can } from "../lib/rbac.js";
import { loadSession } from "../lib/session.js";
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
  mapPlatformRole,
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

export function NovaPage() {
  const { session, tenant } = useConsole();
  const novaRole = mapPlatformRole(session.operator.role);
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
  const [notice, setNotice] = useState<string>();

  const canWriteOps = can(session.operator.role, "write:nova");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
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

      try {
        const daily = await api.get<AnalyticsDailyRow[]>(novaPath(tenant.id, "analytics/daily"));
        setAnalytics(Array.isArray(daily) ? daily : []);
      } catch {
        setAnalytics([]);
      }

      try {
        const reviewRows = await api.get<ReviewRow[]>(novaPath(tenant.id, "reviews"));
        setReviews(Array.isArray(reviewRows) ? reviewRows : []);
      } catch {
        setReviews([]);
      }

      try {
        const recon = await api.get<{ needs_reconciliation: CallRow[] }>(voicePath(tenant.id, "calls/reconciliation"));
        setCalls(recon.needs_reconciliation ?? []);
      } catch {
        setCalls([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tenant.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!visibleTabs.some((item) => item.id === tab)) {
      setTab(visibleTabs[0]?.id ?? "dashboard");
    }
  }, [tab, visibleTabs]);

  async function bootstrapTenant() {
    if (!canWriteOps) return;
    await api.post(novaPath(tenant.id, "bootstrap"), {
      display_name: tenant.displayName
    });
    setNotice("Tenant NOVA inicializado con 9 agencias.");
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
    const sessionToken = loadSession()?.token;
    const form = new FormData();
    form.append("file", file);
    const response = await fetch(`${apiBaseUrl}${novaPath(tenant.id, "contacts/import/file")}`, {
      method: "POST",
      headers: sessionToken ? { authorization: `Bearer ${sessionToken}` } : undefined,
      body: form
    });
    if (response.status === 404 || response.status === 405) return null;
    const payload = (await response.json().catch(() => undefined)) as
      { data?: { imported?: ImportedContact[]; error?: string } } | undefined;
    if (!response.ok) {
      throw new ApiError(response.status, payload?.data?.error ?? response.statusText);
    }
    const imported = payload?.data?.imported ?? [];
    setNotice(`Importados ${imported.length} contactos vía archivo.`);
    await refresh();
    return imported;
  }

  async function createCampaign(input: {
    name: string;
    channel: "voice" | "whatsapp" | "mixed";
    product_flow: "renovacion" | "reactivacion";
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

  async function placeCall(phone: string) {
    if (!canWriteOps) return;
    await api.post(voicePath(tenant.id, "calls"), { phone_e164: phone });
    setNotice("Llamada individual solicitada (VOICE_MODE=mock por defecto).");
    await refresh();
  }

  async function claimHandoff(handoffId: string) {
    await api.post(novaPath(tenant.id, `handoffs/${handoffId}/claim`), {
      operator_id: session.operator.id
    });
    setNotice("Handoff reclamado.");
    await refresh();
  }

  async function claimConversation(conversationId: string) {
    await api.post(novaPath(tenant.id, `conversations/${conversationId}/claim`), {
      operator_id: session.operator.id
    });
    setNotice("Conversación reclamada.");
    await refresh();
  }

  async function replyConversation(conversationId: string, text: string) {
    await api.post(novaPath(tenant.id, `conversations/${conversationId}/reply`), { text });
    setNotice("Respuesta enviada.");
    await refresh();
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
    <Layout
      title="NOVA"
      subtitle={`Ops Coopfuturo · rol producto: ${novaRole}`}
      actions={
        <button className="btn" type="button" onClick={() => void refresh()}>
          Actualizar
        </button>
      }
    >
      <div className="col" style={{ gap: 16 }}>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {visibleTabs.map((item) => (
            <button
              key={item.id}
              type="button"
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
            <p>{notice}</p>
          </Card>
        ) : null}
        {loading ? <LoadingState label="Cargando NOVA…" /> : null}
        {error ? <div className="banner">{error}</div> : null}

        {!loading && !error && tab === "dashboard" ? (
          <NovaDashboardTab
            dashboard={dashboard}
            analytics={analytics}
            leads={leads}
            canWriteOps={canWriteOps}
            onBootstrap={() => void bootstrapTenant()}
          />
        ) : null}

        {!loading && !error && tab === "campaigns" ? (
          <NovaCampaignsTab
            campaigns={campaigns}
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
          />
        ) : null}

        {!loading && !error && tab === "reviews" ? (
          <NovaReviewsTab reviews={reviews} canWriteOps={canWriteOps} onDecide={decideReview} />
        ) : null}

        {!loading && !error && tab === "crm" ? (
          <NovaCrmTab leads={leads} canWriteOps={canWriteOps} onPatchLead={patchLead} />
        ) : null}

        {!loading && !error && tab === "handoff" ? <NovaHandoffTab handoffs={handoffs} onClaim={claimHandoff} /> : null}

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
            onPlaceCall={placeCall}
            onEligibility={eligibilityContact}
            onScore={scoreContact}
            onLookupAssociate={lookupAssociate}
            onSimulateLiwa={simulateLiwaEvent}
          />
        ) : null}

        {!loading && !error && tab === "config" ? <NovaConfigTab tenantId={tenant.id} /> : null}
      </div>
    </Layout>
  );
}
