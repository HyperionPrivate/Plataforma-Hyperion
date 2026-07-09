import { CalendarDays, Clock } from "lucide-react";
import { useMemo } from "react";
import { Layout } from "../components/Layout.js";
import { Card, CardHead, EmptyState, LoadingState, Pill } from "../components/ui.js";
import { tenantPath, useConsole } from "../lib/context.js";
import { formatTime, LINE } from "../lib/format.js";
import { usePolling } from "../lib/hooks.js";

interface AgendaResponse {
  appointments: Array<{
    id: string;
    scheduledAt: string | null;
    status: string;
    origin: string;
    professionalId: string | null;
    professionalName: string | null;
    subspecialty: string | null;
    appointmentTypeLabel: string | null;
    appointmentCategory: string | null;
    patientName: string | null;
  }>;
  summary: {
    total: number;
    confirmed: number;
    bySofia: number;
    noShow: number;
    today: number;
    bySofiaToday: number;
  };
  waitlist: Array<{
    id: string;
    clinicalPriority: number;
    status: string;
    patientName: string | null;
    appointmentTypeName: string | null;
  }>;
}

const DAYS = ["Lun", "Mar", "Mie", "Jue", "Vie"];
const HOURS = Array.from({ length: 11 }, (_, index) => 7 + index);

function statusStyle(status: string): { bg: string; border: string; label: string } {
  switch (status) {
    case "confirmed":
      return { bg: "var(--green-soft)", border: "#2f9e6e", label: "Confirmada" };
    case "verified":
    case "registered":
      return { bg: "#fff", border: "#8fd3b6", label: "Agendada" };
    case "rescheduled":
      return {
        bg: "repeating-linear-gradient(45deg,#eef2f0,#eef2f0 4px,#fff 4px,#fff 8px)",
        border: "#d99a2b",
        label: "Reagendada"
      };
    case "no_show":
      return { bg: "var(--danger-soft)", border: "#d1584f", label: "No-show" };
    case "cancelled":
      return { bg: "var(--surface-2)", border: "#c9d3ce", label: "Cancelada" };
    default:
      return { bg: "#fff", border: LINE, label: status };
  }
}

export function AgendaPage() {
  const { tenant, activeSiteId, logout, sites } = useConsole();
  const suffix = activeSiteId === "all" ? "agenda/week" : `agenda/week?siteId=${activeSiteId}`;
  const { data, loading, error } = usePolling<AgendaResponse>(tenantPath(tenant.id, suffix), 30_000, logout);

  const siteLabel = activeSiteId === "all" ? "Todas las sedes" : (sites.find((s) => s.id === activeSiteId)?.name ?? "");

  const byDayHour = useMemo(() => {
    const map = new Map<string, AgendaResponse["appointments"]>();
    for (const appointment of data?.appointments ?? []) {
      if (!appointment.scheduledAt) continue;
      const date = new Date(appointment.scheduledAt);
      const bogota = new Date(date.toLocaleString("en-US", { timeZone: "America/Bogota" }));
      const weekday = bogota.getDay();
      if (weekday < 1 || weekday > 5) continue;
      const key = `${weekday}-${bogota.getHours()}`;
      const list = map.get(key) ?? [];
      list.push(appointment);
      map.set(key, list);
    }
    return map;
  }, [data]);

  return (
    <Layout title="Agenda de citas" subtitle={siteLabel}>
      {error ? (
        <div className="banner">{error}</div>
      ) : !data && loading ? (
        <LoadingState />
      ) : data ? (
        <div className="grid" style={{ gridTemplateColumns: "1fr 300px", alignItems: "start", gap: 16 }}>
          <Card>
            <CardHead
              title="Semana actual"
              icon={<CalendarDays size={18} />}
              trailing={
                <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                  <LegendDot color="#2f9e6e" label="Confirmada" />
                  <LegendDot color="#8fd3b6" label="Agendada" />
                  <LegendDot color="#d99a2b" label="Reagendada" />
                  <LegendDot color="#d1584f" label="No-show" />
                </div>
              }
            />
            <div style={{ overflowX: "auto" }}>
              <div style={{ minWidth: 720 }}>
                <div style={{ display: "grid", gridTemplateColumns: "60px repeat(5, 1fr)" }}>
                  <div />
                  {DAYS.map((day) => (
                    <div
                      key={day}
                      style={{ padding: "10px 8px", fontWeight: 700, fontSize: 13, borderBottom: `1px solid ${LINE}` }}
                    >
                      {day}
                    </div>
                  ))}
                  {HOURS.map((hour) => (
                    <RowForHour key={hour} hour={hour} byDayHour={byDayHour} />
                  ))}
                </div>
              </div>
            </div>
          </Card>

          <div className="col" style={{ gap: 16 }}>
            <Card>
              <CardHead title="Resumen de la semana" />
              <div className="card-pad grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <Metric label="Citas totales" value={data.summary.total} />
                <Metric label="Confirmadas" value={pct(data.summary.confirmed, data.summary.total)} />
                <Metric label="Origen Sofia" value={pct(data.summary.bySofia, data.summary.total)} />
                <Metric label="No-show" value={pct(data.summary.noShow, data.summary.total)} />
              </div>
            </Card>

            <Card>
              <CardHead title={`Lista de espera (${data.waitlist.length})`} icon={<Clock size={18} />} />
              <div>
                {data.waitlist.length === 0 ? (
                  <EmptyState label="Sin pacientes en lista de espera" />
                ) : (
                  data.waitlist.map((entry, index) => (
                    <div
                      key={entry.id}
                      className="row"
                      style={{ padding: "10px 16px", borderBottom: `1px solid ${LINE}`, gap: 10 }}
                    >
                      <span className="avatar" style={{ background: "var(--surface-2)", color: "var(--ink-2)" }}>
                        {index + 1}
                      </span>
                      <div className="col" style={{ flex: 1 }}>
                        <strong className="small">{entry.patientName ?? "Paciente"}</strong>
                        <span className="tiny muted">{entry.appointmentTypeName ?? "Cita"}</span>
                      </div>
                      {entry.clinicalPriority <= 15 ? <Pill tone="amber">Prioridad</Pill> : null}
                    </div>
                  ))
                )}
              </div>
            </Card>
          </div>
        </div>
      ) : (
        <EmptyState label="Sin agenda" />
      )}
    </Layout>
  );
}

