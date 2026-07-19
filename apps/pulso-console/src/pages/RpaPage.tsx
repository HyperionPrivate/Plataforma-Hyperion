import { Bot, CheckCircle2, Clock, ListChecks, Server } from "lucide-react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Layout } from "../components/Layout.js";
import { Card, CardHead, EmptyState, Kpi, LoadingState, Pill } from "../components/ui.js";
import { tenantPath, useConsole } from "../lib/context.js";
import { formatTime, GREEN, INK_2, LINE } from "../lib/format.js";
import { usePolling } from "../lib/hooks.js";

interface RpaStatus {
  workers: Array<{
    id: string;
    name: string;
    vpsHost: string | null;
    status: "active" | "standby" | "quarantine" | "maintenance" | "inactive";
    currentAction: string | null;
    cpuPct: number;
    sessionStartedAt: string | null;
    lastKeepaliveAt: string | null;
  }>;
  kpis: {
    actionsToday: number;
    queued: number;
    deferred: number;
    successPctToday: number | null;
    avgConsultSeconds: number | null;
    p95RegisterSeconds: number | null;
  };
  queue: Array<{
    id: string;
    actionType: string;
    status: string;
    priority: number;
    phase: string | null;
    durationMs: number | null;
    conversationId: string | null;
    createdAt: string;
  }>;
  telemetry: Array<{ hour: string; avgSeconds: number; actions: number }>;
  events: Array<{
    id: string;
    level: "info" | "warn" | "error";
    message: string;
    createdAt: string;
    workerName: string | null;
  }>;
}

const WORKER_STATUS: Record<string, { label: string; tone: "green" | "amber" | "red" | "blue" }> = {
  active: { label: "Activo", tone: "green" },
  standby: { label: "Standby", tone: "blue" },
  quarantine: { label: "Cuarentena", tone: "red" },
  maintenance: { label: "Mantenimiento", tone: "amber" },
  inactive: { label: "Inactivo", tone: "amber" }
};

const ACTION_LABELS: Record<string, string> = {
  check_availability: "Consulta disponibilidad",
  register_appointment: "Registrar cita",
  cancel: "Cancelar",
  reschedule: "Reagendar",
  confirm: "Confirmar",
  sweep: "Barrido",
  create_patient: "Alta paciente"
};

