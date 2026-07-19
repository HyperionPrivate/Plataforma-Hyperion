import { Bot, CalendarClock, MessageCircle, Phone, RefreshCw, Search, Settings2, UserRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Layout } from "../components/Layout.js";
import { Avatar, Card, EmptyState, LoadingState, Pill } from "../components/ui.js";
import { tenantPath, useConsole } from "../lib/context.js";
import { formatDate, formatTime, LINE } from "../lib/format.js";
import { usePolling } from "../lib/hooks.js";

interface InboxItem {
  id: string;
  channel: "voice" | "whatsapp";
  status: string;
  primaryIntent: string | null;
  startedAt: string;
  updatedAt: string;
  patientName: string | null;
  payerName: string | null;
  lastMessage: string | null;
  hasOpenHandoff: boolean;
  provider?: "whatsapp_web_test" | string | null;
  identityStatus?: "identified" | "pending_name" | null;
  sofiaStatus?: "queued" | "processing" | "responded" | "failed" | null;
  lastSofiaActivityAt?: string | null;
}

interface Timeline {
  conversation: {
    id: string;
    channel: "voice" | "whatsapp";
    status: string;
    primaryIntent: string | null;
    startedAt: string;
    siteName: string | null;
    provider?: "whatsapp_web_test" | string | null;
    identityStatus?: "identified" | "pending_name" | null;
    sofiaStatus?: "queued" | "processing" | "responded" | "failed" | null;
    lastSofiaActivityAt?: string | null;
  };
  messages: Array<{
    id: string;
    sender: string;
    body: string;
    createdAt: string;
    provider?: string | null;
    providerMessageId?: string | null;
    deliveryStatus?: "received" | "queued" | "sent" | "delivered" | "read" | "failed" | "ignored" | null;
  }>;
  rpaActions: Array<{ id: string; actionType: string; status: string; durationMs: number | null; createdAt: string }>;
  patient: {
    id: string;
    fullName: string | null;
    documentNumberMasked: string | null;
    phoneMasked: string | null;
    preferredChannel: string | null;
    status: string;
  } | null;
  patientAppointments: Array<{
    id: string;
    scheduledAt: string | null;
    status: string;
    appointmentTypeLabel: string | null;
    professionalName: string | null;
    siteName: string | null;
  }>;
}

const INTENT_LABELS: Record<string, string> = {
  agendar_cita: "Agendar",
  reagendar: "Reagenda",
  cancelar: "Cancelar",
  confirmar_asistencia: "Confirmada",
  consultar_cita: "Consulta cita",
  preparacion_examen: "Preparacion",
  info_convenios: "Convenio",
  info_sedes_horarios: "Sedes"
};

