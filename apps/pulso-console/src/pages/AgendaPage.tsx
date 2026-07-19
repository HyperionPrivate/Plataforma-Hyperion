import {
  AlertTriangle,
  Ban,
  CalendarCheck,
  CalendarDays,
  CheckCircle2,
  Clock,
  ExternalLink,
  History,
  ListChecks,
  MessageCircle,
  Plus,
  RefreshCw,
  RotateCw,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type {
  PulsoIrisAppointmentType,
  PulsoIrisAvailabilitySlot,
  PulsoIrisAvailabilitySlots,
  PulsoIrisPayer,
  PulsoIrisProfessional,
  PulsoIrisSite,
  PulsoIrisSlotAlternative
} from "@hyperion/pulso-contracts";
import type { PlatformRole as OperatorRole } from "@hyperion/platform-contracts";
import { Layout } from "../components/Layout.js";
import { Card, CardHead, EmptyState, LoadingState, Pill } from "../components/ui.js";
import { api, ApiError, SessionExpiredError } from "../lib/api.js";
import {
  normalizeQueueResponse,
  queueConfigurationLabel,
  queuePrimaryLabel,
  queueScheduleLabel,
  queueStatusLabel,
  queueTone,
  queueViewFor,
  type AgendaQueueItem,
  type AgendaQueueResponse,
  type AgendaQueueView
} from "../lib/agenda-model.js";
import { tenantPath, useConsole } from "../lib/context.js";
import { formatTime, LINE } from "../lib/format.js";
import { usePolling } from "../lib/hooks.js";
import { can } from "../lib/rbac.js";
import { hasPulsoCapability } from "../lib/session.js";

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
    professionalIsPilot?: boolean;
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
      return { bg: "var(--green-soft)", border: "#2f9e6e", label: "Verificada" };
    case "registered":
      return { bg: "#fff", border: "#8fd3b6", label: "Registrada" };
    case "rescheduled":
      return {
        bg: "repeating-linear-gradient(45deg,#eef2f0,#eef2f0 4px,#fff 4px,#fff 8px)",
        border: "#d99a2b",
        label: "Reagendada"
      };
    case "pending_external_confirmation":
    case "pending_provider":
    case "submitted":
    case "deferred":
      return { bg: "var(--warning-soft)", border: "#d99a2b", label: queueStatusLabel(status) };
    case "external_rejected":
    case "verification_failed":
    case "failed":
    case "expired":
      return { bg: "var(--danger-soft)", border: "#d1584f", label: queueStatusLabel(status) };
    case "no_show":
      return { bg: "var(--danger-soft)", border: "#d1584f", label: "No-show" };
    case "cancelled":
      return { bg: "var(--surface-2)", border: "#c9d3ce", label: "Cancelada" };
    default:
      return { bg: "#fff", border: LINE, label: status };
  }
}

