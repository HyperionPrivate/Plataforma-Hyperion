import { Activity, Bot, CalendarCheck, MessageCircle, Phone, RefreshCw, UserRoundCog } from "lucide-react";
import { Area, AreaChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Layout } from "../components/Layout.js";
import { Avatar, Card, CardHead, EmptyState, Kpi, LoadingState, Pill } from "../components/ui.js";
import { useConsole } from "../lib/context.js";
import { AMBER, GREEN, hourLabel, INK_2, LINE, RED, relativeWait, trendLabel } from "../lib/format.js";
import { usePolling } from "../lib/hooks.js";
import { tenantPath } from "../lib/context.js";

interface LiveDashboard {
  kpis: {
    interactionsActive: number;
    whatsappToday: number;
    voiceToday: number;
    whatsappYesterday: number;
    voiceYesterday: number;
    totalToday: number;
    absorptionPct: number | null;
    handoffPct: number | null;
    appointmentsTodayBySofia: number;
    handoffsOpen: number;
  };
  interactionsByHour: Array<{ hour: number; total: number; voice: number; whatsapp: number }>;
  resolution: { resolvedByIa: number; transferred: number; abandoned: number };
  handoffQueue: Array<{
    id: string;
    triggerCode: string;
    priority: "max" | "high" | "medium" | "low";
    status: string;
    patientName: string | null;
    patientStatus: string | null;
    waitingSeconds: number;
  }>;
  siteActivity: Array<{
    siteId: string;
    siteName: string;
    interactions: number;
    appointments: number;
    avgResponseSeconds: number | null;
    absorptionPct: number | null;
    handoffPct: number | null;
  }>;
  rpaHealth: { workersActive: number; workersTotal: number; queueDepth: number; deferred: number };
}

const TRIGGER_LABELS: Record<string, { label: string; tone: "green" | "red" | "amber" | "blue" }> = {
  urgencia_oftalmologica: { label: "Urgencia ocular", tone: "red" },
  programacion_cirugia: { label: "Pregunta de cirugia", tone: "blue" },
  autorizacion_eps_compleja: { label: "Autorizacion EPS", tone: "amber" },
  caso_sensible: { label: "Seguimiento medico", tone: "amber" },
  queja_pqrs: { label: "PQRS", tone: "amber" },
  fuera_de_alcance: { label: "Fuera de alcance", tone: "blue" },
  solicitud_explicita_humano: { label: "Pide humano", tone: "blue" },
  fallo_comprension: { label: "Fallo comprension", tone: "blue" }
};

const PRIORITY_TONE: Record<string, "green" | "red" | "amber" | "blue"> = {
  max: "red",
  high: "amber",
  medium: "blue",
  low: "green"
};

export function OperationPage() {
  const { tenant, activeSiteId, logout } = useConsole();
  const suffix = activeSiteId === "all" ? "dashboard/live" : `dashboard/live?siteId=${activeSiteId}`;
  const { data, loading, error, refresh } = usePolling<LiveDashboard>(tenantPath(tenant.id, suffix), 10_000, logout);

  return (
    <Layout
      title="Operacion en vivo"
      subtitle="Estado de Sofia en las dos lineas y WhatsApp"
      actions={
        <span className="chip live">
          <span className="dot" /> SOFIA activa
        </span>
      }
    >
      {error ? (
        <div className="banner">{error}</div>
      ) : !data && loading ? (
        <LoadingState />
      ) : data ? (
        <OperationContent data={data} onRefresh={refresh} />
      ) : (
        <EmptyState label="Sin datos de operacion" />
      )}
    </Layout>
  );
}

