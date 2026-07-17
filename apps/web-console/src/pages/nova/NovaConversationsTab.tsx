import { useEffect, useMemo, useState } from "react";
import { Card, CardHead, EmptyState } from "../../components/ui.js";
import type { ConversationRow } from "./types.js";

export interface ChannelStatus {
  ok?: boolean;
  phone?: string | null;
  handoff_detected?: boolean;
  agency_hint?: string | null;
  handoff_tags?: string[];
  inbox_url?: string;
  mode?: string;
  note?: string;
}

export interface ConversationMessage {
  message_id: string;
  direction: "inbound" | "outbound";
  body: string;
  kind: string;
  created_at?: string;
}

export function NovaConversationsTab({
  conversations,
  onClaim,
  onReply,
  onChannelStatus,
  onLoadMessages
}: {
  conversations: ConversationRow[];
  onClaim: (conversationId: string) => Promise<void>;
  onReply: (conversationId: string, text: string) => Promise<void>;
  onChannelStatus?: (conversationId: string) => Promise<ChannelStatus>;
  onLoadMessages?: (conversationId: string) => Promise<ConversationMessage[]>;
}) {
  const [selectedId, setSelectedId] = useState<string>();
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [channel, setChannel] = useState<"all" | string>("all");
  const [busy, setBusy] = useState(false);
  const [channelStatus, setChannelStatus] = useState<ChannelStatus | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);

  const filtered = useMemo(() => {
    return conversations.filter((row) => {
      if (channel !== "all" && row.channel !== channel) return false;
      if (!query.trim()) return true;
      const hay = `${row.conversation_id} ${row.agency_code ?? ""} ${row.status}`.toLowerCase();
      return hay.includes(query.trim().toLowerCase());
    });
  }, [channel, conversations, query]);

  const selected = filtered.find((row) => row.conversation_id === selectedId) ?? filtered[0] ?? undefined;

  useEffect(() => {
    if (!selected || !onChannelStatus) {
      setChannelStatus(null);
      return;
    }
    let cancelled = false;
    void onChannelStatus(selected.conversation_id)
      .then((status) => {
        if (!cancelled) setChannelStatus(status);
      })
      .catch(() => {
        if (!cancelled) setChannelStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [onChannelStatus, selected?.conversation_id]);

  useEffect(() => {
    if (!selected || !onLoadMessages) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    setMessagesLoading(true);
    void onLoadMessages(selected.conversation_id)
      .then((rows) => {
        if (!cancelled) setMessages(rows);
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      })
      .finally(() => {
        if (!cancelled) setMessagesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onLoadMessages, selected?.conversation_id, selected?.last_message_at]);

  async function claim() {
    if (!selected) return;
    setBusy(true);
    try {
      await onClaim(selected.conversation_id);
      setSelectedId(selected.conversation_id);
    } finally {
      setBusy(false);
    }
  }

  async function reply() {
    if (!selected || !draft.trim()) return;
    setBusy(true);
    try {
      await onReply(selected.conversation_id, draft.trim());
      setDraft("");
      if (onLoadMessages) {
        const rows = await onLoadMessages(selected.conversation_id);
        setMessages(rows);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid" style={{ gridTemplateColumns: "minmax(240px, 320px) 1fr", gap: 16 }}>
      <Card>
        <CardHead title="Bandeja" />
        <div className="col" style={{ gap: 8, marginBottom: 12 }}>
          <input className="input" placeholder="Buscar…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select className="input" value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="all">Todos los canales</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="voice">Voz</option>
          </select>
        </div>
        {filtered.length === 0 ? (
          <EmptyState label="Sin conversaciones. Los webhooks LIWA crearán entradas aquí." />
        ) : (
          <ul
            className="col"
            style={{ gap: 6, listStyle: "none", padding: 0, margin: 0, maxHeight: 480, overflow: "auto" }}
          >
            {filtered.map((conversation) => (
              <li key={conversation.conversation_id}>
                <button
                  type="button"
                  className={`chip${selected?.conversation_id === conversation.conversation_id ? " active" : ""}`}
                  style={{ width: "100%", justifyContent: "flex-start", textAlign: "left" }}
                  onClick={() => setSelectedId(conversation.conversation_id)}
                >
                  {conversation.conversation_id.slice(0, 8)} · {conversation.channel} ·{" "}
                  {conversation.agency_code ?? "—"} · {conversation.status}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHead title="Detalle" />
        {!selected ? (
          <EmptyState label="Selecciona una conversación." />
        ) : (
          <div className="col" style={{ gap: 12 }}>
            <p>
              <strong>{selected.conversation_id}</strong>
            </p>
            <p className="muted tiny">
              Canal {selected.channel} · sede {selected.agency_code ?? "—"} · estado {selected.status}
              {selected.claimed_by ? ` · claimed ${selected.claimed_by.slice(0, 8)}` : ""}
            </p>

            {channelStatus ? (
              <div className="card nested" style={{ padding: 12 }}>
                <p className="tiny" style={{ marginBottom: 6 }}>
                  Canal (webhook-first)
                  {channelStatus.handoff_detected ? (
                    <strong>
                      {" "}
                      · Handoff detectado{channelStatus.agency_hint ? ` · ${channelStatus.agency_hint}` : ""}
                    </strong>
                  ) : (
                    " · sin handoff en cola"
                  )}
                </p>
                {(channelStatus.handoff_tags ?? []).slice(0, 3).map((tag) => (
                  <span key={tag} className="chip" style={{ marginRight: 4 }}>
                    {tag}
                  </span>
                ))}
                {channelStatus.phone ? (
                  <p className="tiny muted" style={{ marginTop: 6 }}>
                    Tel {channelStatus.phone}
                  </p>
                ) : null}
                {channelStatus.inbox_url ? (
                  <p style={{ marginTop: 8 }}>
                    <a href={channelStatus.inbox_url} target="_blank" rel="noreferrer">
                      Abrir inbox LIWA
                    </a>
                  </p>
                ) : null}
                {channelStatus.note ? <p className="tiny muted">{channelStatus.note}</p> : null}
              </div>
            ) : null}

            <div
              className="col"
              style={{
                gap: 8,
                minHeight: 180,
                maxHeight: 320,
                overflow: "auto",
                padding: 12,
                border: "1px solid var(--border, #ddd)",
                borderRadius: 8,
                background: "var(--surface-2, #f7f7f7)"
              }}
            >
              {messagesLoading ? (
                <p className="tiny muted">Cargando mensajes…</p>
              ) : messages.length === 0 ? (
                <EmptyState label="Sin mensajes aún. Webhooks LIWA (documento / handoff / message) aparecen aquí." />
              ) : (
                messages.map((msg) => {
                  const inbound = msg.direction === "inbound";
                  return (
                    <div
                      key={msg.message_id}
                      style={{
                        alignSelf: inbound ? "flex-start" : "flex-end",
                        maxWidth: "85%",
                        padding: "8px 10px",
                        borderRadius: 10,
                        background: inbound ? "#fff" : "var(--accent-soft, #dbeafe)",
                        border: "1px solid var(--border, #e5e5e5)"
                      }}
                    >
                      <p className="tiny muted" style={{ marginBottom: 4 }}>
                        {inbound ? "Contacto" : "Asesor"}
                        {msg.kind !== "text" ? ` · ${msg.kind}` : ""}
                        {msg.created_at ? ` · ${new Date(msg.created_at).toLocaleString()}` : ""}
                      </p>
                      <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{msg.body}</p>
                    </div>
                  );
                })
              )}
            </div>

            <div className="row" style={{ gap: 8 }}>
              <button className="btn" type="button" disabled={busy} onClick={() => void claim()}>
                Claim
              </button>
            </div>
            <label className="col" style={{ gap: 4 }}>
              <span className="tiny muted">Responder (ventana 24h / LIWA)</span>
              <textarea className="input" rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} />
            </label>
            <button
              className="btn btn-primary"
              type="button"
              disabled={busy || !draft.trim()}
              onClick={() => void reply()}
            >
              Enviar reply
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}