export function ConversationsPage() {
  const { tenant, logout } = useConsole();
  const [searchParams] = useSearchParams();
  const { data, loading, error } = usePolling<InboxItem[]>(
    tenantPath(tenant.id, "conversations/inbox"),
    12_000,
    logout
  );
  const linkedConversationId = searchParams.get("conversationId") ?? undefined;
  const [selectedId, setSelectedId] = useState<string | undefined>(linkedConversationId);
  const [search, setSearch] = useState("");

  const items = useMemo(() => data ?? [], [data]);
  const activeId = selectedId ?? items[0]?.id;

  useEffect(() => {
    if (linkedConversationId) setSelectedId(linkedConversationId);
  }, [linkedConversationId]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return items;
    return items.filter(
      (item) =>
        (item.patientName ?? "").toLowerCase().includes(query) ||
        (item.primaryIntent ?? "").toLowerCase().includes(query)
    );
  }, [items, search]);

  return (
    <Layout title="Conversaciones" subtitle="Bandeja unificada de voz y WhatsApp">
      {error ? (
        <div className="banner">{error}</div>
      ) : !data && loading ? (
        <LoadingState />
      ) : (
        <div
          className="grid conversations-layout"
          style={{ gridTemplateColumns: "320px minmax(0, 1fr) 300px", alignItems: "start", gap: 16 }}
        >
          <Card>
            <div className="card-pad" style={{ paddingBottom: 10 }}>
              <div className="row" style={{ gap: 8 }}>
                <Search size={16} className="muted" />
                <input
                  className="input"
                  placeholder="Buscar por paciente o intencion"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  style={{ border: "none", padding: 4 }}
                />
              </div>
            </div>
            <div style={{ maxHeight: "70vh", overflowY: "auto", borderTop: `1px solid ${LINE}` }}>
              {filtered.length === 0 ? (
                <EmptyState label="Sin conversaciones" />
              ) : (
                filtered.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="nav-item"
                    onClick={() => setSelectedId(item.id)}
                    style={{
                      borderRadius: 0,
                      padding: "12px 16px",
                      borderBottom: `1px solid ${LINE}`,
                      background: item.id === activeId ? "var(--green-soft)" : undefined
                    }}
                  >
                    <Avatar name={item.patientName} />
                    <div className="col" style={{ flex: 1, minWidth: 0 }}>
                      <span className="row between">
                        <strong className="small">
                          {item.patientName ??
                            (item.identityStatus === "pending_name" ? "Identidad pendiente" : "Identidad no vinculada")}
                        </strong>
                        <span className="tiny muted">{formatTime(item.updatedAt)}</span>
                      </span>
                      <span
                        className="tiny muted"
                        style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 200 }}
                      >
                        {item.lastMessage ?? "Sin mensajes"}
                      </span>
                      <span className="row" style={{ gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                        {item.channel === "voice" ? <Phone size={12} /> : <MessageCircle size={12} />}
                        <Pill tone="blue">{providerLabel(item.provider, item.channel)}</Pill>
                        <Pill tone={conversationStatusTone(item.status)}>{conversationStatusLabel(item.status)}</Pill>
                        {item.primaryIntent ? (
                          <Pill tone="green">{INTENT_LABELS[item.primaryIntent] ?? item.primaryIntent}</Pill>
                        ) : null}
                        {item.sofiaStatus ? (
                          <Pill tone={sofiaStatusTone(item.sofiaStatus)}>{sofiaStatusLabel(item.sofiaStatus)}</Pill>
                        ) : null}
                        {item.hasOpenHandoff ? <Pill tone="amber">Handoff</Pill> : null}
                      </span>
                      {item.lastSofiaActivityAt ? (
                        <span className="tiny muted">
                          SOFIA: {formatDate(item.lastSofiaActivityAt)} {formatTime(item.lastSofiaActivityAt)}
                        </span>
                      ) : null}
                    </div>
                  </button>
                ))
              )}
            </div>
          </Card>

          {activeId ? (
            <ConversationDetail tenantId={tenant.id} conversationId={activeId} onExpired={logout} />
          ) : (
            <EmptyState label="Elige una conversacion" />
          )}
        </div>
      )}
    </Layout>
  );
}