function OperationContent({ data, onRefresh }: { data: LiveDashboard; onRefresh: () => void }) {
  const { kpis, resolution } = data;
  const totalResolution = resolution.resolvedByIa + resolution.transferred + resolution.abandoned;
  const donutData = [
    { name: "Resuelto por IA", value: resolution.resolvedByIa, color: GREEN },
    { name: "Transferido", value: resolution.transferred, color: AMBER },
    { name: "Abandono", value: resolution.abandoned, color: RED }
  ].filter((slice) => slice.value > 0);

  const hourData = data.interactionsByHour.map((row) => ({
    hour: hourLabel(row.hour),
    Voz: row.voice,
    WhatsApp: row.whatsapp
  }));

  return (
    <>
      <div className="grid kpi-row">
        <Kpi label="Interacciones activas" value={kpis.interactionsActive} icon={<Activity size={16} />} />
        <Kpi
          label="WhatsApp hoy"
          value={kpis.whatsappToday}
          icon={<MessageCircle size={16} />}
          trend={trendLabel(kpis.whatsappToday, kpis.whatsappYesterday)}
        />
        <Kpi
          label="Llamadas de voz hoy"
          value={kpis.voiceToday}
          icon={<Phone size={16} />}
          trend={trendLabel(kpis.voiceToday, kpis.voiceYesterday)}
        />
        <Kpi
          label="Absorcion IA"
          value={kpis.absorptionPct == null ? "-" : `${kpis.absorptionPct}%`}
          icon={<Bot size={16} />}
        />
        <Kpi label="Citas por Sofia hoy" value={kpis.appointmentsTodayBySofia} icon={<CalendarCheck size={16} />} />
        <Kpi label="Handoffs abiertos" value={kpis.handoffsOpen} icon={<UserRoundCog size={16} />} />
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1.4fr 1fr" }}>
        <Card>
          <CardHead
            title="Interacciones por hora"
            icon={<Activity size={18} />}
            trailing={
              <button className="icon-btn" type="button" onClick={onRefresh} aria-label="Actualizar">
                <RefreshCw size={16} />
              </button>
            }
          />
          <div className="card-pad" style={{ height: 260 }}>
            {hourData.length === 0 ? (
              <EmptyState label="Aun no hay interacciones hoy" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={hourData} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                  <defs>
                    <linearGradient id="voz" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={GREEN} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={GREEN} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="hour"
                    tick={{ fontSize: 11, fill: INK_2 }}
                    stroke={LINE}
                    interval="preserveStartEnd"
                  />
                  <YAxis tick={{ fontSize: 11, fill: INK_2 }} stroke={LINE} />
                  <Tooltip />
                  <Area type="monotone" dataKey="Voz" stroke={GREEN} strokeWidth={2} fill="url(#voz)" />
                  <Area type="monotone" dataKey="WhatsApp" stroke="#7cc4a4" strokeWidth={2} fill="transparent" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        <Card>
          <CardHead title="Resolucion" icon={<Bot size={18} />} />
          <div className="card-pad row" style={{ gap: 20, alignItems: "center" }}>
            <div style={{ width: 150, height: 170, position: "relative" }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={donutData}
                    dataKey="value"
                    innerRadius={52}
                    outerRadius={74}
                    paddingAngle={2}
                    startAngle={90}
                    endAngle={-270}
                  >
                    {donutData.map((slice) => (
                      <Cell key={slice.name} fill={slice.color} stroke="none" />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center"
                }}
              >
                <strong style={{ fontSize: 24 }}>{kpis.absorptionPct == null ? "-" : `${kpis.absorptionPct}%`}</strong>
                <span className="tiny muted">Resuelto por IA</span>
              </div>
            </div>
            <div className="col" style={{ gap: 10, flex: 1 }}>
              {donutData.map((slice) => (
                <div key={slice.name} className="row between">
                  <span className="row small" style={{ gap: 8 }}>
                    <span className="dot" style={{ background: slice.color }} />
                    {slice.name}
                  </span>
                  <strong className="small">
                    {totalResolution > 0 ? Math.round((100 * slice.value) / totalResolution) : 0}%
                  </strong>
                </div>
              ))}
            </div>
          </div>
        </Card>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <Card>
          <CardHead title={`Cola de handoff (${data.handoffQueue.length})`} icon={<UserRoundCog size={18} />} />
          <div>
            {data.handoffQueue.length === 0 ? (
              <EmptyState label="Sin handoffs en cola" />
            ) : (
              data.handoffQueue.map((handoff) => {
                const trigger = TRIGGER_LABELS[handoff.triggerCode] ?? {
                  label: handoff.triggerCode,
                  tone: "blue" as const
                };
                return (
                  <div
                    key={handoff.id}
                    className="row"
                    style={{ padding: "12px 18px", borderBottom: `1px solid ${LINE}` }}
                  >
                    <Avatar name={handoff.patientName} />
                    <div className="col" style={{ flex: 1 }}>
                      <strong className="small">{handoff.patientName ?? "Paciente sin identificar"}</strong>
                      <span className="tiny muted">{humanStatus(handoff.status)}</span>
                    </div>
                    <Pill tone={trigger.tone}>{trigger.label}</Pill>
                    <div className="col" style={{ alignItems: "flex-end", minWidth: 54 }}>
                      <strong
                        className="small"
                        style={{ color: PRIORITY_TONE[handoff.priority] === "red" ? RED : undefined }}
                      >
                        {relativeWait(handoff.waitingSeconds)}
                      </strong>
                      <span className="tiny muted">en espera</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </Card>

        <Card>
          <CardHead title="Salud RPA" icon={<Bot size={18} />} />
          <div className="card-pad grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <MiniStat
              label="Workers activos"
              value={`${data.rpaHealth.workersActive}/${data.rpaHealth.workersTotal}`}
            />
            <MiniStat label="Acciones en cola" value={String(data.rpaHealth.queueDepth)} />
            <MiniStat label="Diferidas" value={String(data.rpaHealth.deferred)} />
            <MiniStat label="Handoff %" value={kpis.handoffPct == null ? "-" : `${kpis.handoffPct}%`} />
          </div>
        </Card>
      </div>

      <Card>
        <CardHead
          title="Actividad por sede"
          icon={<Activity size={18} />}
          trailing={
            <span className="chip live">
              <span className="dot" /> Tiempo real
            </span>
          }
        />
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Sede</th>
                <th>Interacciones</th>
                <th>Citas agendadas</th>
                <th>Tiempo medio respuesta</th>
                <th>Absorcion IA</th>
                <th>Handoff</th>
              </tr>
            </thead>
            <tbody>
              {data.siteActivity.map((site) => (
                <tr key={site.siteId}>
                  <td>
                    <strong className="small">{site.siteName}</strong>
                  </td>
                  <td>{site.interactions}</td>
                  <td>{site.appointments}</td>
                  <td>{site.avgResponseSeconds == null ? "-" : `${site.avgResponseSeconds} s`}</td>
                  <td>{site.absorptionPct == null ? "-" : `${site.absorptionPct}%`}</td>
                  <td>{site.handoffPct == null ? "-" : `${site.handoffPct}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="col" style={{ gap: 2 }}>
      <span className="kpi-value" style={{ fontSize: 22 }}>
        {value}
      </span>
      <span className="tiny muted">{label}</span>
    </div>
  );
}

function humanStatus(status: string): string {
  const map: Record<string, string> = {
    open: "En espera",
    assigned: "Asignado",
    in_progress: "En gestion"
  };
  return map[status] ?? status;
}
