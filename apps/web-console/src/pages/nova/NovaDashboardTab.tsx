import { useMemo } from "react";
import { DonutChart, FunnelChart, GaugeChart, Sparkline } from "../../components/nova/charts/index.js";
import { Card, CardHead, Kpi } from "../../components/ui.js";
import type { AnalyticsDailyRow, DashboardSummary, LeadRow } from "./types.js";
import { CRM_STAGES, CRM_STAGE_LABELS } from "./types.js";

export function NovaDashboardTab({
  dashboard,
  analytics,
  leads,
  canWriteOps,
  onBootstrap
}: {
  dashboard?: DashboardSummary;
  analytics: AnalyticsDailyRow[];
  leads: LeadRow[];
  canWriteOps: boolean;
  onBootstrap: () => void;
}) {
  const totals = useMemo(() => {
    return analytics.reduce(
      (acc, row) => {
        acc.callsRequested += Number(row.calls_requested ?? 0);
        acc.callsCompleted += Number(row.calls_completed ?? 0);
        acc.callsFailed += Number(row.calls_failed ?? 0);
        acc.waSent += Number(row.wa_sent ?? 0);
        acc.leadsWon += Number(row.leads_won ?? 0);
        acc.leadsInterested += Number(row.leads_interested ?? 0);
        acc.csatSum += Number(row.csat_sum ?? 0);
        acc.csatCount += Number(row.csat_count ?? 0);
        return acc;
      },
      {
        callsRequested: 0,
        callsCompleted: 0,
        callsFailed: 0,
        waSent: 0,
        leadsWon: 0,
        leadsInterested: 0,
        csatSum: 0,
        csatCount: 0
      }
    );
  }, [analytics]);

  const completionRate =
    totals.callsRequested > 0 ? Math.round((totals.callsCompleted / totals.callsRequested) * 100) : 0;

  const sparkCalls = useMemo(() => {
    const byDay = new Map<string, number>();
    for (const row of [...analytics].reverse()) {
      const day = String(row.day).slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + Number(row.calls_completed ?? 0));
    }
    return [...byDay.values()].slice(-14);
  }, [analytics]);

  const funnel = useMemo(() => {
    const counts = CRM_STAGES.map((stage) => leads.filter((lead) => lead.stage === stage).length);
    const max = counts[0] || leads.length || 1;
    return CRM_STAGES.filter((stage) => stage !== "no_interes").map((stage, index) => {
      const count = counts[index] ?? 0;
      return {
        key: stage,
        label: CRM_STAGE_LABELS[stage] ?? stage,
        count,
        pct: Math.round((count / max) * 1000) / 10
      };
    });
  }, [leads]);

  const channelSlices = useMemo(() => {
    const voice = totals.callsCompleted;
    const wa = totals.waSent;
    const total = voice + wa || 1;
    return [
      {
        key: "voice",
        label: "Voz completadas",
        count: voice,
        pct: Math.round((voice / total) * 100),
        color: "success"
      },
      { key: "wa", label: "WhatsApp enviados", count: wa, pct: Math.round((wa / total) * 100), color: "info" }
    ];
  }, [totals]);

  const metaHoy = Number(dashboard?.meta_contactos_hoy ?? 0);
  const resultadoHoy = totals.callsCompleted + totals.waSent;
  const metaPct = metaHoy > 0 ? Math.min(100, Math.round((resultadoHoy / metaHoy) * 100)) : 0;

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="grid kpi-row">
        <Kpi label="Contactos" value={dashboard?.contacts ?? 0} />
        <Kpi label="Campañas" value={dashboard?.campaigns ?? 0} />
        <Kpi label="Handoffs en cola" value={dashboard?.handoffsQueued ?? 0} />
        <Kpi label="Leads" value={dashboard?.leads ?? 0} />
        <Kpi label="Conversaciones" value={dashboard?.openConversations ?? 0} />
        <Kpi label="WA enviados (90d)" value={totals.waSent} />
      </div>

      <Card>
        <CardHead title="Meta vs. resultado (hoy)" />
        {metaHoy > 0 ? (
          <>
            <p className="tiny muted" style={{ marginBottom: 8 }}>
              Resultado {resultadoHoy} · Meta diaria {metaHoy} · Voz {totals.callsCompleted} · WhatsApp{" "}
              {totals.waSent}
            </p>
            <div
              style={{
                height: 10,
                borderRadius: 999,
                background: "var(--surface-2, #1e2430)",
                overflow: "hidden"
              }}
            >
              <div
                style={{
                  width: `${metaPct}%`,
                  height: "100%",
                  background: "var(--accent, #3d8bfd)",
                  transition: "width 200ms ease"
                }}
              />
            </div>
            <p className="tiny" style={{ marginTop: 6 }}>
              {metaPct}% de la meta
            </p>
          </>
        ) : (
          <p className="muted tiny">
            Sin meta configurada. Define la meta diaria en Configuración → Operación.
          </p>
        )}
      </Card>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
        <Card>
          <CardHead title="Embudo CRM" />
          {leads.length === 0 ? (
            <p className="muted tiny">Sin leads aún. Post-llamada y LIWA alimentan el funnel.</p>
          ) : (
            <FunnelChart stages={funnel} />
          )}
        </Card>
        <Card>
          <CardHead title="Mix canal (analytics)" />
          <DonutChart slices={channelSlices} centerLabel="Salidas" />
        </Card>
        <Card>
          <CardHead title="Contactabilidad" />
          <GaugeChart value={completionRate} label="Llamadas completadas / solicitadas" />
          <div style={{ marginTop: 8 }}>
            <p className="muted tiny" style={{ marginBottom: 4 }}>
              Completadas · 14 días
            </p>
            <Sparkline data={sparkCalls} />
          </div>
        </Card>
      </div>

      <Card>
        <CardHead title="Bootstrap" />
        <p className="muted tiny" style={{ marginBottom: 8 }}>
          Inicializa snapshot del tenant y las 9 agencias Coopfuturo.
        </p>
        <button className="btn btn-primary" type="button" disabled={!canWriteOps} onClick={onBootstrap}>
          Inicializar tenant + 9 agencias
        </button>
      </Card>
    </div>
  );
}
