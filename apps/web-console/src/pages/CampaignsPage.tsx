import { Megaphone, MessageCircle, Phone, Target } from "lucide-react";
import { useMemo, useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { Layout } from "../components/Layout.js";
import { Card, CardHead, EmptyState, Kpi, LoadingState, Pill } from "../components/ui.js";
import { tenantPath, useConsole } from "../lib/context.js";
import { GREEN, LINE, RED } from "../lib/format.js";
import { usePolling } from "../lib/hooks.js";

interface Campaign {
  id: string;
  name: string;
  campaignType: "reminder" | "reactivation" | "confirmation" | "survey" | "reschedule";
  status: "draft" | "active" | "paused" | "finished";
  channels: string[];
  stats: Record<string, number | Record<string, number>>;
}

const TYPE_LABELS: Record<string, string> = {
  reminder: "Recordatorio",
  reactivation: "Reactivacion",
  confirmation: "Confirmacion",
  survey: "Encuesta",
  reschedule: "Reprogramacion"
};

const STATUS_TONE: Record<string, "green" | "amber" | "blue"> = {
  active: "green",
  paused: "amber",
  draft: "blue",
  finished: "blue"
};

export function CampaignsPage() {
  const { tenant, logout } = useConsole();
  const { data, loading, error } = usePolling<Campaign[]>(tenantPath(tenant.id, "campaigns"), 30_000, logout);
  const [selectedId, setSelectedId] = useState<string>();

  const campaigns = useMemo(() => data ?? [], [data]);
  const selected = campaigns.find((c) => c.id === selectedId) ?? campaigns[0];

  const totals = useMemo(() => {
    let voice = 0;
    let whatsapp = 0;
    for (const campaign of campaigns) {
      if (campaign.channels.includes("voice")) voice += num(campaign.stats.contacted);
      if (campaign.channels.includes("whatsapp")) whatsapp += num(campaign.stats.contacted);
    }
    return { active: campaigns.filter((c) => c.status === "active").length, voice, whatsapp };
  }, [campaigns]);

  return (
    <Layout title="Campanas outbound" subtitle="Motor de contactacion (simulado, sin proveedor real)">
      {error ? (
        <div className="banner">{error}</div>
      ) : !data && loading ? (
        <LoadingState />
      ) : (
        <>
          <div className="grid kpi-row">
            <Kpi label="Campanas activas" value={totals.active} icon={<Megaphone size={16} />} />
            <Kpi label="Contactos por voz" value={totals.voice} icon={<Phone size={16} />} />
            <Kpi label="Contactos por WhatsApp" value={totals.whatsapp} icon={<MessageCircle size={16} />} />
          </div>

          <div className="grid" style={{ gridTemplateColumns: "1.5fr 1fr", alignItems: "start" }}>
            <div className="col" style={{ gap: 12 }}>
              {campaigns.length === 0 ? (
                <Card>
                  <EmptyState label="No hay campanas creadas" />
                </Card>
              ) : (
                campaigns.map((campaign) => {
                  const total = num(campaign.stats.total);
                  const contacted = num(campaign.stats.contacted);
                  const progress = total > 0 ? Math.round((100 * contacted) / total) : 0;
                  return (
                    <button
                      key={campaign.id}
                      type="button"
                      className="card card-pad col"
                      onClick={() => setSelectedId(campaign.id)}
                      style={{
                        gap: 10,
                        textAlign: "left",
                        cursor: "pointer",
                        borderColor: campaign.id === selected?.id ? GREEN : undefined
                      }}
                    >
                      <div className="row between">
                        <div className="row" style={{ gap: 10 }}>
                          <Megaphone size={18} className="muted" />
                          <strong>{campaign.name}</strong>
                        </div>
                        <Pill tone={STATUS_TONE[campaign.status]}>{campaign.status}</Pill>
                      </div>
                      <div className="row" style={{ gap: 8 }}>
                        <Pill>{TYPE_LABELS[campaign.campaignType]}</Pill>
                        <span className="tiny muted">{campaign.channels.join(" + ")}</span>
                      </div>
                      <div style={{ height: 8, background: "var(--surface-2)", borderRadius: 999 }}>
                        <div style={{ width: `${progress}%`, height: "100%", background: GREEN, borderRadius: 999 }} />
                      </div>
                      <div className="row between tiny muted">
                        <span>
                          {contacted}/{total} contactados ({progress}%)
                        </span>
                        {campaign.stats.appointments ? <span>{num(campaign.stats.appointments)} citas</span> : null}
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            {selected ? <CampaignDetail campaign={selected} /> : null}
          </div>
        </>
      )}
    </Layout>
  );
}

function CampaignDetail({ campaign }: { campaign: Campaign }) {
  const results = (campaign.stats.results as Record<string, number> | undefined) ?? undefined;
  const donut = results
    ? [
        { name: "Interesado", value: num(results.interested), color: GREEN },
        { name: "Volvera a llamar", value: num(results.willCallBack), color: "#3d7dbf" },
        { name: "No interesado", value: num(results.notInterested), color: RED },
        { name: "No contesta", value: num(results.noAnswer), color: "#c9d3ce" }
      ].filter((slice) => slice.value > 0)
    : [];
  const totalDonut = donut.reduce((sum, slice) => sum + slice.value, 0);

  return (
    <Card>
      <CardHead title={`Detalle: ${campaign.name}`} icon={<Target size={18} />} />
      <div className="card-pad col" style={{ gap: 16 }}>
        {donut.length > 0 ? (
          <>
            <span className="tiny muted">Resultado de contactos</span>
            <div className="row" style={{ gap: 16 }}>
              <div style={{ width: 130, height: 130 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={donut} dataKey="value" innerRadius={40} outerRadius={62} paddingAngle={2}>
                      {donut.map((slice) => (
                        <Cell key={slice.name} fill={slice.color} stroke="none" />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="col" style={{ gap: 8, flex: 1 }}>
                {donut.map((slice) => (
                  <div key={slice.name} className="row between">
                    <span className="row small" style={{ gap: 8 }}>
                      <span className="dot" style={{ background: slice.color }} />
                      {slice.name}
                    </span>
                    <strong className="small">
                      {totalDonut > 0 ? Math.round((100 * slice.value) / totalDonut) : 0}%
                    </strong>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <SummaryStats campaign={campaign} />
        )}

        {num(campaign.stats.csat) > 0 ? (
          <div className="row between" style={{ borderTop: `1px solid ${LINE}`, paddingTop: 12 }}>
            <span className="small muted">CSAT</span>
            <strong>{num(campaign.stats.csat)}/5</strong>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function SummaryStats({ campaign }: { campaign: Campaign }) {
  const entries = Object.entries(campaign.stats).filter(([, value]) => typeof value === "number");
  return (
    <div className="col" style={{ gap: 8 }}>
      {entries.map(([key, value]) => (
        <div key={key} className="row between">
          <span className="small muted">{humanKey(key)}</span>
          <strong className="small">{value as number}</strong>
        </div>
      ))}
    </div>
  );
}

function humanKey(key: string): string {
  const map: Record<string, string> = {
    contacted: "Contactados",
    total: "Total",
    confirmedPct: "Confirmados %",
    rescheduledPct: "Reagendados %",
    cancelledPct: "Cancelados %",
    interestPct: "Interes %",
    appointments: "Citas generadas",
    confirmed: "Confirmados",
    pending: "Pendientes",
    responsePct: "Respuesta %"
  };
  return map[key] ?? key;
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