function ConversationDetail({
  tenantId,
  conversationId,
  onExpired
}: {
  tenantId: string;
  conversationId: string;
  onExpired: () => void;
}) {
  const timelineState = usePolling<Timeline>(
    tenantPath(tenantId, `conversations/${encodeURIComponent(conversationId)}/timeline`),
    5_000,
    onExpired
  );
  const timeline = timelineState.data?.conversation.id === conversationId ? timelineState.data : undefined;
  const { loading, error, refresh } = timelineState;

  if (loading && !timeline) {
    return (
      <Card>
        <LoadingState />
      </Card>
    );
  }
  if (!timeline) {
    return (
      <Card>
        <div className="banner between">
          <span>{error ?? "No se pudo cargar la conversacion"}</span>
          <button className="btn btn-outline btn-sm" type="button" onClick={refresh}>
            <RefreshCw size={15} /> Reintentar
          </button>
        </div>
      </Card>
    );
  }

  const patient = timeline.patient;
  const latestSofiaMessage = [...timeline.messages].reverse().find((message) => message.sender === "sofia");
  const lastSofiaActivityAt = timeline.conversation.lastSofiaActivityAt ?? latestSofiaMessage?.createdAt;
  const identityStatus = timeline.conversation.identityStatus ?? (patient ? "identified" : "pending_name");

  return (
    <>
      <Card>
        <div className="card-head">
          <Avatar name={patient?.fullName} />
          <div className="col">
            <strong>{patient?.fullName ?? "Identidad pendiente"}</strong>
            <span className="tiny muted">
              {patient?.phoneMasked ?? "Contacto no vinculado"}{" "}
              {timeline.conversation.siteName ? `- ${timeline.conversation.siteName}` : ""}
            </span>
          </div>
          <div className="spacer row" style={{ flexWrap: "wrap", justifyContent: "flex-end" }}>
            <Pill tone={conversationStatusTone(timeline.conversation.status)}>
              {conversationStatusLabel(timeline.conversation.status)}
            </Pill>
            {timeline.conversation.sofiaStatus ? (
              <Pill tone={sofiaStatusTone(timeline.conversation.sofiaStatus)}>
                <Bot size={12} /> {sofiaStatusLabel(timeline.conversation.sofiaStatus)}
              </Pill>
            ) : null}
          </div>
        </div>
        <div className="conversation-facts">
          <ConversationFact
            label="Proveedor"
            value={providerLabel(timeline.conversation.provider, timeline.conversation.channel)}
          />
          <ConversationFact label="Identidad" value={identityStatusLabel(identityStatus)} />
          <ConversationFact
            label="Intencion"
            value={
              timeline.conversation.primaryIntent
                ? (INTENT_LABELS[timeline.conversation.primaryIntent] ?? timeline.conversation.primaryIntent)
                : "Intencion pendiente"
            }
          />
          <ConversationFact
            label="Actividad SOFIA"
            value={
              lastSofiaActivityAt
                ? `${formatDate(lastSofiaActivityAt)} ${formatTime(lastSofiaActivityAt)}`
                : "Sin actividad registrada"
            }
          />
        </div>
        <div
          className="card-pad col"
          style={{ gap: 12, maxHeight: "62vh", overflowY: "auto", background: "var(--surface)" }}
        >
          {timeline.messages.length === 0 ? (
            <EmptyState label="Sin mensajes en esta conversacion" />
          ) : (
            timeline.messages.map((message) => <MessageBubble key={message.id} message={message} />)
          )}
          {timeline.rpaActions.map((action) => (
            <div key={action.id} className="row" style={{ justifyContent: "center" }}>
              <span className="pill">
                <Settings2 size={12} /> RPA {action.actionType} - {action.status}
                {action.durationMs ? ` - ${(action.durationMs / 1000).toFixed(1)} s` : ""}
              </span>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <div className="card-head">
          <UserRound size={18} />
          <h2>Contexto del paciente</h2>
        </div>
        <div className="card-pad col" style={{ gap: 14 }}>
          {patient ? (
            <>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                {patient.documentNumberMasked ? <Pill>{patient.documentNumberMasked}</Pill> : null}
                {patient.preferredChannel ? <Pill tone="green">Prefiere {patient.preferredChannel}</Pill> : null}
                <Pill tone={patient.status === "active" ? "green" : "amber"}>{patient.status}</Pill>
              </div>
              <div className="col" style={{ gap: 8 }}>
                <span className="tiny muted">Citas del paciente</span>
                {timeline.patientAppointments.length === 0 ? (
                  <span className="small muted">Sin citas registradas</span>
                ) : (
                  timeline.patientAppointments.map((appointment) => (
                    <div key={appointment.id} className="row" style={{ gap: 8 }}>
                      <CalendarClock size={15} className="muted" />
                      <div className="col">
                        <span className="small">{appointment.appointmentTypeLabel ?? "Cita"}</span>
                        <span className="tiny muted">
                          {appointment.scheduledAt
                            ? `${formatDate(appointment.scheduledAt)} ${formatTime(appointment.scheduledAt)}`
                            : "Sin fecha"}
                          {appointment.professionalName ? ` - ${appointment.professionalName}` : ""}
                        </span>
                      </div>
                      <div className="spacer">
                        <Pill tone={appointmentTone(appointment.status)}>{appointment.status}</Pill>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          ) : (
            <span className="small muted">Conversacion sin paciente vinculado.</span>
          )}
        </div>
      </Card>
    </>
  );
}

function MessageBubble({ message }: { message: Timeline["messages"][number] }) {
  if (message.sender === "system") {
    return (
      <div className="row" style={{ justifyContent: "center" }}>
        <span className="pill">{message.body}</span>
      </div>
    );
  }
  const isSofia = message.sender === "sofia" || message.sender === "advisor";
  return (
    <div className="row" style={{ justifyContent: isSofia ? "flex-end" : "flex-start" }}>
      <div
        style={{
          maxWidth: "72%",
          padding: "10px 14px",
          borderRadius: 12,
          background: isSofia ? "var(--green-soft)" : "#fff",
          border: `1px solid ${LINE}`
        }}
      >
        <div className="small" style={{ whiteSpace: "pre-wrap" }}>
          {message.body}
        </div>
        <div className="tiny muted" style={{ marginTop: 4, textAlign: "right" }}>
          {message.sender === "sofia" ? "Sofia" : message.sender === "advisor" ? "Asesor" : "Paciente"} -{" "}
          {formatTime(message.createdAt)}
          {message.deliveryStatus ? ` · ${deliveryStatusLabel(message.deliveryStatus)}` : ""}
        </div>
      </div>
    </div>
  );
}

function ConversationFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="conversation-fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function providerLabel(provider: string | null | undefined, channel: "voice" | "whatsapp"): string {
  if (provider === "whatsapp_web_test") return "WhatsApp Web de prueba";
  if (provider) return provider.replaceAll("_", " ");
  return channel === "whatsapp" ? "Proveedor no informado" : "Canal de voz";
}

function identityStatusLabel(status: "identified" | "pending_name" | string): string {
  if (status === "identified") return "Identidad vinculada";
  if (status === "pending_name") return "Nombre pendiente";
  return status.replaceAll("_", " ");
}

function sofiaStatusLabel(status: "queued" | "processing" | "responded" | "failed" | string): string {
  const labels: Record<string, string> = {
    queued: "SOFIA en cola",
    processing: "SOFIA procesando",
    responded: "SOFIA respondio",
    failed: "SOFIA con error"
  };
  return labels[status] ?? status.replaceAll("_", " ");
}

function sofiaStatusTone(status: string): "green" | "red" | "amber" | "blue" {
  if (status === "responded") return "green";
  if (status === "failed") return "red";
  if (status === "processing") return "amber";
  return "blue";
}

function conversationStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    active: "Activa",
    resolved: "Resuelta",
    handoff_required: "Requiere handoff",
    closed: "Cerrada"
  };
  return labels[status] ?? status.replaceAll("_", " ");
}

function conversationStatusTone(status: string): "green" | "red" | "amber" | "blue" {
  if (status === "active") return "green";
  if (status === "handoff_required") return "amber";
  if (status === "closed") return "red";
  return "blue";
}

function deliveryStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    received: "recibido",
    queued: "en cola",
    sent: "enviado",
    delivered: "entregado",
    read: "leido",
    failed: "fallido",
    ignored: "ignorado"
  };
  return labels[status] ?? status.replaceAll("_", " ");
}

function appointmentTone(status: string): "green" | "red" | "amber" | "blue" {
  if (status === "confirmed" || status === "verified") return "green";
  if (status === "no_show" || status === "cancelled") return "red";
  if (status === "rescheduled") return "amber";
  return "blue";
}