export function AgendaPage() {
  const { tenant, activeSiteId, logout, sites, session, grant } = useConsole();
  const [view, setView] = useState<"calendar" | "queue">("calendar");
  const suffix = activeSiteId === "all" ? "agenda/week" : `agenda/week?siteId=${activeSiteId}`;
  const { data, loading, error, refresh } = usePolling<AgendaResponse>(tenantPath(tenant.id, suffix), 30_000, logout);

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
      <div className="segmented" role="tablist" aria-label="Vistas de agenda">
        <button
          type="button"
          role="tab"
          aria-selected={view === "calendar"}
          className={view === "calendar" ? "active" : ""}
          onClick={() => setView("calendar")}
        >
          <CalendarDays size={16} /> Calendario
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "queue"}
          className={view === "queue" ? "active" : ""}
          onClick={() => setView("queue")}
        >
          <ListChecks size={16} /> Cola de confirmacion
        </button>
      </div>
      {view === "queue" ? (
        <AgendaQueue tenantId={tenant.id} activeSiteId={activeSiteId} role={session.operator.role} logout={logout} />
      ) : error ? (
        <div className="banner">{error}</div>
      ) : !data && loading ? (
        <LoadingState />
      ) : data ? (
        <div
          className="grid agenda-layout"
          style={{ gridTemplateColumns: "minmax(0, 1fr) 300px", alignItems: "start", gap: 16 }}
        >
          <Card>
            <CardHead
              title="Semana actual"
              icon={<CalendarDays size={18} />}
              trailing={
                <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                  <LegendDot color="#2f9e6e" label="Confirmada" />
                  <LegendDot color="#8fd3b6" label="Registrada" />
                  <LegendDot color="#2f9e6e" label="Verificada" />
                  <LegendDot color="#d99a2b" label="Pendiente externa" />
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
            <AvailabilityPanel
              tenantId={tenant.id}
              activeSiteId={activeSiteId}
              sites={sites}
              canReserve={can(session.operator.role, "write:operation") && hasPulsoCapability(grant, "pulso:write")}
              onReserved={refresh}
              logout={logout}
            />

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
                        <strong className="small">{entry.patientName ?? "Identidad pendiente"}</strong>
                        <span className="tiny muted">
                          {entry.appointmentTypeName ?? "Configuracion incompleta: falta el tipo de cita"}
                        </span>
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

const QUEUE_VIEWS: Array<{ id: AgendaQueueView; label: string }> = [
  { id: "pending", label: "Pendientes / SLA" },
  { id: "verified", label: "Verificadas" },
  { id: "closed", label: "Rechazadas / canceladas" },
  { id: "holds", label: "Reservas temporales" },
  { id: "errors", label: "Errores" }
];

function AgendaQueue({
  tenantId,
  activeSiteId,
  role,
  logout
}: {
  tenantId: string;
  activeSiteId: string | "all";
  role: OperatorRole;
  logout: () => void;
}) {
  const [view, setView] = useState<AgendaQueueView>("pending");
  const [action, setAction] = useState<{ type: QueueAction; item: AgendaQueueItem }>();
  const [historyId, setHistoryId] = useState<string>();
  const suffix =
    activeSiteId === "all" ? "appointments/queue" : `appointments/queue?siteId=${encodeURIComponent(activeSiteId)}`;
  const { data, loading, error, refresh } = usePolling<AgendaQueueResponse | AgendaQueueItem[]>(
    tenantPath(tenantId, suffix),
    15_000,
    logout
  );
  const queue = data ? normalizeQueueResponse(data) : undefined;
  const items = queue?.items ?? [];
  const counts = useMemo(() => {
    const values: Record<AgendaQueueView, number> = { pending: 0, verified: 0, closed: 0, holds: 0, errors: 0 };
    for (const item of items) values[queueViewFor(item)] += 1;
    return values;
  }, [items]);
  const visible = items.filter((item) => queueViewFor(item) === view);
  const canManage = role === "admin" || role === "coordinator";

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="queue-tabs" role="tablist" aria-label="Estados de la cola">
        {QUEUE_VIEWS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={view === item.id}
            className={`queue-tab${view === item.id ? " active" : ""}`}
            onClick={() => setView(item.id)}
          >
            <span>{item.label}</span>
            <strong>{counts[item.id]}</strong>
          </button>
        ))}
      </div>

      <Card>
        <CardHead
          title={QUEUE_VIEWS.find((item) => item.id === view)?.label ?? "Cola operativa"}
          icon={view === "errors" ? <AlertTriangle size={18} /> : <ListChecks size={18} />}
          trailing={
            <button className="icon-btn" type="button" onClick={refresh} aria-label="Actualizar cola">
              <RefreshCw size={16} />
            </button>
          }
        />
        {error ? (
          <div className="banner">{error}</div>
        ) : !queue && loading ? (
          <LoadingState label="Cargando cola..." />
        ) : visible.length === 0 ? (
          <EmptyState label="No hay casos en este estado" />
        ) : (
          <div className="queue-list">
            {visible.map((item) => (
              <article key={item.id} className="queue-row">
                <div className="queue-main">
                  <div className="row" style={{ flexWrap: "wrap" }}>
                    <Pill tone={queueTone(item.status)}>{queueStatusLabel(item.status)}</Pill>
                    {item.verificationMode ? (
                      <Pill tone="blue">
                        {item.verificationMode === "manual_external"
                          ? "Verificacion manual externa"
                          : item.verificationMode === "internal"
                            ? "Verificacion interna"
                            : item.verificationMode}
                      </Pill>
                    ) : null}
                    {item.origin === "sofia_wa" ? (
                      <Pill tone="green">
                        <MessageCircle size={12} /> SOFIA WhatsApp
                      </Pill>
                    ) : null}
                    {item.professionalIsPilot ? <Pill tone="blue">Piloto</Pill> : null}
                    <QueueDeadline item={item} />
                  </div>
                  <strong>{queuePrimaryLabel(item)}</strong>
                  <span className="small muted">{queueConfigurationLabel(item)}</span>
                  <span className="tiny muted">
                    {item.scheduledAt ? formatAgendaDateTime(item.scheduledAt) : queueScheduleLabel(item)}
                  </span>
                  {item.externalReference ? (
                    <span className="tiny muted">
                      Referencia externa: {item.externalReference}
                      {item.externalSystem ? ` · ${item.externalSystem}` : ""}
                    </span>
                  ) : null}
                  {item.errorMessage ? <span className="queue-error">{item.errorMessage}</span> : null}
                </div>
                <div className="queue-actions">
                  {canManage && item.recordType === "appointment" && view === "pending" ? (
                    <>
                      <button
                        className="btn btn-primary btn-sm"
                        type="button"
                        onClick={() => setAction({ type: "verify", item })}
                      >
                        <CheckCircle2 size={15} /> Confirmar externamente
                      </button>
                      <button
                        className="btn btn-outline btn-sm"
                        type="button"
                        onClick={() => setAction({ type: "reject", item })}
                      >
                        <Ban size={15} /> Rechazar
                      </button>
                    </>
                  ) : null}
                  {canManage &&
                  item.recordType === "appointment" &&
                  !["cancelled", "rejected", "external_rejected", "expired", "rescheduled", "no_show"].includes(
                    item.status
                  ) ? (
                    <>
                      <button
                        className="btn btn-outline btn-sm"
                        type="button"
                        onClick={() => setAction({ type: "reschedule", item })}
                      >
                        <RotateCw size={15} /> Reagendar
                      </button>
                      <button
                        className="btn btn-outline btn-sm danger-action"
                        type="button"
                        onClick={() => setAction({ type: "cancel", item })}
                      >
                        <X size={15} /> Cancelar
                      </button>
                    </>
                  ) : null}
                  {item.recordType === "hold" && item.status === "active" && role !== "auditor" ? (
                    <button
                      className="btn btn-outline btn-sm danger-action"
                      type="button"
                      onClick={() => setAction({ type: "cancelHold", item })}
                    >
                      <X size={15} /> Liberar reserva
                    </button>
                  ) : null}
                  {item.conversationId ? (
                    <Link
                      className="btn btn-outline btn-sm"
                      to={`/conversaciones?conversationId=${item.conversationId}`}
                    >
                      <ExternalLink size={15} /> Conversacion
                    </Link>
                  ) : null}
                  {item.recordType === "appointment" ? (
                    <button
                      className="btn btn-outline btn-sm"
                      type="button"
                      aria-expanded={historyId === item.id}
                      onClick={() => setHistoryId((current) => (current === item.id ? undefined : item.id))}
                    >
                      <History size={15} /> Ver auditoria
                    </button>
                  ) : null}
                </div>
                {historyId === item.id ? (
                  <AppointmentHistory tenantId={tenantId} appointmentId={item.id} logout={logout} />
                ) : null}
              </article>
            ))}
          </div>
        )}
      </Card>

      {action ? (
        <QueueActionDialog
          tenantId={tenantId}
          action={action}
          onClose={() => setAction(undefined)}
          onDone={() => {
            setAction(undefined);
            refresh();
          }}
          logout={logout}
        />
      ) : null}
    </div>
  );
}