export function RpaPage() {
  const { tenant, logout } = useConsole();
  const { data, loading, error } = usePolling<RpaStatus>(tenantPath(tenant.id, "rpa/status"), 8_000, logout);

  return (
    <Layout title="Monitor de Workers RPA" subtitle="Software de agendamiento CEDCO (simulado, sin proveedor real)">
      {error ? (
        <div className="banner">{error}</div>
      ) : !data && loading ? (
        <LoadingState />
      ) : data ? (
        <>
          <div className="grid kpi-row">
            <Kpi
              label="Workers activos"
              value={`${data.workers.filter((w) => w.status === "active").length}/${data.workers.length}`}
              icon={<Server size={16} />}
            />
            <Kpi label="Acciones hoy" value={data.kpis.actionsToday} icon={<ListChecks size={16} />} />
            <Kpi label="Acciones en cola" value={data.kpis.queued} icon={<Clock size={16} />} />
            <Kpi
              label="Latencia consulta"
              value={data.kpis.avgConsultSeconds == null ? "-" : `${data.kpis.avgConsultSeconds} s`}
              icon={<Clock size={16} />}
            />
            <Kpi
              label="Exito verificado hoy"
              value={data.kpis.successPctToday == null ? "-" : `${data.kpis.successPctToday}%`}
              icon={<CheckCircle2 size={16} />}
            />
          </div>

          <Card>
            <CardHead title="Flota de workers" icon={<Bot size={18} />} />
            <div className="card-pad grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))" }}>
              {data.workers.map((worker) => {
                const status = WORKER_STATUS[worker.status] ?? WORKER_STATUS.inactive;
                return (
                  <div key={worker.id} className="card card-pad col" style={{ gap: 8 }}>
                    <div className="row between">
                      <strong>{worker.name}</strong>
                      <Pill tone={status.tone}>{status.label}</Pill>
                    </div>
                    <span className="tiny muted">{worker.vpsHost ?? "Sin host"}</span>
                    <div
                      style={{
                        height: 74,
                        borderRadius: 6,
                        background: "var(--surface)",
                        border: `1px solid ${LINE}`,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "var(--ink-3)",
                        fontSize: 11,
                        textAlign: "center",
                        padding: 6
                      }}
                    >
                      {worker.currentAction ? `${worker.currentAction}` : "Sesion inactiva"}
                    </div>
                    <div className="row between tiny muted">
                      <span>CPU {worker.cpuPct}%</span>
                      <span>keep-alive {worker.lastKeepaliveAt ? formatTime(worker.lastKeepaliveAt) : "-"}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <Card>
              <CardHead title="Cola de acciones" icon={<ListChecks size={18} />} />
              <div style={{ overflowX: "auto", maxHeight: 320, overflowY: "auto" }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Tipo</th>
                      <th>Prioridad</th>
                      <th>Estado</th>
                      <th>Duracion</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.queue.map((action) => (
                      <tr key={action.id}>
                        <td className="small">{ACTION_LABELS[action.actionType] ?? action.actionType}</td>
                        <td>
                          <Pill tone={action.priority <= 15 ? "red" : action.priority <= 40 ? "amber" : "blue"}>
                            P{action.priority}
                          </Pill>
                        </td>
                        <td>
                          <Pill tone={queueTone(action.status)}>{queueLabel(action.status)}</Pill>
                        </td>
                        <td className="small muted">
                          {action.durationMs ? `${(action.durationMs / 1000).toFixed(1)} s` : (action.phase ?? "-")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card>
              <CardHead title="Telemetria (12 h)" icon={<Clock size={18} />} />
              <div className="card-pad" style={{ height: 200 }}>
                {data.telemetry.length === 0 ? (
                  <EmptyState label="Sin telemetria" />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.telemetry.map((t) => ({ hora: formatTime(t.hour), seg: t.avgSeconds }))}>
                      <XAxis dataKey="hora" tick={{ fontSize: 10, fill: INK_2 }} stroke={LINE} />
                      <YAxis tick={{ fontSize: 10, fill: INK_2 }} stroke={LINE} />
                      <Tooltip />
                      <Bar dataKey="seg" fill={GREEN} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
              <div style={{ borderTop: `1px solid ${LINE}`, maxHeight: 120, overflowY: "auto" }}>
                {data.events.map((event) => (
                  <div key={event.id} className="row" style={{ gap: 8, padding: "8px 16px" }}>
                    <span
                      className="dot"
                      style={{
                        background: event.level === "warn" ? "#d99a2b" : event.level === "error" ? "#d1584f" : GREEN
                      }}
                    />
                    <span className="tiny muted" style={{ minWidth: 44 }}>
                      {formatTime(event.createdAt)}
                    </span>
                    <span className="tiny">
                      {event.workerName ? `${event.workerName} - ` : ""}
                      {event.message}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </>
      ) : (
        <EmptyState label="Sin datos de RPA" />
      )}
    </Layout>
  );
}

function queueTone(status: string): "green" | "amber" | "red" | "blue" {
  if (status === "succeeded") return "green";
  if (status === "running") return "amber";
  if (status === "failed" || status === "verification_failed") return "red";
  return "blue";
}

function queueLabel(status: string): string {
  const map: Record<string, string> = {
    queued: "En cola",
    running: "En proceso",
    succeeded: "Completado",
    verification_failed: "Verif. fallida",
    deferred: "Diferida",
    failed: "Error"
  };
  return map[status] ?? status;
}