function RowForHour({ hour, byDayHour }: { hour: number; byDayHour: Map<string, AgendaResponse["appointments"]> }) {
  return (
    <>
      <div style={{ padding: "8px", fontSize: 12, color: "var(--ink-2)", borderBottom: `1px solid ${LINE}` }}>
        {hour}:00
      </div>
      {[1, 2, 3, 4, 5].map((weekday) => {
        const items = byDayHour.get(`${weekday}-${hour}`) ?? [];
        const top = items[0];
        return (
          <div
            key={weekday}
            style={{ padding: 4, borderBottom: `1px solid ${LINE}`, borderLeft: `1px solid ${LINE}`, minHeight: 46 }}
          >
            {top ? <SlotCard appointment={top} extra={items.length - 1} /> : null}
          </div>
        );
      })}
    </>
  );
}

function SlotCard({ appointment, extra }: { appointment: AgendaResponse["appointments"][number]; extra: number }) {
  const style = statusStyle(appointment.status);
  return (
    <div
      title={`${appointment.patientName ?? "Paciente"} - ${style.label}`}
      style={{
        background: style.bg,
        borderLeft: `3px solid ${style.border}`,
        borderRadius: 6,
        padding: "4px 6px",
        fontSize: 11,
        lineHeight: 1.3
      }}
    >
      <div className="row between">
        <strong>{appointment.scheduledAt ? formatTime(appointment.scheduledAt) : ""}</strong>
        {appointment.origin.startsWith("sofia") ? <span className="dot" title="Origen Sofia" /> : null}
      </div>
      <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {appointment.professionalName ?? appointment.appointmentTypeLabel ?? "Cita"}
      </div>
      {extra > 0 ? <span className="tiny muted">+{extra} mas</span> : null}
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="row tiny muted" style={{ gap: 4 }}>
      <span className="dot" style={{ background: color }} /> {label}
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="col" style={{ gap: 2 }}>
      <span className="kpi-value" style={{ fontSize: 22 }}>
        {value}
      </span>
      <span className="tiny muted">{label}</span>
    </div>
  );
}

function pct(part: number, total: number): string {
  if (!total) return "0%";
  return `${Math.round((100 * part) / total)}%`;
}