type QueueAction = "verify" | "reject" | "cancel" | "reschedule" | "cancelHold";

interface AppointmentHistoryRow {
  id?: string;
  fromStatus?: string | null;
  toStatus: string;
  actorId?: string | null;
  reason?: string | null;
  createdAt: string;
}

interface AppointmentAuditRow {
  id: string;
  eventType: string;
  actorId?: string | null;
  createdAt: string;
}

function AppointmentHistory({
  tenantId,
  appointmentId,
  logout
}: {
  tenantId: string;
  appointmentId: string;
  logout: () => void;
}) {
  const { data, loading, error } = usePolling<AppointmentHistoryRow[]>(
    tenantPath(tenantId, `appointments/${appointmentId}/history`),
    60_000,
    logout
  );
  const { data: auditEvents, error: auditError } = usePolling<AppointmentAuditRow[]>(
    tenantPath(tenantId, `appointments/${appointmentId}/audit`),
    60_000,
    logout
  );
  return (
    <div className="queue-history">
      {auditEvents?.map((event) => (
        <div className="history-row" key={event.id}>
          <span className="history-dot" />
          <div className="col">
            <strong className="small">{event.eventType.replaceAll(".", " · ")}</strong>
            <span className="tiny muted">
              {formatAgendaDateTime(event.createdAt)}
              {event.actorId ? ` · ${event.actorId}` : ""}
            </span>
          </div>
        </div>
      ))}
      {auditError ? <div className="banner">No fue posible cargar los eventos de auditoria</div> : null}
      {loading && !data ? (
        <LoadingState label="Cargando trazabilidad..." />
      ) : error ? (
        <div className="banner">{error}</div>
      ) : !data || data.length === 0 ? (
        <EmptyState label="Sin cambios de estado registrados" />
      ) : (
        data.map((row, index) => (
          <div className="history-row" key={row.id ?? `${row.createdAt}-${index}`}>
            <span className="history-dot" />
            <div className="col">
              <strong className="small">
                {row.fromStatus ? `${queueStatusLabel(row.fromStatus)} -> ` : ""}
                {queueStatusLabel(row.toStatus)}
              </strong>
              <span className="tiny muted">
                {formatAgendaDateTime(row.createdAt)}
                {row.reason ? ` · ${row.reason}` : ""}
              </span>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function QueueDeadline({ item }: { item: AgendaQueueItem }) {
  const value = item.externalConfirmationDueAt ?? item.holdExpiresAt;
  if (!value) return null;
  const minutes = Math.ceil((new Date(value).getTime() - Date.now()) / 60_000);
  const expired = minutes <= 0;
  const label = item.holdExpiresAt
    ? expired
      ? "Reserva vencida"
      : `Reserva vence en ${minutes} min`
    : expired
      ? `SLA vencido hace ${Math.abs(minutes)} min`
      : `SLA en ${minutes} min`;
  return <Pill tone={expired || minutes <= 30 ? "red" : "amber"}>{label}</Pill>;
}

function QueueActionDialog({
  tenantId,
  action,
  onClose,
  onDone,
  logout
}: {
  tenantId: string;
  action: { type: QueueAction; item: AgendaQueueItem };
  onClose: () => void;
  onDone: () => void;
  logout: () => void;
}) {
  useEscape(onClose);
  const [externalReference, setExternalReference] = useState("");
  const [externalSystem, setExternalSystem] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [scheduledAt, setScheduledAt] = useState(() => toLocalDateTime(action.item.scheduledAt));
  const [siteId, setSiteId] = useState(action.item.siteId ?? "");
  const [professionalId, setProfessionalId] = useState(action.item.professionalId ?? "");
  const [appointmentTypeId, setAppointmentTypeId] = useState(action.item.appointmentTypeId ?? "");
  const [payerId, setPayerId] = useState(action.item.payerId ?? "");
  const [sites, setSites] = useState<PulsoIrisSite[]>([]);
  const [professionals, setProfessionals] = useState<ProfessionalView[]>([]);
  const [appointmentTypes, setAppointmentTypes] = useState<PulsoIrisAppointmentType[]>([]);
  const [payers, setPayers] = useState<PulsoIrisPayer[]>([]);
  const [alternatives, setAlternatives] = useState<PulsoIrisSlotAlternative[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (action.type !== "reschedule") return;
    let cancelled = false;
    Promise.all([
      api.get<PulsoIrisSite[]>(tenantPath(tenantId, "config/sites")),
      api.get<ProfessionalView[]>(tenantPath(tenantId, "config/professionals")),
      api.get<PulsoIrisAppointmentType[]>(tenantPath(tenantId, "config/appointment-types")),
      api.get<PulsoIrisPayer[]>(tenantPath(tenantId, "config/payers"))
    ])
      .then(([siteRows, professionalRows, typeRows, payerRows]) => {
        if (cancelled) return;
        const activeSites = siteRows.filter((item) => item.status === "active");
        const activeProfessionals = professionalRows.filter((item) => item.status === "active");
        const activeTypes = typeRows.filter((item) => item.status === "active" && item.bookableByIa);
        const activePayers = payerRows.filter((item) => item.status === "active");
        setSites(activeSites);
        setProfessionals(activeProfessionals);
        setAppointmentTypes(activeTypes);
        setPayers(activePayers);
        setSiteId((current) => current || activeSites[0]?.id || "");
        setProfessionalId((current) => current || activeProfessionals[0]?.id || "");
        setAppointmentTypeId((current) => current || activeTypes[0]?.id || "");
      })
      .catch((err) => {
        if (err instanceof SessionExpiredError) logout();
        else setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [action.type, logout, tenantId]);

  const valid =
    action.type === "verify"
      ? externalReference.trim().length > 0 && externalSystem.trim().length > 0
      : action.type === "reschedule"
        ? Boolean(siteId && professionalId && appointmentTypeId && scheduledAt && reason.trim())
        : reason.trim().length > 0;

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    setError(undefined);
    setAlternatives([]);
    try {
      const base = tenantPath(tenantId, `appointments/${action.item.id}`);
      if (action.type === "verify") {
        await api.post(`${base}/manual-verify`, {
          externalReference: externalReference.trim(),
          externalSystem: externalSystem.trim(),
          note: note.trim() || undefined
        });
      } else if (action.type === "reschedule") {
        await api.post(`${base}/reschedule`, {
          siteId,
          professionalId,
          appointmentTypeId,
          payerId: payerId || undefined,
          scheduledAt: new Date(`${scheduledAt}:00-05:00`).toISOString(),
          idempotencyKey: crypto.randomUUID(),
          reason: reason.trim()
        });
      } else if (action.type === "cancelHold") {
        await api.post(tenantPath(tenantId, `appointment-holds/${action.item.id}/cancel`), {
          reason: reason.trim()
        });
      } else {
        await api.post(`${base}/${action.type}`, { reason: reason.trim() });
      }
      onDone();
    } catch (err) {
      if (err instanceof SessionExpiredError) logout();
      else {
        if (err instanceof ApiError && Array.isArray(err.data?.alternatives)) {
          setAlternatives(err.data.alternatives as PulsoIrisSlotAlternative[]);
        }
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="queue-action-title">
        <div className="modal-head">
          <div className="col">
            <h2 id="queue-action-title">{queueActionTitle(action.type)}</h2>
            <span className="small muted">{action.item.patientName ?? "Solicitud de agenda"}</span>
          </div>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">
          {action.type === "verify" ? (
            <>
              <label className="field">
                <span>Referencia externa</span>
                <input
                  className="input"
                  value={externalReference}
                  onChange={(event) => setExternalReference(event.target.value)}
                  autoFocus
                />
              </label>
              <label className="field">
                <span>Sistema origen</span>
                <input
                  className="input"
                  value={externalSystem}
                  onChange={(event) => setExternalSystem(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Nota opcional</span>
                <textarea className="input" rows={3} value={note} onChange={(event) => setNote(event.target.value)} />
              </label>
            </>
          ) : action.type === "reschedule" ? (
            <>
              <label className="field">
                <span>Nuevo horario</span>
                <input
                  className="input"
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(event) => setScheduledAt(event.target.value)}
                />
              </label>
              <div className="settings-grid">
                <label className="field">
                  <span>Sede</span>
                  <select className="select" value={siteId} onChange={(event) => setSiteId(event.target.value)}>
                    {sites.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Profesional</span>
                  <select
                    className="select"
                    value={professionalId}
                    onChange={(event) => setProfessionalId(event.target.value)}
                  >
                    {professionals.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                        {item.isPilot ? " · Piloto" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Tipo de cita</span>
                  <select
                    className="select"
                    value={appointmentTypeId}
                    onChange={(event) => setAppointmentTypeId(event.target.value)}
                  >
                    {appointmentTypes.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Convenio</span>
                  <select className="select" value={payerId} onChange={(event) => setPayerId(event.target.value)}>
                    <option value="">Sin convenio</option>
                    {payers.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {alternatives.length > 0 ? (
                <div className="slot-alternatives">
                  <span className="small">Horarios disponibles</span>
                  <div className="row" style={{ flexWrap: "wrap" }}>
                    {alternatives.map((alternative) => (
                      <button
                        className="btn btn-outline btn-sm"
                        type="button"
                        key={`${alternative.professionalId}-${alternative.startsAt}`}
                        onClick={() => {
                          setSiteId(alternative.siteId);
                          setProfessionalId(alternative.professionalId);
                          setAppointmentTypeId(alternative.appointmentTypeId);
                          setScheduledAt(toLocalDateTime(alternative.startsAt));
                          setAlternatives([]);
                          setError(undefined);
                        }}
                      >
                        <Clock size={14} /> {formatAgendaDateTime(alternative.startsAt)}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <label className="field">
                <span>Motivo de la reagenda</span>
                <textarea
                  className="input"
                  rows={3}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
            </>
          ) : (
            <label className="field">
              <span>Motivo obligatorio</span>
              <textarea
                className="input"
                rows={4}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                autoFocus
              />
            </label>
          )}
          {error ? <div className="banner">{error}</div> : null}
        </div>
        <div className="modal-actions">
          <button className="btn btn-outline" type="button" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" type="button" onClick={() => void submit()} disabled={!valid || saving}>
            {action.type === "verify" ? (
              <CheckCircle2 size={16} />
            ) : action.type === "reschedule" ? (
              <RotateCw size={16} />
            ) : (
              <Ban size={16} />
            )}
            {queueActionTitle(action.type)}
          </button>
        </div>
      </section>
    </div>
  );
}

function queueActionTitle(action: QueueAction): string {
  if (action === "verify") return "Confirmar externamente";
  if (action === "reschedule") return "Reagendar";
  if (action === "reject") return "Rechazar solicitud";
  if (action === "cancelHold") return "Liberar reserva temporal";
  return "Cancelar cita";
}

function formatAgendaDateTime(value: string): string {
  return new Date(value).toLocaleString("es-CO", {
    timeZone: "America/Bogota",
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function toLocalDateTime(value: string | null): string {
  if (!value) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

type ProfessionalView = PulsoIrisProfessional & { isPilot?: boolean };
type AvailabilitySlotView = PulsoIrisAvailabilitySlot & { professionalIsPilot?: boolean };

function AvailabilityPanel({
  tenantId,
  activeSiteId,
  sites,
  canReserve,
  onReserved,
  logout
}: {
  tenantId: string;
  activeSiteId: string | "all";
  sites: PulsoIrisSite[];
  canReserve: boolean;
  onReserved: () => void;
  logout: () => void;
}) {
  const [professionals, setProfessionals] = useState<ProfessionalView[]>([]);
  const [appointmentTypes, setAppointmentTypes] = useState<PulsoIrisAppointmentType[]>([]);
  const [payers, setPayers] = useState<PulsoIrisPayer[]>([]);
  const [siteId, setSiteId] = useState("");
  const [professionalId, setProfessionalId] = useState("");
  const [appointmentTypeId, setAppointmentTypeId] = useState("");
  const [payerId, setPayerId] = useState("");
  const [date, setDate] = useState(() => todayBogotaDate());
  const [slots, setSlots] = useState<AvailabilitySlotView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [alternatives, setAlternatives] = useState<PulsoIrisSlotAlternative[]>([]);
  const [requestSlot, setRequestSlot] = useState<ReservableSlot>();

  useEffect(() => {
    const nextSiteId = activeSiteId === "all" ? (sites[0]?.id ?? "") : activeSiteId;
    if (nextSiteId && siteId !== nextSiteId) {
      setSiteId(nextSiteId);
    }
  }, [activeSiteId, siteId, sites]);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      api.get<ProfessionalView[]>(tenantPath(tenantId, "config/professionals")),
      api.get<PulsoIrisAppointmentType[]>(tenantPath(tenantId, "config/appointment-types")),
      api.get<PulsoIrisPayer[]>(tenantPath(tenantId, "config/payers"))
    ])
      .then(([professionalRows, typeRows, payerRows]) => {
        if (cancelled) return;
        const activeProfessionals = professionalRows.filter((item) => item.status === "active");
        const activeTypes = typeRows.filter((item) => item.status === "active" && item.bookableByIa);
        const activePayers = payerRows.filter((item) => item.status === "active");
        setProfessionals(activeProfessionals);
        setAppointmentTypes(activeTypes);
        setPayers(activePayers);
        setProfessionalId((current) => current || activeProfessionals[0]?.id || "");
        setAppointmentTypeId((current) => current || activeTypes[0]?.id || "");
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof SessionExpiredError) logout();
        else setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [logout, tenantId]);

  const loadSlots = useCallback(() => {
    if (!siteId || !professionalId || !appointmentTypeId) {
      setSlots([]);
      return;
    }

    const from = new Date(`${date}T00:00:00-05:00`);
    const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
    const params = new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
      siteId,
      professionalId,
      appointmentTypeId,
      includeFull: "true"
    });
    if (payerId) params.set("payerId", payerId);

    setLoading(true);
    api
      .get<PulsoIrisAvailabilitySlots>(tenantPath(tenantId, `availability/slots?${params.toString()}`))
      .then((data) => {
        setSlots(data.slots.slice(0, 18) as AvailabilitySlotView[]);
        setError(undefined);
      })
      .catch((err) => {
        if (err instanceof SessionExpiredError) logout();
        else setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }, [appointmentTypeId, date, logout, payerId, professionalId, siteId, tenantId]);

  useEffect(() => loadSlots(), [loadSlots]);

  return (
    <>
      <Card>
        <CardHead
          title="Disponibilidad"
          icon={<CalendarCheck size={18} />}
          trailing={
            <button className="icon-btn" type="button" onClick={loadSlots} aria-label="Actualizar disponibilidad">
              <RefreshCw size={16} />
            </button>
          }
        />
        <div className="card-pad col" style={{ gap: 10, borderBottom: `1px solid ${LINE}` }}>
          <input className="input" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          <select className="select" value={siteId} onChange={(event) => setSiteId(event.target.value)}>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </select>
          <select className="select" value={professionalId} onChange={(event) => setProfessionalId(event.target.value)}>
            {professionals.map((professional) => (
              <option key={professional.id} value={professional.id}>
                {professional.name}
                {professional.isPilot ? " · Piloto" : ""}
              </option>
            ))}
          </select>
          <select
            className="select"
            value={appointmentTypeId}
            onChange={(event) => setAppointmentTypeId(event.target.value)}
          >
            {appointmentTypes.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
          <select className="select" value={payerId} onChange={(event) => setPayerId(event.target.value)}>
            <option value="">Sin convenio</option>
            {payers.map((payer) => (
              <option key={payer.id} value={payer.id}>
                {payer.name}
              </option>
            ))}
          </select>
        </div>
        {loading ? (
          <LoadingState />
        ) : error ? (
          <div className="banner col" style={{ gap: 8 }}>
            <div>{error}</div>
            {alternatives.length > 0 ? (
              <div className="col" style={{ gap: 6 }}>
                <strong className="small">Alternativas disponibles</strong>
                {alternatives.map((alternative) => (
                  <div key={alternative.startsAt} className="row between" style={{ gap: 8 }}>
                    <span className="small">
                      {formatTime(alternative.startsAt)} - {formatTime(alternative.endsAt)}
                      {alternative.professionalName ? ` · ${alternative.professionalName}` : ""}
                    </span>
                    {canReserve ? (
                      <button
                        className="btn btn-outline btn-sm"
                        type="button"
                        onClick={() => setRequestSlot(alternative)}
                      >
                        <Plus size={14} /> Tomar
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : slots.length === 0 ? (
          <EmptyState label="Sin huecos para los filtros" />
        ) : (
          <div>
            {slots.map((slot) => (
              <div
                key={`${slot.ruleId}-${slot.startsAt}`}
                className="row between"
                style={{ padding: "10px 16px", borderBottom: `1px solid ${LINE}`, gap: 10 }}
              >
                <div className="col" style={{ gap: 2 }}>
                  <strong className="small">
                    {formatTime(slot.startsAt)} - {formatTime(slot.endsAt)}
                  </strong>
                  <span className="tiny muted">
                    {slot.professionalName ?? slot.appointmentTypeName ?? "Configuracion incompleta del slot"}
                    {slot.professionalIsPilot ? " · Piloto" : ""}
                  </span>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <Pill tone={slot.remaining > 0 ? "green" : "amber"}>
                    {slot.remaining}/{slot.capacity}
                  </Pill>
                  {canReserve && slot.remaining > 0 ? (
                    <button className="btn btn-outline btn-sm" type="button" onClick={() => setRequestSlot(slot)}>
                      <Plus size={14} /> Reservar
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
      {requestSlot ? (
        <HoldRequestDialog
          tenantId={tenantId}
          slot={requestSlot}
          payerId={payerId || undefined}
          onClose={() => setRequestSlot(undefined)}
          onDone={() => {
            setRequestSlot(undefined);
            setAlternatives([]);
            setError(undefined);
            onReserved();
            loadSlots();
          }}
          onAlternatives={(next, message) => {
            setAlternatives(next);
            setError(message);
          }}
          logout={logout}
        />
      ) : null}
    </>
  );
}

type ReservableSlot = {
  startsAt: string;
  endsAt: string;
  siteId: string;
  professionalId: string;
  appointmentTypeId: string;
  siteName?: string | null;
  professionalName?: string | null;
  appointmentTypeName?: string | null;
  professionalIsPilot?: boolean;
};

function HoldRequestDialog({
  tenantId,
  slot,
  payerId,
  onClose,
  onDone,
  onAlternatives,
  logout
}: {
  tenantId: string;
  slot: ReservableSlot;
  payerId?: string;
  onClose: () => void;
  onDone: () => void;
  onAlternatives: (alternatives: PulsoIrisSlotAlternative[], message: string) => void;
  logout: () => void;
}) {
  useEscape(onClose);
  const [holdId, setHoldId] = useState<string>();
  const [holdKey] = useState(() => crypto.randomUUID());
  const [appointmentKey] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async () => {
    setSaving(true);
    setError(undefined);
    try {
      let currentHoldId = holdId;
      if (!currentHoldId) {
        const result = await api.post<{ id: string }>(tenantPath(tenantId, "appointment-holds"), {
          siteId: slot.siteId,
          professionalId: slot.professionalId,
          appointmentTypeId: slot.appointmentTypeId,
          payerId,
          scheduledAt: slot.startsAt,
          idempotencyKey: holdKey
        });
        currentHoldId = result.id;
        setHoldId(currentHoldId);
      }

      await api.post(tenantPath(tenantId, "appointments"), {
        holdId: currentHoldId,
        idempotencyKey: appointmentKey,
        origin: "advisor"
      });
      onDone();
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        logout();
        return;
      }
      if (err instanceof ApiError) {
        const next = Array.isArray(err.data?.alternatives) ? (err.data.alternatives as PulsoIrisSlotAlternative[]) : [];
        if (next.length > 0) onAlternatives(next, err.message);
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="request-title">
        <div className="modal-head">
          <div className="col">
            <h2 id="request-title">Crear solicitud de cita</h2>
            <span className="small muted">
              {formatAgendaDateTime(slot.startsAt)} · {slot.professionalName ?? slot.appointmentTypeName ?? "Agenda"}
            </span>
          </div>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">
          <div className="request-summary">
            <span className="tiny muted">Sede</span>
            <strong className="small">{slot.siteName ?? "Sede seleccionada"}</strong>
            <span className="tiny muted">Profesional</span>
            <strong className="small">{slot.professionalName ?? "Profesional seleccionado"}</strong>
            {slot.professionalIsPilot ? (
              <>
                <span className="tiny muted">Modalidad</span>
                <strong className="small">Profesional piloto</strong>
              </>
            ) : null}
            <span className="tiny muted">Tipo de cita</span>
            <strong className="small">{slot.appointmentTypeName ?? "Tipo seleccionado"}</strong>
          </div>
          {holdId ? <Pill tone="amber">Cupo reservado temporalmente</Pill> : null}
          {error ? <div className="banner">{error}</div> : null}
        </div>
        <div className="modal-actions">
          <button className="btn btn-outline" type="button" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" type="button" onClick={() => void submit()} disabled={saving}>
            <CalendarCheck size={16} /> Crear solicitud
          </button>
        </div>
      </section>
    </div>
  );
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
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
      title={`${appointment.patientName ?? "Identidad no vinculada"} - ${style.label}`}
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
        <span className="row" style={{ gap: 4 }}>
          {appointment.origin === "sofia_wa" ? (
            <span title="Origen SOFIA WhatsApp" aria-label="Origen SOFIA WhatsApp">
              <MessageCircle size={11} aria-hidden="true" />
            </span>
          ) : null}
          {appointment.professionalIsPilot ? <span className="slot-pilot">Piloto</span> : null}
        </span>
      </div>
      <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {appointment.professionalName ?? appointment.appointmentTypeLabel ?? "Configuracion incompleta"}
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

function todayBogotaDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value ?? "2026";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}
